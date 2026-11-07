import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './eval/cli';
import { loadCorpus } from './eval/corpus';
import {
  judgeAgreement, judgeMessage, JUDGE_SYSTEM_PROMPT, parseJudged, parsePackets, parseVerdict, pickJudge, runJudge, samplePackets, scoringSheet,
} from './eval/judge';
import type { FetchLike, RunConfig, RunDeps } from './eval/runner';
import { scoreAnswers, type JudgePacket } from './eval/score';
import type { AnswerRecord } from './eval/types';

/** The judge tests never touch the network: every request goes to a scripted fake provider. */

const fixture = join(__dirname, 'eval', 'fixture');
const corpus = loadCorpus(fixture);
const KEY = 'judge-key-not-real-91c2';

const config = (extra: Partial<RunConfig> = {}): RunConfig => ({
  models: [{ label: 'judge-a', model: 'provider-judge-1', baseUrl: 'https://api.example.test/v1', apiKeyEnv: 'EVAL_JUDGE_KEY', maxOutputTokens: 200, price: { inputPerMTok: 1, outputPerMTok: 4 } }],
  concurrency: 1, ...extra,
});

/** Qualification answers for wh-07 in several conditions and runs, scored into blinded packets. */
function packets(): JudgePacket[] {
  const answers: AnswerRecord[] = [];
  for (const condition of ['M1', 'S2', 'S3']) {
    for (let run = 1; run <= 4; run++) {
      const text = run % 2 ? 'Payloads are signed with HMAC-SHA256 using the endpoint secret. Bodies are never logged.' : `Payloads are signed.${' More detail.'.repeat(run * 5)}`;
      answers.push({ task: 'wh-07', condition, run, model: 'm:1', answer: { text } });
    }
  }
  return scoreAnswers(corpus, answers, { resamples: 50 }).packets;
}

function provider(reply: (body: any, n: number) => { content?: string; status?: number }): { fetch: FetchLike; sent: any[] } {
  const sent: any[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, headers: init.headers, body });
    const r = reply(body, sent.length - 1);
    if (r.status) return new Response('{"error":"busy"}', { status: r.status });
    return new Response(JSON.stringify({
      id: `j-${sent.length}`, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: r.content ?? '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 300, completion_tokens: 20 },
    }), { status: 200 });
  };
  return { fetch, sent };
}

function deps(fetch: FetchLike): RunDeps & { logged: string[] } {
  const logged: string[] = [];
  return {
    fetch, env: { EVAL_JUDGE_KEY: KEY }, sleep: async () => {}, now: () => new Date('2026-11-07T10:00:00Z'),
    log: (s) => { logged.push(s); }, commit: () => null, logged,
  };
}

const neverFetch: FetchLike = async () => { throw new Error('the network must not be used'); };

/** A reply meeting the criteria whose answer mentions what they ask. */
const fairJudge = (body: any) => {
  const answer = /<answer>\n([\s\S]*)\n<\/answer>/.exec(body.messages[1].content)![1];
  return { content: JSON.stringify({ criteria: { signing: /HMAC/.test(answer), logging: /never logged/.test(answer) }, violation: false, reason: 'checked' }) };
};

test('judge message: question, rubric, passages and answer, and never the condition', () => {
  const [p] = packets();
  const message = judgeMessage(p);
  assert.match(message, /Question: In two sentences/);
  assert.match(message, /- signing: Says every payload is signed/);
  assert.match(message, /<passage id="hmac-signing" kind="constraint">/);
  assert.match(message, /<answer>\n[\s\S]+\n<\/answer>/);
  for (const c of ['M1', 'S2', 'S3', 'condition']) assert.doesNotMatch(message + JUDGE_SYSTEM_PROMPT, new RegExp(`\\b${c}\\b`));
});

