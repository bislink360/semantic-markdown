import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './eval/cli';
import { renderContext, smdRead } from './eval/conditions';
import { loadCorpus } from './eval/corpus';
import { mdRead } from './eval/mdTool';
import { ANSWER_FORMATS, extractJson, parseAnswer, SYSTEM_PROMPT } from './eval/prompts';
import {
  backoff, checkArgs, checkConfig, Conditions, INERT_RESULT, MD_READ_TOOL, redact, RUN_CONDITIONS, runEval, transcriptPath, type FetchLike, type RunConfig, type RunDeps,
} from './eval/runner';
import { parseAnswers, scoreAnswers } from './eval/score';

/** The runner tests never touch the network: every request goes to a scripted fake provider. */

const fixture = join(__dirname, 'eval', 'fixture');
const corpus = loadCorpus(fixture);
const webhooks = corpus.docs.find((d) => d.name === 'webhooks')!;
const KEY = 'test-key-not-real-7f3a9c';

const config = (extra: Partial<RunConfig> = {}): RunConfig => ({
  models: [{ label: 'model-a', model: 'provider-model-1', baseUrl: 'https://api.example.test/v1/', apiKeyEnv: 'EVAL_TEST_KEY', maxOutputTokens: 256, sendSeed: true, price: { inputPerMTok: 1, outputPerMTok: 4 } }],
  runs: 1, seed: 7, concurrency: 1, ...extra,
});

interface Reply { content?: string; calls?: Array<{ name?: string; args: unknown }>; status?: number; body?: string; headers?: Record<string, string> }
interface Sent { url: string; headers: Record<string, string>; body: any }

