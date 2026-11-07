import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountRun, byTaskCsv, classify, mapUsage, tokenReportText } from './eval/accounting';
import { main } from './eval/cli';
import { loadCorpus } from './eval/corpus';
import { SYSTEM_PROMPT } from './eval/prompts';
import { failedTranscriptPath, MD_READ_TOOL, probeSetup, runEval, SETUP_PROBE_MESSAGE, transcriptPath, type FetchLike, type RunConfig, type RunDeps } from './eval/runner';
import type { Outcome } from './eval/score';

/** Total-token accounting (research/token-accounting.smd). Every request goes to a scripted fake provider. */

const fixture = join(__dirname, 'eval', 'fixture');
const webhooks = loadCorpus(fixture).docs.find((d) => d.name === 'webhooks')!;
const KEY = 'test-key-not-real-91bd2e';

const config = (extra: Partial<RunConfig> = {}): RunConfig => ({
  models: [{ label: 'model-a', model: 'provider-model-1', baseUrl: 'https://api.example.test/v1', apiKeyEnv: 'EVAL_TEST_KEY', maxOutputTokens: 256 }],
  runs: 1, concurrency: 1, retries: 3, ...extra,
});
const model = config().models[0];

interface Reply { content?: string; calls?: Array<{ name?: string; args: unknown }>; status?: number; usage?: unknown }

/** A fake Chat Completions endpoint. Usage: prompt 100 + n, completion 10, 40 of the prompt cached. */
function provider(script: (body: any, n: number) => Reply): { fetch: FetchLike; sent: any[] } {
  const sent: any[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const n = sent.length;
    const r = script(body, n - 1);
    if (r.status) return new Response('{"error": "nope"}', { status: r.status });
    const tool_calls = r.calls?.map((c, i) => ({ id: `call-${n}-${i}`, type: 'function', function: { name: c.name ?? 'read', arguments: JSON.stringify(c.args) } }));
    return new Response(JSON.stringify({
      id: `resp-${n}`, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: r.content ?? null, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }],
      usage: r.usage ?? { prompt_tokens: 100 + n, completion_tokens: 10, total_tokens: 110 + n, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 2 } },
    }), { status: 200 });
  };
  return { fetch, sent };
}

function deps(fetch: FetchLike): RunDeps {
  return { fetch, env: { EVAL_TEST_KEY: KEY }, sleep: async () => {}, now: () => new Date('2026-11-07T10:00:00Z'), log: () => {}, commit: () => ({ commit: 'abc123', dirty: false }) };
}

function withOut(fn: (out: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const out = mkdtempSync(join(tmpdir(), 'smd-eval-tokens-'));
    try { await fn(out); } finally { rmSync(out, { recursive: true, force: true }); }
  };
}

function allText(dir: string): string {
  return readdirSync(dir).map((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? allText(p) : readFileSync(p, 'utf8');
  }).join('\n');
}

const outline = { file: 'doc.md', mode: 'outline' };

test('usage mapping: Chat Completions, input_tokens with separate or included cache fields, and unknown shapes', () => {
  assert.deepEqual(mapUsage({ prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 12 } }), {
    mapping: 'chat-completions', usage: { input: 120, output: 30, cacheRead: 100, cacheWrite: null, reasoning: 12 },
  });
  // Cache reads and writes reported beside input_tokens are added, so input always includes cached input.
  assert.deepEqual(mapUsage({ input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 }).usage,
    { input: 370, output: 5, cacheRead: 300, cacheWrite: 50, reasoning: null });
  // Cached tokens reported inside input_tokens are not added twice.
  assert.deepEqual(mapUsage({ input_tokens: 200, output_tokens: 9, input_tokens_details: { cached_tokens: 150 }, output_tokens_details: { reasoning_tokens: 4 } }).usage,
    { input: 200, output: 9, cacheRead: 150, cacheWrite: null, reasoning: 4 });
  assert.equal(mapUsage({ tokens: 5 }).mapping, 'unknown');
  assert.equal(mapUsage(undefined).usage.input, null);
});