test('parseVerdict: share of criteria met, computed here; missing criteria are errors', () => {
  const [p] = packets();
  assert.deepEqual(parseVerdict('```json\n{"criteria": {"signing": true, "logging": false}, "violation": true, "reason": "r"}\n```', p),
    { criteria: { signing: true, logging: false }, correct: 0.5, violation: true, reason: 'r' });
  assert.match((parseVerdict('{"criteria": {"signing": true}, "violation": false}', p) as { error: string }).error, /logging/);
  assert.match((parseVerdict('{"criteria": {"signing": true, "logging": true}}', p) as { error: string }).error, /violation/);
  assert.match((parseVerdict('looks fine to me', p) as { error: string }).error, /no JSON/);
  // A judge's own "correct" is ignored: the share comes from the criteria.
  assert.equal((parseVerdict('{"criteria": {"signing": false, "logging": false}, "violation": false, "correct": 1}', p) as { correct: number }).correct, 0);
});

test('parseJudged: checks values, later lines replace earlier ones', () => {
  assert.deepEqual(parseJudged('{"packet":"a","correct":0}\n\n{"packet":"a","correct":1,"violation":true}\n'), [{ packet: 'a', correct: 1, violation: true }]);
  assert.throws(() => parseJudged('{"packet":"a","correct":2}'), /0 to 1/);
  assert.throws(() => parseJudged('{"packet":"a","correct":"1"}'), /0 to 1/);
  assert.throws(() => parseJudged('{"packet":"a","correct":1,"violation":"no"}'), /true or false/);
  assert.throws(() => parseJudged('{"correct":1}'), /packet/);
});

test('pickJudge: one model, or the one --model names', () => {
  assert.equal(pickJudge(config()).label, 'judge-a');
  const two = config({ models: [...config().models, { ...config().models[0], label: 'judge-b' }] });
  assert.throws(() => pickJudge(two), /--model/);
  assert.equal(pickJudge(two, 'judge-b').label, 'judge-b');
  assert.throws(() => pickJudge(two, 'nope'), /no model nope/);
});