/** A fake Chat Completions endpoint: `script` gets each request body and the number of requests before it. */
function provider(script: (body: any, n: number) => Reply): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, headers: init.headers, body });
    const r = script(body, sent.length - 1);
    if (r.status) return new Response(r.body ?? '{}', { status: r.status, headers: r.headers });
    const tool_calls = r.calls?.map((c, i) => ({ id: `call-${sent.length}-${i}`, type: 'function', function: { name: c.name ?? 'read', arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } }));
    const message = { role: 'assistant', content: r.content ?? null, ...(tool_calls ? { tool_calls } : {}) };
    return new Response(JSON.stringify({
      id: `resp-${sent.length}`, object: 'chat.completion', model: body.model, created: 1700000000, system_fingerprint: 'fp-test',
      choices: [{ index: 0, message, finish_reason: tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100 + sent.length, completion_tokens: 10, total_tokens: 110 + sent.length, prompt_tokens_details: { cached_tokens: 5 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, sent };
}

function deps(fetch: FetchLike, extra: Partial<RunDeps> = {}): RunDeps & { logged: string[]; slept: number[] } {
  const logged: string[] = [];
  const slept: number[] = [];
  return {
    fetch, env: { EVAL_TEST_KEY: KEY }, sleep: async (ms) => { slept.push(ms); }, now: () => new Date('2026-11-06T10:00:00Z'),
    log: (s) => { logged.push(s); }, commit: () => ({ commit: 'abc123', dirty: false }), logged, slept, ...extra,
  };
}

const neverFetch: FetchLike = async () => { throw new Error('the network must not be used'); };

function withOut(fn: (out: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const out = mkdtempSync(join(tmpdir(), 'smd-eval-run-'));
    try { await fn(out); } finally { rmSync(out, { recursive: true, force: true }); }
  };
}

const answers = (out: string) => parseAnswers(readFileSync(join(out, 'answers.jsonl'), 'utf8')).records;

/** Every file under a folder, as text. */
function allText(dir: string): string {
  return readdirSync(dir).map((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? allText(p) : readFileSync(p, 'utf8');
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

test('answers are read from fenced or bare JSON, with trailing text, for every task type', () => {
  assert.deepEqual(parseAnswer('{"text": "8"}'), { answer: { text: '8' } });
  assert.deepEqual(parseAnswer('Looking at L16.\n```json\n{"text": "8 times", "lines": [[16, 16]]}\n```\nDone.'), { answer: { text: '8 times' }, lines: [[16, 16]] });
  assert.deepEqual(parseAnswer('{"verdict": "no", "lines": [18, 18]} because of the HTTPS rule {see above}'), { answer: { verdict: 'no' }, lines: [[18, 18]] });
  assert.deepEqual(parseAnswer('{"option": "Exponential backoff with jitter"}'), { answer: { option: 'Exponential backoff with jitter' } });
  assert.deepEqual(parseAnswer('{"undecided": "true", "fallback": "only through the API"}'), { answer: { undecided: true, fallback: 'only through the API' } });
  assert.deepEqual(parseAnswer('{"lines": [[22, 22], 30]}'), { answer: {}, lines: [[22, 22], [30, 30]] });
  assert.deepEqual(parseAnswer('{"answer": 8, "cited": ["x", 3]}'), { answer: { text: '8' }, cited: ['x'] });
  assert.deepEqual(parseAnswer('The format is {"text": "..."}. My answer: {"text": "eight"}'), { answer: { text: 'eight' } }, 'the last object');
  assert.deepEqual(parseAnswer('a stray { brace, then {"text": "x", "n": {"y": 1}}'), { answer: { text: 'x' } });
  assert.deepEqual(parseAnswer('It is retried 8 times.'), { answer: 'It is retried 8 times.', error: 'parse' });
  assert.deepEqual(parseAnswer('  '), { answer: '', error: 'empty' });
  assert.equal(extractJson('no json here'), undefined);
  for (const type of Object.keys(ANSWER_FORMATS)) assert.match(ANSWER_FORMATS[type as keyof typeof ANSWER_FORMATS], /^Answer with \{/);
});

test('the config is checked: no secrets, no temperature, only runnable conditions', () => {
  assert.ok(checkConfig(config()));
  assert.throws(() => checkConfig({ models: [{ ...config().models[0], apiKey: 'x' } as never] }), /looks like a secret/);
  assert.throws(() => checkConfig({ models: [{ ...config().models[0], extraBody: { temperature: 0 } }] }), /may not set "temperature"/);
  assert.throws(() => checkConfig({ ...config(), conditions: ['S3-oracle'] }), /offline render/);
  assert.throws(() => checkConfig({ ...config(), conditions: ['S5'] }), /unknown condition S5/);
  assert.throws(() => checkConfig({ models: [] }), /at least one model/);
  assert.throws(() => checkConfig({ models: [config().models[0], config().models[0]] }), /used twice/);
  assert.equal(redact(`Bearer ${KEY} and ${KEY}`, KEY), 'Bearer [redacted] and [redacted]');
  assert.deepEqual([backoff(0, null), backoff(3, null), backoff(9, null), backoff(0, '2')], [1000, 8000, 32000, 2000]);
});

test('every condition gets one tool named read; whole-text conditions get the navigating one of their format, inert', () => {
  const conds = new Conditions(corpus);
  const task = webhooks.tasks[0];
  const setups = new Map(RUN_CONDITIONS.map((c) => [c, conds.setup(webhooks, task, c)]));
  for (const s of setups.values()) assert.equal(s.tool.function.name, 'read');
  assert.deepEqual(setups.get('M1')!.tool, setups.get('M2')!.tool);
  assert.deepEqual(setups.get('M1')!.tool, MD_READ_TOOL);
  for (const c of ['S1', 'S2', 'S4-brief', 'S4-budget', 'O', 'S2.plain-blocks', 'S3.no-agent-block']) assert.deepEqual(setups.get(c)!.tool, setups.get('S3')!.tool, c);
  assert.match(setups.get('S3')!.tool.function.description, /^Agent view of a \.smd file/);
  assert.deepEqual(Object.keys(setups.get('S3')!.tool.function.parameters.properties as object), ['file', 'sections', 'exact', 'mode', 'maxTokens', 'brief']);
  assert.equal(setups.get('S2')!.execute({ file: 'doc.smd', mode: 'full' }), INERT_RESULT);
  assert.match(setups.get('M1')!.user, /<document>\n# Webhook delivery\n/);
  assert.doesNotMatch(setups.get('M2')!.user, /<document>/);
  assert.match(setups.get('S3')!.user, /^The document is the file doc\.smd\. Read it with the read tool\./);
  assert.equal(checkArgs(MD_READ_TOOL.function.parameters, { file: 'doc.md', nope: 1 }), 'unknown argument "nope"');
  assert.equal(checkArgs(MD_READ_TOOL.function.parameters, { file: 'doc.md', sections: [1] }), '"sections" must be an array of string');
  assert.equal(checkArgs(MD_READ_TOOL.function.parameters, { mode: 'outline' }), 'missing "file"');
  assert.equal(checkArgs(MD_READ_TOOL.function.parameters, { file: 'doc.md', mode: 'all' }), '"mode" must be one of auto, outline, full');
  assert.throws(() => conds.setup(webhooks, task, 'M2-oracle'), /offline render/);
});

// ---------------------------------------------------------------------------
// Runs against the fake provider
// ---------------------------------------------------------------------------

test('a whole-text condition: the request shape, the record and a transcript without the key', withOut(async (out) => {
  const p = provider(() => ({ content: 'Here you go:\n```json\n{"text": "8", "lines": [[16, 16]]}\n```' }));
  const d = deps(p.fetch);
  const summary = await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-01'], conditions: ['M1'] }, d);
  assert.deepEqual([summary.answered, summary.failed], [1, 0]);
  assert.equal(p.sent.length, 1);
  const [req] = p.sent;
  assert.equal(req.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(req.body).sort(), ['max_tokens', 'messages', 'model', 'seed', 'tools']);
  assert.equal(req.body.model, 'provider-model-1');
  assert.equal(req.body.max_tokens, 256);
  assert.equal(req.body.seed, 7001);
  assert.equal(req.body.temperature, undefined);
  assert.deepEqual(req.body.messages.map((m: { role: string }) => m.role), ['system', 'user']);
  assert.equal(req.body.messages[0].content, SYSTEM_PROMPT);
  assert.ok(req.body.messages[1].content.includes(webhooks.md.trimEnd()));
  assert.match(req.body.messages[1].content, /Task: How many times is a failed delivery retried\?\n\nAnswer with \{"text"/);
  assert.equal(req.body.tools.length, 1);
  const [r] = answers(out);
  assert.deepEqual(r, {
    task: 'wh-01', doc: 'webhooks', condition: 'M1', run: 1, seed: 7001, model: 'model-a:provider-model-1', answer: { text: '8' }, lines: [[16, 16]],
    usage: { prompt_tokens: 101, completion_tokens: 10, total_tokens: 111, 'prompt_tokens_details.cached_tokens': 5, requests: 1 }, toolCalls: 0,
  });
  const t = JSON.parse(readFileSync(transcriptPath(out, { model: config().models[0], task: webhooks.tasks[0], condition: 'M1', run: 1 }), 'utf8'));
  assert.equal(t.messages.length, 3);
  assert.equal(t.responses[0].system_fingerprint, 'fp-test');
  assert.equal(t.responses[0].finish_reason, 'stop');
  assert.equal(t.usage.prompt_tokens, 101);
  const manifest = JSON.parse(readFileSync(join(out, 'run-manifest.json'), 'utf8'));
  assert.equal(manifest.systemPrompt, SYSTEM_PROMPT);
  assert.deepEqual(manifest.invocations[0].tool, { commit: 'abc123', dirty: false });
  assert.equal(manifest.invocations[0].counts.answered, 1);
  assert.match(manifest.invocations[0].extensionVersion, /^\d+\.\d+\.\d+/);
  const everything = allText(out);
  assert.ok(!everything.includes(KEY), 'the key is written nowhere');
  assert.doesNotMatch(everything, /authorization|Bearer/i);
  assert.ok(!d.logged.join('').includes(KEY));
}));

test('M2: the model reads with the Markdown tool until it answers; every call is recorded', withOut(async (out) => {
  const p = provider((_body, n) => [
    { calls: [{ args: { file: 'doc.md', mode: 'outline' } }] },
    { calls: [{ args: { file: 'doc.md', sections: ['Retries'], exact: true } }, { args: { file: 'other.md' } }] },
    { content: '{"verdict": "yes", "lines": [[16, 16]]}' },
  ][n]);
  await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-03'], conditions: ['M2'] }, deps(p.fetch));
  assert.equal(p.sent.length, 3);
  const second = p.sent[1].body.messages;
  assert.equal(second[2].role, 'assistant');
  assert.equal(second[2].tool_calls[0].function.name, 'read');
  assert.equal(second[3].role, 'tool');
  assert.equal(second[3].tool_call_id, 'call-1-0');
  assert.equal(second[3].content, mdRead(webhooks.md, { file: 'doc.md', mode: 'outline' }));
  const third = p.sent[2].body.messages;
  assert.equal(third[5].content, mdRead(webhooks.md, { file: 'doc.md', sections: ['Retries'], exact: true }));
  assert.equal(third[6].content, 'Error: Not found: other.md');
  const [r] = answers(out);
  assert.deepEqual([r.answer, r.lines, r.toolCalls], [{ verdict: 'yes' }, [[16, 16]], 3]);
  assert.equal(r.usage!.prompt_tokens, 101 + 102 + 103, 'usage summed over the requests');
  assert.equal(r.usage!.requests, 3);
  const t = JSON.parse(readFileSync(transcriptPath(out, { model: config().models[0], task: webhooks.tasks[2], condition: 'M2', run: 1 }), 'utf8'));
  assert.deepEqual(t.toolCalls.map((c: { arguments: unknown; executed: boolean }) => [c.arguments, c.executed]), [
    [{ file: 'doc.md', mode: 'outline' }, true], [{ file: 'doc.md', sections: ['Retries'], exact: true }, true], [{ file: 'other.md' }, true],
  ]);
  assert.equal(t.responses.length, 3);
}));

test('S3 and its ablations: the tool is the MCP read, on the ablated source', withOut(async (out) => {
  const ctx = renderContext(corpus, webhooks);
  const p = provider((body, n) => {
    const tools = body.messages.filter((m: { role: string }) => m.role === 'tool').length;
    if (tools === 0) return { calls: [{ args: { file: 'doc.smd', sections: ['retries'], exact: true } }] };
    if (tools === 1) return { calls: [{ args: { file: 'doc.smd', sections: ['nothing here'] } }, { args: '{not json' }, { name: 'write', args: {} }] };
    return { content: `{"option": "Exponential backoff with jitter"} (request ${n})` };
  });
  await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-04'], conditions: ['S3', 'S3.no-doc-context', 'S3.all-audiences'] }, deps(p.fetch));
  const rs = answers(out);
  assert.deepEqual(rs.map((r) => r.condition), ['S3', 'S3.no-doc-context', 'S3.all-audiences']);
  assert.ok(rs.every((r) => (r.answer as { option: string }).option === 'Exponential backoff with jitter' && r.toolCalls === 4));
  const toolResults = (condition: string) => {
    const t = JSON.parse(readFileSync(transcriptPath(out, { model: config().models[0], task: webhooks.tasks[3], condition, run: 1 }), 'utf8'));
    return t.toolCalls.map((c: { result: string }) => c.result);
  };
  const s3 = toolResults('S3');
  assert.equal(s3[0], smdRead(webhooks.smd, { sections: ['retries'], exact: true }, ctx));
  assert.match(s3[0], /Document-wide agent instructions:/);
  assert.match(s3[0], /<decision status="accepted"/);
  assert.equal(s3[1], 'Error: No section matching: nothing here. Call "read" with mode "outline" to list the sections.');
  assert.equal(s3[2], 'Error: the arguments are not valid JSON.');
  assert.equal(s3[3], 'Error: unknown tool write. The only tool is read.');
  assert.doesNotMatch(toolResults('S3.no-doc-context')[0], /Document-wide agent instructions|HMAC/);
  assert.match(toolResults('S3.no-doc-context')[0], /<decision status="superseded"/);
  assert.equal(toolResults('S3.all-audiences')[0], toolResults('S3')[0]);
}));

test('a model that keeps calling the tool is stopped at the limit and recorded', withOut(async (out) => {
  const p = provider(() => ({ calls: [{ args: { file: 'doc.md', query: 'retry' } }] }));
  await runEval({ corpusDir: fixture, config: config({ maxToolCalls: 2 }), out, tasks: ['wh-01'], conditions: ['M2'] }, deps(p.fetch));
  assert.equal(p.sent.length, 4);
  assert.match(p.sent[3].body.messages.at(-1).content, /^Error: the tool call limit \(2\) is reached/);
  const [r] = answers(out);
  assert.deepEqual([r.error, r.answer, r.toolCalls], ['tool-limit', '', 4]);
}));

test('a parse failure is recorded as an answer with the raw text', withOut(async (out) => {
  const p = provider(() => ({ content: 'Eight times, I think.' }));
  await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-01'], conditions: ['S2'] }, deps(p.fetch));
  const [r] = answers(out);
  assert.deepEqual([r.answer, r.error], ['Eight times, I think.', 'parse']);
}));

test('the run resumes: answers already in answers.jsonl are skipped', withOut(async (out) => {
  const p = provider(() => ({ content: '{"text": "8"}' }));
  const options = { corpusDir: fixture, config: config({ runs: 2 }), out, tasks: ['wh-01'], conditions: ['M1', 'S2'] };
  const first = await runEval({ ...options, limit: 3 }, deps(p.fetch));
  assert.deepEqual([first.planned, first.answered], [4, 3]);
  const second = await runEval(options, deps(p.fetch));
  assert.deepEqual([second.skipped, second.answered], [3, 1]);
  assert.equal(p.sent.length, 4);
  const third = await runEval(options, deps(neverFetch));
  assert.deepEqual([third.skipped, third.attempted], [4, 0]);
  assert.deepEqual(answers(out).map((r) => `${r.condition}/${r.run}`), ['M1/1', 'S2/1', 'M1/2', 'S2/2']);
  assert.equal(JSON.parse(readFileSync(join(out, 'run-manifest.json'), 'utf8')).invocations.length, 3);
}));

test('the dry run sends nothing, needs no key, and writes the plan and request bodies', withOut(async (out) => {
  const d = deps(neverFetch, { env: {} });
  const summary = await runEval({ corpusDir: fixture, config: config(), out, dryRun: true, docs: ['webhooks'] }, d);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.planned, webhooks.tasks.length * RUN_CONDITIONS.length);
  const log = d.logged.join('');
  assert.match(log, /^Dry run: nothing is sent and no key is read\./);
  assert.match(log, /estimates \(≈ characters \/ 4\)/);
  assert.match(log, /\| M1 \| 10 \| \d+ \| \$0\.\d+ – \$0\.\d+ \|/);
  assert.match(log, /\| M2 \| 10 \| ≥ \d+ \| ≥ \$0\.\d+ \(lower bound\) \|/);
  assert.ok(!existsSync(join(out, 'answers.jsonl')));
  const plan = JSON.parse(readFileSync(join(out, 'dry-run', 'plan.json'), 'utf8'));
  assert.equal(plan.rows.length, RUN_CONDITIONS.length);
  const body = JSON.parse(readFileSync(join(out, 'dry-run', 'model-a', 'S3.wh-01.run-1.json'), 'utf8'));
  assert.equal(body.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(body.body.tools[0].function.name, 'read');
  assert.doesNotMatch(allText(out), /Bearer|authorization"/i);
}));

test('a missing key is a clear error before anything is sent', withOut(async (out) => {
  const d = deps(neverFetch, { env: {} });
  await assert.rejects(runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-01'], conditions: ['M1'] }, d), /model model-a: the environment variable EVAL_TEST_KEY is not set/);
  assert.ok(!existsSync(join(out, 'answers.jsonl')));
}));

test('429 and 5xx are retried with backoff; other errors fail the answer without leaking the key', withOut(async (out) => {
  const p = provider((_body, n) => (n === 0 ? { status: 429, headers: { 'retry-after': '3' } } : n === 1 ? { status: 503 } : { content: '{"text": "8"}' }));
  const d = deps(p.fetch);
  const ok = await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-01'], conditions: ['M1'] }, d);
  assert.equal(ok.answered, 1);
  assert.deepEqual(d.slept, [3000, 2000]);
  const t = JSON.parse(readFileSync(transcriptPath(out, { model: config().models[0], task: webhooks.tasks[0], condition: 'M1', run: 1 }), 'utf8'));
  assert.equal(t.responses[0].attempts, 3);
  const bad = provider(() => ({ status: 401, body: `{"error": "invalid key ${KEY}"}` }));
  const d2 = deps(bad.fetch);
  const failed = await runEval({ corpusDir: fixture, config: config(), out, tasks: ['wh-02'], conditions: ['M1'] }, d2);
  assert.deepEqual([failed.failed, bad.sent.length, d2.slept.length], [1, 1, 0]);
  const errors = readFileSync(join(out, 'errors.jsonl'), 'utf8');
  assert.match(errors, /HTTP 401: \{\\"error\\": \\"invalid key \[redacted\]\\"\}/);
  assert.ok(!allText(out).includes(KEY));
  assert.equal(answers(out).length, 1, 'a failed answer is not written, so a later run tries it again');
  const down = provider(() => { throw new Error('ECONNRESET'); });
  const d3 = deps(down.fetch);
  const net = await runEval({ corpusDir: fixture, config: config({ retries: 2 }), out, tasks: ['wh-03'], conditions: ['M1'] }, d3);
  assert.deepEqual([net.failed, down.sent.length, d3.slept], [1, 3, [1000, 2000]]);
}));

test('the run\'s answers are scored by the scorer', withOut(async (out) => {
  const right: Record<string, string> = {
    'wh-01': '{"text": "8"}', 'wh-02': '{"verdict": "no", "lines": [[18, 18]]}', 'wh-04': '{"option": "Exponential backoff with jitter"}',
    'wh-05': '{"undecided": true, "fallback": "only through the API"}', 'wh-06': '{"lines": [[22, 22]]}', 'wh-07': '{"text": "Payloads are signed and never logged."}',
  };
  const p = provider((body) => {
    const id = Object.keys(right).find((k) => body.messages[1].content.includes(webhooks.tasks.find((t) => t.id === k)!.prompt))!;
    return { content: right[id] };
  });
  await runEval({ corpusDir: fixture, config: config(), out, tasks: Object.keys(right), conditions: ['S2'] }, deps(p.fetch));
  const result = scoreAnswers(corpus, answers(out), { resamples: 50 });
  assert.deepEqual(result.problems, []);
  const auto = result.outcomes.filter((o) => o.scoredBy === 'auto');
  assert.equal(auto.length, 5);
  assert.ok(auto.every((o) => o.correct === 1), JSON.stringify(auto.filter((o) => o.correct !== 1)));
  assert.ok(result.outcomes.every((o) => o.providerInputTokens! > 100 && o.providerOutputTokens === 10), 'provider usage reaches the scorer');
  assert.equal(result.packets.length, 1);
  // The CLI scores it too, one model at a time.
  const scored = join(out, 'scored');
  assert.equal(main(['score', fixture, join(out, 'answers.jsonl'), '--out', scored, '--resamples', '50', '--model', 'model-a'], () => {}), 0);
  assert.equal(JSON.parse(readFileSync(join(scored, 'outcomes.json'), 'utf8')).length, 6);
  assert.equal(main(['score', fixture, join(out, 'answers.jsonl'), '--out', scored, '--resamples', '50', '--model', 'model-b'], () => {}), 0);
  assert.equal(JSON.parse(readFileSync(join(scored, 'outcomes.json'), 'utf8')).length, 0);
}));

test('the CLI runs a dry run from a config file', withOut(async (out) => {
  const file = join(out, 'run.json');
  writeFileSync(file, JSON.stringify(config()));
  const logged: string[] = [];
  const code = await main(['run', fixture, '--config', file, '--out', join(out, 'r'), '--dry-run', '--tasks', 'wh-01,wh-02', '--conditions', 'M1,S3'], (s) => { logged.push(s); }, { fetch: neverFetch, env: {} });
  assert.equal(code, 0);
  assert.match(logged.join(''), /4 request\(s\) to make/);
  assert.throws(() => main(['run', fixture, '--out', out], () => {}), /run needs --config/);
}));