test('call classes: retrieval, repeat read, repair after a tool error, retries and the answer', withOut(async (out) => {
  const p = provider((_body, n) => [
    { calls: [{ args: outline }] },
    { calls: [{ args: { mode: 'outline', file: 'doc.md' } }] }, // the same read, keys in another order
    { calls: [{ name: 'write', args: {} }] }, // an unknown tool: its result is an error
    { status: 429 },
    { calls: [{ args: { file: 'doc.md', sections: ['Retries'], exact: true } }] },
    { content: '{"verdict": "yes", "lines": [[16, 16]]}' },
  ][n]);
  await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-03'], conditions: ['M2'] }, deps(p.fetch));
  const t = JSON.parse(readFileSync(transcriptPath(out, { model, task: webhooks.tasks[2], condition: 'M2', run: 1 }), 'utf8'));
  assert.deepEqual(t.responses[3].failures.map((f: { status: number }) => f.status), [429], 'the failed attempt is kept with the request that followed it');
  const { calls, episode } = classify(t, 'x.json');
  assert.deepEqual(calls.map((c) => c.class), ['retrieval', 'repeat-read', 'retrieval', 'retry', 'repair', 'answer']);
  assert.equal(calls[3].usage, null, 'a retry is logged even though nothing was billed');
  assert.deepEqual([episode.outcome, episode.calls, episode.requests, episode.retries], ['answered', 5, 6, 1]);
  // Requests 1, 2, 3, 5 and 6 of the fake provider answered: prompt 101 + 102 + 103 + 105 + 106, completion 10 each.
  assert.deepEqual(episode.usage, { input: 517, output: 50, cacheRead: 200, cacheWrite: null, reasoning: 10 });
  assert.equal(episode.total, 567);
}));

test('a failed answer keeps what it spent, in its own file, and a retry of the job never overwrites it', withOut(async (out) => {
  const failing = provider((_body, n) => (n === 0 ? { calls: [{ args: outline }] } : { status: 401 }));
  const s1 = await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-03'], conditions: ['M2'] }, deps(failing.fetch));
  assert.equal(s1.failed, 1);
  const job = { model, task: webhooks.tasks[2], condition: 'M2', run: 1 };
  const first = transcriptPath(out, job).replace(/\.json$/, '.failed-1.json');
  assert.ok(existsSync(first));
  const t = JSON.parse(readFileSync(first, 'utf8'));
  assert.equal(t.responses[0].usage.prompt_tokens, 101, 'the request before the failure keeps its usage');
  assert.deepEqual([t.responses[1].failed, t.responses[1].status, t.responses[1].failures.length], [true, 401, 1]);
  assert.equal(t.toolCalls.length, 1);
  const error = JSON.parse(readFileSync(join(out, 'errors.jsonl'), 'utf8').trim());
  assert.deepEqual([error.usage.prompt_tokens, error.usage.requests, error.transcript], [101, 2, 'transcripts/model-a/wh-03/M2/run-1.failed-1.json']);
  assert.equal(failedTranscriptPath(out, job), first.replace('failed-1', 'failed-2'));
  // The second try fails too, then the third answers: both failures stay.
  await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-03'], conditions: ['M2'] }, deps(provider(() => ({ status: 400 })).fetch));
  await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-03'], conditions: ['M2'] }, deps(provider(() => ({ content: '{"verdict": "yes", "lines": [[16, 16]]}' })).fetch));
  assert.ok(existsSync(first) && existsSync(first.replace('failed-1', 'failed-2')) && existsSync(transcriptPath(out, job)));
  const report = accountRun(out);
  const [row] = report.conditions;
  assert.deepEqual([row.answered, row.failed, row.sums.total, row.failedTotal], [1, 2, 111, 111]);
  assert.ok(!allText(out).includes(KEY));
}));