test('runJudge: judges each packet once, writes verdicts score reads back, and resumes', async () => {
  const out = mkdtempSync(join(tmpdir(), 'smd-judge-'));
  try {
    const all = packets();
    const { fetch, sent } = provider(fairJudge);
    const d = deps(fetch);
    const first = await runJudge({ packets: all, config: config(), out, limit: 5 }, d);
    assert.deepEqual([first.judged, first.failed, first.skipped], [5, 0, 0]);
    assert.equal(sent[0].url, 'https://api.example.test/v1/chat/completions');
    assert.equal(sent[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(sent[0].body.max_tokens, 200);
    assert.equal(sent[0].body.tools, undefined);
    assert.equal(sent[0].body.messages[0].content, JUDGE_SYSTEM_PROMPT);
    const second = await runJudge({ packets: all, config: config(), out }, d);
    assert.deepEqual([second.judged, second.skipped], [all.length - 5, 5]);
    assert.equal(sent.length, all.length);

    const rows = readFileSync(join(out, 'judged.jsonl'), 'utf8');
    assert.ok(!rows.includes(KEY));
    const verdicts = parseJudged(rows);
    assert.equal(verdicts.length, all.length);
    // Odd runs meet both criteria, even runs (padded, no HMAC) meet neither.
    assert.deepEqual([...new Set(verdicts.map((v) => v.correct))].sort(), [0, 1]);
    assert.ok(existsSync(join(out, 'judge-transcripts', 'judge-a', `${all[0].packet}.json`)));

    // score takes the verdicts back by packet id, so no answer waits for its judge.
    const answers: AnswerRecord[] = [];
    for (const condition of ['M1', 'S2', 'S3']) for (let run = 1; run <= 4; run++) answers.push({ task: 'wh-07', condition, run, model: 'm:1', answer: { text: 'x' } });
    const scored = scoreAnswers(corpus, answers, { resamples: 50, judged: verdicts });
    assert.ok(scored.outcomes.every((o) => o.scoredBy === 'judge'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('runJudge: a bad reply or an HTTP error is logged and tried again next time', async () => {
  const out = mkdtempSync(join(tmpdir(), 'smd-judge-'));
  try {
    const all = packets().slice(0, 3);
    const { fetch } = provider((body, n) => (n === 0 ? { content: 'no json here' } : n === 1 ? { status: 400 } : fairJudge(body)));
    const s = await runJudge({ packets: all, config: config({ retries: 0 }), out }, deps(fetch));
    assert.deepEqual([s.judged, s.failed], [1, 2]);
    const errors = readFileSync(join(out, 'judge-errors.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(errors.length, 2);
    assert.match(errors[0].error, /no JSON/);
    assert.match(errors[1].error, /HTTP 400/);
    assert.ok(existsSync(join(out, 'judge-transcripts', 'judge-a', `${all[0].packet}.failed.json`)));
    const retry = await runJudge({ packets: all, config: config(), out }, deps(provider(fairJudge).fetch));
    assert.deepEqual([retry.judged, retry.skipped], [2, 1]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('runJudge: dry run sends nothing and reads no key; a missing key stops a real run', async () => {
  const out = mkdtempSync(join(tmpdir(), 'smd-judge-'));
  try {
    const d = { ...deps(neverFetch), env: {} };
    const s = await runJudge({ packets: packets(), config: config(), out, dryRun: true }, d);
    assert.equal(s.dryRun, true);
    const plan = JSON.parse(readFileSync(join(out, 'judge-dry-run', 'plan.json'), 'utf8'));
    assert.equal(plan.requests, 12);
    assert.ok(plan.costEstimate.high > plan.costEstimate.low);
    assert.equal(JSON.parse(readFileSync(join(out, 'judge-dry-run', 'request.json'), 'utf8')).body.messages[0].content, JUDGE_SYSTEM_PROMPT);
    await assert.rejects(runJudge({ packets: packets(), config: config(), out }, d), /EVAL_JUDGE_KEY is not set/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('samplePackets: seeded, stratified by task with --share, plain with --count', () => {
  const all = packets();
  const other = all.map((p, i) => ({ ...p, packet: `x${i}`, task: { ...p.task, id: i < 2 ? 'other' : p.task.id } }));
  const share = samplePackets(other, { share: 0.15, seed: 3 });
  assert.deepEqual(share, samplePackets(other, { share: 0.15, seed: 3 }));
  // ceil(10 × 0.15) = 2 of wh-07, and at least one of the small task.
  assert.equal(share.filter((p) => p.task.id === 'wh-07').length, 2);
  assert.equal(share.filter((p) => p.task.id === 'other').length, 1);
  assert.equal(samplePackets(all, { count: 5, seed: 3 }).length, 5);
  assert.notDeepEqual(samplePackets(all, { count: 5, seed: 3 }).map((p) => p.packet), samplePackets(all, { count: 5, seed: 4 }).map((p) => p.packet));
  assert.throws(() => samplePackets(all, { share: 0.1, count: 2 }), /not both/);
  assert.throws(() => samplePackets(all, { share: 0 }), /above 0/);
  const sheet = scoringSheet(share);
  assert.match(sheet, /# Blind scoring sheet/);
  for (const c of ['M1', 'S2', 'S3']) assert.doesNotMatch(sheet, new RegExp(`\\b${c}\\b`));
});

test('judgeAgreement: kappa, length bias and the tasks to rescore', () => {
  const all = packets();
  const two = all.map((p, i) => ({ ...p, task: { ...p.task, id: i < 6 ? 'calm' : 'contested' } }));
  const judged = two.map((p) => ({ packet: p.packet, correct: 1, violation: false }));
  // People agree on every "calm" answer and fail 2 of 6 "contested" ones (a third, above a fifth).
  const human = two.map((p, i) => ({ packet: p.packet, correct: i === 7 || i === 9 ? 0 : 1, violation: false }));
  const r = judgeAgreement(two, judged, [...human, { packet: 'gone', correct: 1 }]);
  assert.equal(r.n, 12);
  assert.deepEqual(r.unknownPackets, ['gone']);
  assert.deepEqual(r.rescore, ['contested']);
  const contested = r.tasks.find((t) => t.task === 'contested')!;
  assert.deepEqual([contested.n, contested.disagreements, contested.rescore], [6, 2, true]);
  assert.equal(r.correct.pass.observed, 10 / 12);
  assert.ok(r.correct.meanJudgeMinusHuman! > 0);
  assert.ok(r.length.pearson !== null);
  // A judge verdict missing for a human row is reported, not compared.
  assert.deepEqual(judgeAgreement(two, judged.slice(1), human).missingJudge, [two[0].packet]);
});

test('CLI: score → sample → judge → judge-agreement → score with both files', async () => {
  const out = mkdtempSync(join(tmpdir(), 'smd-judge-cli-'));
  const log: string[] = [];
  const say = (s: string) => { log.push(s); };
  try {
    const answers: AnswerRecord[] = [];
    for (const condition of ['M1', 'S2']) for (let run = 1; run <= 5; run++) answers.push({ task: 'wh-07', condition, run, model: 'm:1', answer: { text: run === 1 ? 'Signed with HMAC.' : 'Signed with HMAC-SHA256. Bodies are never logged.' } });
    writeFileSync(join(out, 'answers.jsonl'), answers.map((a) => JSON.stringify(a)).join('\n') + '\n');
    writeFileSync(join(out, 'run.json'), JSON.stringify(config()));
    assert.equal(main(['score', fixture, join(out, 'answers.jsonl'), '--out', join(out, 'score'), '--resamples', '50'], say), 0);
    const packetsFile = join(out, 'score', 'judge-packets.jsonl');
    assert.equal(parsePackets(readFileSync(packetsFile, 'utf8')).length, 10);

    assert.equal(main(['sample', packetsFile, '--out', join(out, 'human'), '--count', '4', '--seed', '2'], say), 0);
    const sampled = parsePackets(readFileSync(join(out, 'human', 'human-packets.jsonl'), 'utf8'));
    assert.equal(sampled.length, 4);
    assert.ok(existsSync(join(out, 'human', 'human-sheet.md')));

    const { fetch } = provider(fairJudge);
    assert.equal(await main(['judge', packetsFile, '--config', join(out, 'run.json'), '--out', join(out, 'judge')], say, deps(fetch)), 0);
    const judgedFile = join(out, 'judge', 'judged.jsonl');

    // People mark every sampled answer as failing: every sampled answer the judge passed is a disagreement.
    writeFileSync(join(out, 'human', 'human.jsonl'), sampled.map((p) => JSON.stringify({ packet: p.packet, correct: 0, violation: false })).join('\n') + '\n');
    assert.equal(main(['judge-agreement', packetsFile, '--judged', judgedFile, '--human', join(out, 'human', 'human.jsonl'), '--out', join(out, 'agree')], say), 0);
    const report = JSON.parse(readFileSync(join(out, 'agree', 'judge-agreement.json'), 'utf8'));
    assert.equal(report.n, 4);
    assert.deepEqual(report.rescore, ['wh-07']);
    assert.equal(parsePackets(readFileSync(join(out, 'agree', 'rescore-packets.jsonl'), 'utf8')).length, 10);

    // Human rescoring after the judge wins.
    assert.equal(main(['score', fixture, join(out, 'answers.jsonl'), '--out', join(out, 'final'), '--resamples', '50', '--judged', `${judgedFile},${join(out, 'human', 'human.jsonl')}`], say), 0);
    const outcomes = JSON.parse(readFileSync(join(out, 'final', 'outcomes.json'), 'utf8')) as Array<{ packet: string; correct: number }>;
    for (const p of sampled) assert.equal(outcomes.find((o) => o.packet === p.packet)!.correct, 0);
    assert.ok(outcomes.every((o) => o.correct !== null));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