test('the setup probe sends the system prompt, one tool and a one-line message per model and tool definition', withOut(async (out) => {
  const p = provider(() => ({ content: 'OK', usage: { prompt_tokens: 900, completion_tokens: 1 } }));
  const r = await probeSetup({ corpusDir: fixture, config: config(), out, conditions: ['M1', 'M2', 'S2', 'S3'] }, deps(p.fetch));
  assert.deepEqual(r, { probes: 2, failed: 0 });
  assert.deepEqual(p.sent.map((b) => b.messages), [0, 1].map(() => [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: SETUP_PROBE_MESSAGE }]));
  assert.deepEqual(p.sent[0].tools, [MD_READ_TOOL]);
  assert.equal(p.sent[1].tools[0].function.name, 'read');
  assert.notDeepEqual(p.sent[1].tools, [MD_READ_TOOL], 'S conditions get the MCP read definition');
  const rows = readFileSync(join(out, 'setup.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => [x.tool, x.conditions, x.usage.prompt_tokens]), [['md', ['M1', 'M2'], 900], ['smd', ['S2', 'S3'], 900]]);
  assert.ok(!allText(out).includes(KEY));
}));

test('tokens: totals per condition, the baseline difference, setup share and correctness beside, never combined', withOut(async (out) => {
  const p = provider((body) => {
    const tools = body.messages.filter((m: { role: string }) => m.role === 'tool').length;
    if (/Read it with the read tool/.test(String(body.messages[1].content)) && tools === 0) return { calls: [{ args: outline }] };
    return { content: '{"text": "8"}' };
  });
  const corpusRun = { corpusDir: fixture, config: config({ runs: 2 }), out, tasks: ['wh-01', 'wh-08'], conditions: ['M1', 'M2'] };
  await runEval(corpusRun, deps(p.fetch));
  await probeSetup({ ...corpusRun }, deps(provider(() => ({ content: 'OK', usage: { prompt_tokens: 50, completion_tokens: 1 } })).fetch));
  const outcomes: Outcome[] = ['M1', 'M2'].flatMap((condition) => ['wh-01', 'wh-08'].flatMap((task) => ['1', '2'].map((run) => ({
    doc: 'webhooks', task, condition, run, model: 'model-a:provider-model-1', correct: task === 'wh-01' ? 1 : 0,
  } as unknown as Outcome))));
  const report = accountRun(out, { outcomes, resamples: 200 });
  const m1 = report.conditions.find((c) => c.condition === 'M1')!;
  const m2 = report.conditions.find((c) => c.condition === 'M2')!;
  assert.deepEqual([m1.answered, m1.calls, m2.answered, m2.calls], [4, 4, 4, 8]);
  assert.ok(m2.perEpisode.vsBaseline && m2.perEpisode.vsBaseline.baseline === 'M1');
  assert.ok(m2.perEpisode.mean!.mean > m1.perEpisode.mean!.mean, 'two requests cost more than one');
  assert.deepEqual([m1.correctness, m2.correctness], [{ mean: 0.5, n: 4 }, { mean: 0.5, n: 4 }]);
  assert.equal(m2.setup!.perCall, 50);
  assert.ok(m2.setup!.share! > 0 && m2.setup!.share! < 1);
  assert.ok(m2.classShare.retrieval > 0 && Math.abs(m2.classShare.retrieval + m2.classShare.answer - 1) < 1e-9);
  assert.equal(m1.sums.cacheRead, 160);
  assert.equal(m1.sums.uncachedInput, m1.sums.input - 160);
  assert.ok(!('score' in m1), 'no composite of tokens and correctness');
  assert.match(tokenReportText(report), /Total = input \+ output\. Cached input is counted as ordinary input/);
  assert.match(byTaskCsv(report), /^model,condition,doc,task,episodes,mean_total_tokens,mean_correct\nmodel-a:provider-model-1,M1,webhooks,wh-01,2,\d+\.\d,1\.000\n/);
  // The CLI writes the report files beside the run.
  const logged: string[] = [];
  const outcomesFile = join(out, 'outcomes.json');
  writeFileSync(outcomesFile, JSON.stringify(outcomes));
  assert.equal(await main(['tokens', out, '--scored', outcomesFile, '--resamples', '100'], (s) => logged.push(s)), 0);
  for (const f of ['calls.jsonl', 'episodes.jsonl', 'tokens.json', 'tokens.md', 'by-task.csv']) assert.ok(existsSync(join(out, 'tokens', f)), f);
  assert.match(logged.join(''), /## model-a:provider-model-1/);
  const callLines = readFileSync(join(out, 'tokens', 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(callLines.length, 12);
  assert.deepEqual(Object.keys(callLines[0]).slice(0, 9), ['episode', 'model', 'doc', 'task', 'condition', 'run', 'call', 'class', 'usage']);
}));

test('tokens refuses an empty folder and --setup-probe refuses --dry-run', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'smd-eval-tokens-empty-'));
  try {
    assert.equal(await main(['tokens', empty, '--out', join(empty, 'r')], () => {}), 1);
    assert.match(readFileSync(join(empty, 'r', 'tokens.md'), 'utf8'), /no transcripts under/);
    assert.throws(() => main(['run', fixture, '--config', 'x.json', '--out', empty, '--setup-probe', '--dry-run']), /cannot be combined with --dry-run/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
