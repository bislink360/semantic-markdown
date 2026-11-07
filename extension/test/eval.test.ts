import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentView } from '../src/core';
import { agreement, cohensKappa, matchItems } from './eval/agreement';
import { main } from './eval/cli';
import { docConditions, renderContext, renderDoc, taskConditions } from './eval/conditions';
import { corpusReader, evidenceFound, loadCorpus, normalise, type Corpus, type CorpusDoc } from './eval/corpus';
import { expandIncludes, lineSimilarity, markupSimilarity, plainBlocks, withoutAgentBlocks, withoutMarkup, withoutSkipMarks } from './eval/markup';
import { headingList, mdRead } from './eval/mdTool';
import {
  normaliseAnswer, packetId, pairedBootstrap, parseAnswers, providerTokens, scoreAnswer, scoreAnswers, seededRandom,
} from './eval/score';
import { alignLines, formatJson, mapCorpus, spanReportText, spansOk } from './eval/spans';
import { survival, survivalText } from './eval/survival';
import type { AnswerRecord, Task } from './eval/types';
import { validateCorpus } from './eval/validate';

const fixture = join(__dirname, 'eval', 'fixture');
const corpus = loadCorpus(fixture);
const doc = (name: string) => corpus.docs.find((d) => d.name === name)!;
const task = (d: CorpusDoc, id: string) => d.tasks.find((t) => t.id === id)!;
const webhooks = doc('webhooks');
const pagination = doc('pagination');
const ctx = renderContext(corpus, webhooks);
const lineCount = (s: string) => s.split(/\r?\n/).length;

/** A copy of the fixture in a temporary folder, changed by `edit`. */
function brokenCopy(edit: (dir: string) => void): Corpus {
  const dir = mkdtempSync(join(tmpdir(), 'smd-eval-'));
  try {
    cpSync(fixture, dir, { recursive: true });
    edit(dir);
    return loadCorpus(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const editJson = (file: string, change: (value: any) => void) => {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  change(value);
  writeFileSync(file, JSON.stringify(value));
};

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

test('the fixture validates, with a similarity number below 1', () => {
  const report = validateCorpus(corpus);
  assert.ok(report.ok, JSON.stringify(report, null, 2));
  assert.deepEqual(report.docs.map((d) => d.doc), ['pagination', 'webhooks']);
  for (const d of report.docs) {
    assert.ok(d.similarity > 0.85 && d.similarity < 1, `${d.doc}: ${d.similarity}`);
    assert.deepEqual(d.errors, []);
  }
});

test('the validator reports broken ids, spans, evidence, references and expected answers', () => {
  const broken = brokenCopy((dir) => {
    editJson(join(dir, 'webhooks', 'annotations.json'), (a) => {
      a.items.push({ ...a.items[0] });
      a.items[1].smd = [500, 501];
      a.items[2].evidence = ['this phrase is nowhere'];
      a.items[3].evidence = [{ regex: '(' }];
      a.items[4].kind = 'rumour';
    });
    editJson(join(dir, 'webhooks', 'tasks.json'), (t) => {
      t.tasks[0].items = ['no-such-item'];
      t.tasks[1].expected.constraint = 'oncall-channel';
      t.tasks[3].expected = { option: ['x'] };
    });
    editJson(join(dir, 'pagination', 'tasks.json'), (t) => { t.tasks[0].id = 'wh-01'; });
  });
  const report = validateCorpus(broken);
  assert.equal(report.ok, false);
  const errors = report.docs.find((d) => d.doc === 'webhooks')!.errors.join('\n');
  assert.match(errors, /item hmac-signing: id used twice/);
  assert.match(errors, /no-body-logs \(smd\): span \[500, 501\] is past the end/);
  assert.match(errors, /https-only: evidence "this phrase is nowhere" is not in doc\.md/);
  assert.match(errors, /retry-limit: evidence \/\(\/i is not a valid regex/);
  assert.match(errors, /no-retry-4xx: kind must be one of/);
  assert.match(errors, /task wh-01: unknown item no-such-item/);
  assert.match(errors, /task wh-02: expected\.constraint oncall-channel is a fact/);
  assert.match(errors, /task wh-04: expected\.superseded must list/);
  assert.match(report.errors.join('\n'), /task wh-01 is in both pagination and webhooks/);
});

test('the validator reports missing files and warns on evidence found outside its span', () => {
  const broken = brokenCopy((dir) => {
    rmSync(join(dir, 'pagination', 'tasks.json'));
    editJson(join(dir, 'webhooks', 'annotations.json'), (a) => { a.items[3].evidence = ['retries']; });
  });
  const report = validateCorpus(broken);
  assert.match(report.errors.join('\n'), /pagination: missing tasks\.json/);
  assert.match(report.docs.find((d) => d.doc === 'webhooks')!.warnings.join('\n'), /retry-limit: evidence "retries" also appears outside the span/);
});

test('similarity is 1 for the same text and lower as lines differ; markup is removed first', () => {
  assert.equal(lineSimilarity('a\n\nb\nc', 'a\nb\nc\n'), 1);
  assert.equal(lineSimilarity('a\nb\nc\nd', 'a\nb'), 2 * 2 / 6);
  const smd = '---\ntitle: T\n---\n\n## Rules {agent=skip}\n\n:::danger Careful\nDo :badge[not]{color=red} [stop]{.x}.\n:::\n';
  assert.equal(withoutMarkup(smd).split('\n').filter(Boolean).join('|'), '## Rules|Careful|Do not stop.');
  assert.equal(markupSimilarity('## Rules\n\nCareful\n\nDo not stop.\n', smd), 1);
});

// ---------------------------------------------------------------------------
// Source rewrites
// ---------------------------------------------------------------------------

test('ablation rewrites keep the number of lines', () => {
  const smd = webhooks.smd;
  for (const rewrite of [withoutSkipMarks, plainBlocks, withoutAgentBlocks]) assert.equal(lineCount(rewrite(smd)), lineCount(smd), rewrite.name);
  assert.match(withoutSkipMarks(smd), /^## Incident history$/m);
  assert.doesNotMatch(plainBlocks(smd), /^:::(agent|decision|danger|question)/m);
  assert.match(plainBlocks(smd), /^:::human Support contacts$/m, ':::human is left for the audience ablation');
  assert.match(plainBlocks(smd), /^Exponential backoff with jitter$/m);
  assert.doesNotMatch(withoutAgentBlocks(smd), /HMAC/);
  assert.equal(withoutSkipMarks('## A {#a agent=skip}\n'), '## A {#a}\n');
  assert.equal(withoutSkipMarks('```\n## A {agent=skip}\n```'), '```\n## A {agent=skip}\n```', 'code is left alone');
});

// ---------------------------------------------------------------------------
// M2 tool
// ---------------------------------------------------------------------------

test('the M2 tool lists headings, reads sections, searches and reads ranges', () => {
  const md = webhooks.md;
  const list = headingList(md, 'doc.md');
  assert.match(list, /^Webhook delivery · file ≈\d+ tokens/);
  assert.match(list, /L14-25\s+## Retries\s+≈\d+/);
  assert.equal(mdRead(md, { file: 'doc.md', mode: 'outline' }), list);
  assert.equal(mdRead(md, { file: 'doc.md' }), md, 'auto: a small file comes back whole');
  assert.equal(mdRead(md, { file: 'doc.md', maxTokens: 10 }), list, 'auto: over the budget, the heading list');
  const section = mdRead(md, { file: 'doc.md', sections: ['retries'], exact: true });
  assert.match(section, /^doc\.md L14-25 \(## Retries\):\n## Retries\n/);
  assert.match(section, /Fixed 60-second interval/);
  assert.doesNotMatch(section, /## Payloads/);
  assert.match(mdRead(md, { file: 'doc.md', sections: ['retries', 'nope'] }), /No section matching: nope/);
  assert.match(mdRead(md, { file: 'doc.md', sections: ['nope'] }), /^Error: No section matching: nope/);
  assert.equal(mdRead(md, { file: 'doc.md', query: '256 kb' }), 'Lines matching "256 kb" (2):\nL30: | Payload size | 256 KB |\nL33: Payloads over 256 KB are dropped, not truncated.\n');
  assert.equal(mdRead(md, { file: 'doc.md', query: 'zebra' }), 'No line matches "zebra".\n');
  assert.equal(mdRead(md, { file: 'doc.md', lines: [16, 16] }), 'doc.md L16-16:\nA failed delivery is retried up to 8 times. Retries are not attempted for 4xx responses, except 429.\n');
  assert.match(mdRead(md, { file: 'doc.md', lines: [10, 999] }), /^Error: lines must be/);
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

test('document conditions show the file, the agent views and the S2 ablations', () => {
  const views = new Map(docConditions(webhooks, ctx).map((r) => [r.condition, r]));
  assert.deepEqual([...views.keys()], ['M1', 'M2-outline', 'S1', 'S2', 'S4-brief', 'S4-budget', 'S2.all-audiences', 'S2.plain-blocks', 'S2.no-agent-block']);
  const full = agentView(webhooks.smd, { readFile: ctx.readFile, today: ctx.today, file: 'doc.smd' });
  assert.equal(views.get('M1')!.text, webhooks.md);
  assert.equal(views.get('S1')!.text, webhooks.smd);
  assert.equal(views.get('S2')!.text, full.text);
  assert.equal(views.get('M1')!.format, 'md');
  assert.equal(views.get('S2')!.format, 'smd');
  assert.equal(views.get('S2')!.tokensEstimate, Math.ceil(full.text.length / 4));
  assert.deepEqual(views.get('S2')!.meta.skippedSections, ['Incident history']);
  assert.equal(views.get('S4-budget')!.meta.maxTokens, Math.floor(full.tokens / 2));
  assert.ok(views.get('S4-budget')!.meta.budget);
  assert.match(views.get('M2-outline')!.text, /^>>> read \{"file":"doc\.md","mode":"outline"\}\n/);
  assert.doesNotMatch(views.get('S2')!.text, /webhooks-oncall|outage lasted/);
  assert.match(views.get('S2.all-audiences')!.text, /webhooks-oncall/);
  assert.match(views.get('S2.all-audiences')!.text, /outage lasted 3 hours/);
  assert.doesNotMatch(views.get('S2.plain-blocks')!.text, /<decision|<danger|<question|<agent-instructions/);
  assert.match(views.get('S2.plain-blocks')!.text, /Fixed 60-second interval/);
  assert.doesNotMatch(views.get('S2.no-agent-block')!.text, /HMAC/);
});

test('task conditions read the sections holding the items; the ablations change only what they name', () => {
  const views = new Map(taskConditions(webhooks, task(webhooks, 'wh-04'), ctx).map((r) => [r.condition, r]));
  assert.deepEqual([...views.keys()], [
    'M2-oracle', 'S3-oracle', 'O', 'S3-oracle.all-audiences', 'S3-oracle.plain-blocks', 'S3-oracle.no-agent-block', 'S3-oracle.no-doc-context',
  ]);
  const s3 = views.get('S3-oracle')!;
  assert.deepEqual(s3.transcript!.calls.map((c) => c.args), [{ file: 'doc.smd', mode: 'outline' }, { file: 'doc.smd', sections: ['retries'], exact: true }]);
  assert.match(s3.transcript!.calls[0].result, /## Incident history\s+≈\d+\s+skipped for agents/);
  assert.match(s3.shown, /Document-wide agent instructions:/);
  assert.doesNotMatch(s3.shown, /^>>> /m, 'shown is the results only');
  assert.match(s3.text, /^>>> read /m);
  assert.equal(views.get('O')!.text, agentView(webhooks.smd, { readFile: ctx.readFile, today: ctx.today, file: 'doc.smd', sections: ['retries'], exactSections: true }).text);
  assert.doesNotMatch(views.get('S3-oracle.no-doc-context')!.shown, /Document-wide agent instructions|HMAC/);
  assert.match(views.get('S3-oracle.no-doc-context')!.shown, /<decision status="superseded"/);
  const m2 = views.get('M2-oracle')!;
  assert.deepEqual(m2.transcript!.calls[1].args, { file: 'doc.md', sections: ['retries'], exact: true });
  assert.equal(m2.format, 'md');
});

test('items above the first heading: the oracle reads the whole view and says so', () => {
  const views = new Map(taskConditions(webhooks, task(webhooks, 'wh-07'), ctx).map((r) => [r.condition, r]));
  const s3 = views.get('S3-oracle')!;
  assert.deepEqual(s3.transcript!.calls[1].args, { file: 'doc.smd', mode: 'full' });
  assert.match(s3.notes.join(' '), /above the first heading/);
  assert.match(views.get('O')!.shown, /HMAC-SHA256/);
  assert.match(views.get('S3-oracle.no-doc-context')!.shown, /HMAC-SHA256/, 'a whole view has no document-wide part to leave out');
});

test('rendering is deterministic', () => {
  const strip = (r: ReturnType<typeof renderDoc>) => JSON.stringify([r.doc, [...r.tasks]]);
  assert.equal(strip(renderDoc(corpus, pagination)), strip(renderDoc(corpus, pagination)));
});

// ---------------------------------------------------------------------------
// Survival check
// ---------------------------------------------------------------------------

test('evidence matching normalises case, marks and whitespace', () => {
  assert.equal(normalise('  Only **HTTPS**\n endpoints `next_cursor` — ok '), 'only https endpoints nextcursor - ok');
  assert.deepEqual(evidenceFound('Retried up\nto 8 times', { evidence: ['retried up to 8 times', { regex: 'to (8|eight)' }, 'nine'] }), [true, true, false]);
});

test('the survival check finds what each condition drops', () => {
  const report = survival(corpus);
  assert.match(report.label, /deterministic projection check.*Not task accuracy/);
  const cell = (condition: string, item: string, taskId?: string) =>
    report.cells.find((c) => c.condition === condition && c.item === item && c.task === taskId)!;
  assert.equal(cell('M1', 'oncall-channel').visible, true);
  assert.equal(cell('S2', 'oncall-channel').visible, false, ':::human is dropped');
  assert.equal(cell('S2', 'outage-duration').visible, false, '{agent=skip} is dropped');
  assert.equal(cell('S2.all-audiences', 'oncall-channel').visible, true);
  assert.equal(cell('S2.no-agent-block', 'hmac-signing').visible, false);
  assert.equal(cell('S3-oracle', 'outage-duration', 'wh-09').visible, true, 'a skipped section shows when it is asked for');
  assert.equal(cell('M2-outline', 'replay-open').found, 0);
  assert.equal(cell('M2-outline', 'replay-open').of, 3);
  const agg = new Map(report.aggregate.map((a) => [a.condition, a]));
  assert.equal(agg.get('M1')!.rate, 1);
  assert.equal(agg.get('S1')!.rate, 1);
  assert.equal(agg.get('S2')!.visible, agg.get('S2')!.total - 2);
  const text = survivalText(report);
  assert.match(text, /^# Evidence survival: a deterministic projection check \(no model\)\. Not task accuracy\./);
  assert.match(text, /## Aggregate per condition/);
});

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

const answer = (t: string, extra: Partial<AnswerRecord>): AnswerRecord => ({ task: t, condition: 'S2', run: 1, answer: '', ...extra });
const score = (d: CorpusDoc, id: string, extra: Partial<AnswerRecord>) => scoreAnswer(d, task(d, id), answer(id, extra));

test('answers are normalised before exact matching', () => {
  assert.equal(normaliseAnswer('The "Eight."'), 'eight');
  assert.equal(normaliseAnswer('1,000 items'), '1000 items');
  assert.equal(normaliseAnswer('**Cursor**  pagination!'), 'cursor pagination');
});

test('fact lookup: normalised exact match', () => {
  assert.equal(score(webhooks, 'wh-01', { answer: 'Up to 8 times.' }).correct, 1);
  assert.equal(score(webhooks, 'wh-01', { answer: { text: 'eight' } }).correct, 1);
  assert.equal(score(webhooks, 'wh-01', { answer: '10' }).correct, 0);
  assert.equal(score(webhooks, 'wh-01', { answer: 'about 8 times or so' }).correct, 0);
});

test('constraint check: verdict and citation by id or overlapping span; a wrong verdict is a violation', () => {
  const byId = score(webhooks, 'wh-02', { answer: { verdict: 'No' }, cited: ['https-only'] });
  assert.deepEqual([byId.correct, byId.verdictCorrect, byId.citedConstraint, byId.violation], [1, true, true, false]);
  assert.equal(score(webhooks, 'wh-02', { answer: { verdict: 'no' }, lines: [[17, 19]] }).correct, 1, 'smd span overlaps L18');
  assert.equal(score(webhooks, 'wh-02', { condition: 'M1', answer: { verdict: 'no' }, lines: [[18, 18]] }).correct, 0, 'md lines for M conditions');
  assert.equal(score(webhooks, 'wh-02', { condition: 'M1', answer: { verdict: 'no' }, lines: [[12, 12]] }).correct, 1);
  const uncited = score(webhooks, 'wh-02', { answer: { verdict: 'no' } });
  assert.deepEqual([uncited.correct, uncited.verdictCorrect, uncited.citedConstraint], [0, true, false]);
  const wrong = score(webhooks, 'wh-02', { answer: { verdict: 'yes' }, cited: ['https-only'] });
  assert.deepEqual([wrong.correct, wrong.violation, wrong.violated], [0, true, ['https-only']]);
  assert.equal(score(pagination, 'pg-05', { answer: { verdict: 'yes, log it' } }).violation, true);
});

test('declared violations are counted for any task type', () => {
  const t: Task = { ...task(webhooks, 'wh-01'), violations: [{ item: 'retry-limit', answers: ['unlimited'] }] } as Task;
  assert.equal(scoreAnswer(webhooks, t, answer('wh-01', { answer: 'Unlimited.' })).violation, true);
  assert.equal(scoreAnswer(webhooks, t, answer('wh-01', { answer: '8' })).violation, false);
});

test('decision status: the expected option, and a superseded choice recorded on its own', () => {
  const right = score(webhooks, 'wh-04', { answer: { option: 'Exponential backoff' } });
  assert.deepEqual([right.correct, right.usedSuperseded], [1, false]);
  const old = score(webhooks, 'wh-04', { answer: 'Fixed 60-second interval' });
  assert.deepEqual([old.correct, old.usedSuperseded], [0, true]);
  assert.equal(score(webhooks, 'wh-01', { answer: '8' }).usedSuperseded, null);
});

test('open question: flagged undecided and the fallback', () => {
  assert.equal(score(webhooks, 'wh-05', { answer: { undecided: true, fallback: 'Only through the API.' } }).correct, 1);
  const unflagged = score(webhooks, 'wh-05', { answer: { undecided: false, fallback: 'only through the API' } });
  assert.deepEqual([unflagged.correct, unflagged.flaggedUndecided, unflagged.fallbackCorrect], [0, false, true]);
  assert.equal(score(webhooks, 'wh-05', { answer: { undecided: true, fallback: 'from the dashboard' } }).correct, 0);
  assert.equal(score(webhooks, 'wh-05', { answer: 'only through the API' }).correct, 0, 'a bare string does not flag the question');
});

test('edit plan: line precision and recall in the format the condition shows', () => {
  const exact = score(webhooks, 'wh-06', { lines: [[22, 22]] });
  assert.deepEqual([exact.correct, exact.precision, exact.recall], [1, 1, 1]);
  const wide = score(webhooks, 'wh-06', { lines: [[20, 23]] });
  assert.deepEqual([wide.correct, wide.precision, wide.recall], [0, 0.25, 1]);
  assert.equal(score(webhooks, 'wh-06', { lines: [[22, 23]] }).correct, 1, 'half the planned lines are expected');
  assert.equal(score(webhooks, 'wh-06', { condition: 'M2', lines: [[16, 16]] }).correct, 1);
  assert.equal(score(webhooks, 'wh-06', { answer: { lines: [[22, 22]] } }).correct, 1, 'lines inside the answer object');
  assert.deepEqual([score(webhooks, 'wh-06', {}).precision, score(webhooks, 'wh-06', {}).recall], [0, 0]);
});

test('qualification: judge packets without the condition, merged back by packet id', () => {
  const records = parseAnswers(readFileSync(join(fixture, 'answers.jsonl'), 'utf8')).records;
  const result = scoreAnswers(corpus, records, { resamples: 200 });
  const pending = result.outcomes.filter((o) => o.type === 'qualification');
  assert.equal(pending.length, 2);
  assert.ok(pending.every((o) => o.correct === null && o.scoredBy === 'pending-judge' && o.packet));
  assert.equal(result.packets.length, 2);
  for (const p of result.packets) {
    assert.doesNotMatch(JSON.stringify(p), /"condition"|"S2"|"M1"/);
    assert.deepEqual(p.items.map((i) => i.id), ['hmac-signing', 'no-body-logs']);
    assert.equal(p.items[0].text, '- Sign every payload with HMAC-SHA256 using the endpoint secret.');
  }
  assert.deepEqual(result.key.map((k) => k.condition).sort(), ['M1', 'S2']);
  const m1 = result.key.find((k) => k.condition === 'M1')!.packet;
  assert.equal(m1, packetId({ condition: 'M1', run: 1, model: 'fixture-model' }, 'webhooks', 'wh-07'));
  const judged = scoreAnswers(corpus, records, { resamples: 200, judged: [{ packet: m1, correct: 1 }] });
  const merged = judged.outcomes.find((o) => o.packet === m1)!;
  assert.deepEqual([merged.correct, merged.scoredBy], [1, 'judge']);
});

test('scoring a file: outcomes, aggregates, separate provider and estimated tokens, problems', () => {
  const text = readFileSync(join(fixture, 'answers.jsonl'), 'utf8') + '{"task":"zz-99","condition":"S2","run":1,"answer":"x"}\nnot json\n';
  const { records, problems } = parseAnswers(text);
  assert.equal(problems.length, 1);
  const result = scoreAnswers(corpus, records, { resamples: 300 });
  assert.match(result.problems.join('\n'), /zz-99: no such task/);
  assert.equal(result.outcomes.length, 19);
  const s = new Map(result.summary.map((c) => [c.condition, c]));
  assert.equal(result.settings.baseline, 'M1');
  assert.equal(s.get('S2')!.vsBaseline!.baseline, 'M1');
  assert.equal(s.get('M1')!.usedSuperseded!.mean, 1);
  assert.equal(s.get('S2')!.usedSuperseded!.mean, 0);
  assert.equal(s.get('M1')!.tokens.providerInputMean, 420);
  assert.equal(s.get('M1')!.tokens.providerAnswers, 1);
  assert.ok(s.get('M1')!.tokens.shownEstimateMean! > 0);
  const first = result.outcomes[0];
  assert.deepEqual([first.providerInputTokens, first.providerOutputTokens], [420, 6]);
  assert.equal(first.shownTokensEstimate, Math.ceil(webhooks.md.length / 4));
  const c = s.get('S2')!.correctness!;
  assert.ok(c.ci[0] <= c.mean && c.mean <= c.ci[1]);
  assert.deepEqual(providerTokens({ prompt_tokens: 5, completion_tokens: 2 }), { input: 5, output: 2 });
  assert.deepEqual(providerTokens(undefined), { input: null, output: null });
});

test('the paired bootstrap is deterministic for a seed', () => {
  const values = new Map([
    ['A', new Map([['d1\u0000t1', 1], ['d1\u0000t2', 0], ['d2\u0000t3', 1], ['d2\u0000t4', 1], ['d3\u0000t5', 0]])],
    ['B', new Map([['d1\u0000t1', 0], ['d1\u0000t2', 0], ['d2\u0000t3', 1], ['d2\u0000t4', 0], ['d3\u0000t5', 0]])],
  ]);
  const run = (seed: number) => JSON.stringify([...pairedBootstrap(values, { seed, resamples: 500, baseline: 'B' })]);
  assert.equal(run(7), run(7));
  assert.notEqual(run(7), run(8));
  const a = pairedBootstrap(values, { seed: 7, resamples: 500, baseline: 'B' }).get('A')!;
  assert.equal(a.estimate.mean, 0.6);
  assert.equal(a.diff!.mean, 0.4);
  assert.ok(a.diff!.ci[0] <= 0.4 && a.diff!.ci[1] >= 0.4);
  const r = seededRandom(3);
  const first = [r(), r(), r()];
  const again = seededRandom(3);
  assert.deepEqual([again(), again(), again()], first);
  assert.ok(first.every((x) => x >= 0 && x < 1));
});

test('the CLI validates, checks, renders and scores into a folder', () => {
  const out = mkdtempSync(join(tmpdir(), 'smd-eval-out-'));
  try {
    let log = '';
    const capture = (s: string) => { log += s; };
    assert.equal(main(['validate', fixture], capture), 0);
    assert.match(log, /OK\n$/);
    assert.equal(main(['check', fixture, '--out', out], capture), 0);
    assert.ok(existsSync(join(out, 'survival.md')));
    assert.equal(main(['render', fixture, '--out', join(out, 'render')], capture), 0);
    const manifest = JSON.parse(readFileSync(join(out, 'render', 'manifest.json'), 'utf8'));
    assert.match(manifest.tokens, /not provider usage/);
    assert.ok(existsSync(join(out, 'render', 'webhooks', 'wh-04', 'S3-oracle.txt')));
    assert.ok(manifest.conditions.every((c: { text?: string }) => c.text === undefined));
    assert.equal(main(['score', fixture, join(fixture, 'answers.jsonl'), '--out', join(out, 'score'), '--resamples', '100'], capture), 0);
    for (const f of ['outcomes.json', 'outcomes.csv', 'summary.json', 'summary.md', 'judge-packets.jsonl', 'judge-key.jsonl']) assert.ok(existsSync(join(out, 'score', f)), f);
    assert.match(readFileSync(join(out, 'score', 'outcomes.csv'), 'utf8'), /^doc,task,type,condition,run,/);
    assert.equal(main(['nope'], capture), 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// map-spans
// ---------------------------------------------------------------------------

/** A copy of the fixture in a temporary folder that stays until `done` is called. */
function fixtureCopy(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'smd-eval-'));
  cpSync(fixture, dir, { recursive: true });
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('map-spans fills the smd spans of items and edit plans from the md spans', () => {
  const { dir, done } = fixtureCopy();
  try {
    const original = JSON.parse(readFileSync(join(dir, 'webhooks', 'annotations.json'), 'utf8'));
    editJson(join(dir, 'webhooks', 'annotations.json'), (a) => {
      for (const item of a.items) delete item.smd;
      a.items[0] = { notes: 'kept', annotator: a.items[0].annotator, evidence: a.items[0].evidence, md: a.items[0].md, kind: a.items[0].kind, id: a.items[0].id };
    });
    editJson(join(dir, 'webhooks', 'tasks.json'), (t) => { delete t.tasks[5].expected.smd; });
    editJson(join(dir, 'pagination', 'annotations.json'), (a) => { for (const item of a.items) item.smd = [1, 1]; });
    assert.equal(validateCorpus(loadCorpus(dir)).ok, false, 'a missing smd span is still an error');
    let log = '';
    assert.equal(main(['map-spans', dir], (s) => { log += s; }), 0);
    assert.match(log, /report only/);
    assert.match(log, /changed: cursor-current smd \[1, 1\] → \[13, 15\]/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'webhooks', 'annotations.json'), 'utf8')).items[3].smd, undefined, 'nothing written without --write');
    assert.equal(main(['map-spans', dir, '--write'], () => {}), 0);
    const text = readFileSync(join(dir, 'webhooks', 'annotations.json'), 'utf8');
    const mapped = JSON.parse(text);
    assert.deepEqual(mapped.items.map((i: { smd: number[] }) => i.smd), original.items.map((i: { smd: number[] }) => i.smd));
    assert.deepEqual(Object.keys(mapped.items[0]), ['id', 'kind', 'md', 'smd', 'evidence', 'annotator', 'notes']);
    assert.match(text, /^\{\n {2}"guide": .*,\n {2}"items": \[\n {4}\{ "id": "hmac-signing", "kind": "constraint", "md": \[7, 7\], "smd": \[12, 12\],/);
    const tasks = JSON.parse(readFileSync(join(dir, 'webhooks', 'tasks.json'), 'utf8'));
    assert.deepEqual(tasks.tasks[5].expected, { md: [[16, 16]], smd: [[22, 22]] });
    assert.ok(validateCorpus(loadCorpus(dir)).ok);
  } finally {
    done();
  }
});

/** A corpus with one document that includes a shared file, written out in doc.md. */
function includeCorpus(items: unknown[]): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'smd-eval-inc-'));
  mkdirSync(join(dir, '_shared'));
  mkdirSync(join(dir, 'doc'));
  writeFileSync(join(dir, '_shared', 'levels.smd'), '---\nsmd: 2\ntitle: Levels\n---\n\nEvery incident gets one level.\n\n:::danger\nNever lower a SEV1 without the commander.\n:::\n');
  writeFileSync(join(dir, 'doc', 'doc.smd'), [
    '---', 'smd: 2', 'title: Runbook', '---', '', '## Severity', '', 'We use the shared levels.', '',
    ':::include{file=../_shared/levels.smd}', ':::', '', 'Scanning stopped for 10 minutes is SEV1.', '',
  ].join('\n'));
  writeFileSync(join(dir, 'doc', 'doc.md'), [
    '# Runbook', '', '## Severity', '', 'We use the shared levels.', '', 'Every incident gets one level.', '',
    'Never lower a SEV1 without the commander.', '', 'Scanning stopped for 10 minutes is SEV1.', '',
  ].join('\n'));
  writeFileSync(join(dir, 'doc', 'annotations.json'), JSON.stringify({ items }));
  writeFileSync(join(dir, 'doc', 'tasks.json'), JSON.stringify({ tasks: [] }));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('map-spans maps included text to its :::include line, and the validator reads the included text there', () => {
  const item = (id: string, md: number[], evidence: string[]) => ({ id, kind: 'constraint', md, evidence, annotator: 'x' });
  const { dir, done } = includeCorpus([
    item('no-lower', [9, 9], ['never lower a SEV1']),
    item('stop-sev1', [11, 11], ['10 minutes is SEV1']),
    item('across', [5, 9], ['shared levels', 'one level']),
    item('blank', [10, 10], ['x']),
    item('wrong', [11, 11], ['one level']),
  ]);
  try {
    const report = mapCorpus(loadCorpus(dir));
    const byId = new Map(report.docs[0].items.map((i) => [i.id, i]));
    assert.deepEqual(byId.get('no-lower')!.smd, [10, 11], 'the :::include block');
    assert.deepEqual(byId.get('no-lower')!.evidenceOutside, []);
    assert.deepEqual(byId.get('stop-sev1')!.smd, [13, 13]);
    assert.deepEqual(byId.get('across')!.smd, [8, 11]);
    assert.equal(byId.get('blank')!.smd, undefined);
    assert.deepEqual(byId.get('wrong')!.evidenceOutside, ['"one level"']);
    const text = spanReportText(report, false);
    assert.match(text, /not mapped: blank md \[10, 10\]/);
    assert.match(text, /evidence outside: wrong md \[11, 11\] → smd \[13, 13\]: "one level"/);
    assert.equal(spansOk(report), false);
    const md = readFileSync(join(dir, 'doc', 'doc.md'), 'utf8');
    const smd = readFileSync(join(dir, 'doc', 'doc.smd'), 'utf8');
    assert.equal(alignLines(md, smd, corpusReader(dir, join(dir, 'doc')))[8], 9, 'md L9 aligns with the include on smd L10');
    assert.equal(alignLines(md, smd)[8], -1, 'without a reader the included text is not there');
    // After writing, the validator accepts the included items and still rejects the wrong one.
    mapCorpus(loadCorpus(dir), true);
    const errors = validateCorpus(loadCorpus(dir)).docs[0].errors.join('\n');
    assert.doesNotMatch(errors, /no-lower|across|stop-sev1/);
    assert.match(errors, /wrong: evidence "one level" is not in doc\.smd L13-13/);
    assert.match(errors, /blank \(smd\): span must be/);
  } finally {
    done();
  }
});

test('include expansion keeps the origin line of every included line', () => {
  const { dir, done } = includeCorpus([]);
  try {
    const smd = readFileSync(join(dir, 'doc', 'doc.smd'), 'utf8');
    const lines = expandIncludes(smd, corpusReader(dir, join(dir, 'doc')));
    assert.ok(lines.some((l) => l.text === 'Never lower a SEV1 without the commander.' && l.origin === 9));
    assert.ok(!lines.some((l) => l.text.startsWith(':::include')));
    assert.equal(lines.find((l) => l.text.startsWith('Scanning'))!.origin, 12);
    assert.ok(expandIncludes(smd, undefined).some((l) => l.text.startsWith(':::include')), 'an include that cannot be read stays');
    assert.equal(formatJson({ a: [1, 2], b: { c: [[1, 2]] } }, 1), '{\n  "a": [1, 2],\n  "b": { "c": [[1, 2]] }\n}\n');
  } finally {
    done();
  }
});

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

test('Cohen\'s kappa, with its degenerate cases', () => {
  const k = cohensKappa([['a', 'a'], ['a', 'b'], ['b', 'b'], ['b', 'b']]);
  assert.equal(k.observed, 0.75);
  assert.equal(k.expected, 0.5);
  assert.equal(k.kappa, 0.5);
  assert.equal(cohensKappa([]).kappa, null);
  const same = cohensKappa([['fact', 'fact'], ['fact', 'fact']]);
  assert.equal(same.kappa, null);
  assert.match(same.note!, /same single kind/);
  assert.equal(cohensKappa([['fact', 'limit'], ['limit', 'fact']]).kappa, -1);
});

test('items match one to one by line overlap, then evidence words', () => {
  const it = (id: string, md: [number, number], evidence: string[], kind = 'fact') => ({ id, kind, md, evidence });
  const pairs = matchItems(
    [it('a1', [10, 12], ['retried up to 8 times']), it('a2', [11, 11], ['except 429']), it('a3', [40, 40], ['nowhere'])],
    [it('b1', [11, 11], ['except 429']), it('b2', [10, 12], ['retried up to 8 times'], 'limit'), it('b3', [11, 11], ['retried'])],
  );
  assert.deepEqual(pairs.map((p) => [p.a, p.b]), [['a1', 'b2'], ['a2', 'b1']]);
  assert.equal(pairs[0].lineJaccard, 1);
  // Same lines both ways: the evidence words decide.
  const tie = matchItems([it('a', [5, 5], ['never log bodies'])], [it('x', [5, 5], ['retry']), it('y', [5, 5], ['never log payload bodies'])]);
  assert.deepEqual(tie.map((p) => p.b), ['y']);
});

test('the agreement command reports F1, kappa and unmatched items per document and pooled', () => {
  const { dir, done } = fixtureCopy();
  try {
    const items = JSON.parse(readFileSync(join(dir, 'webhooks', 'annotations.json'), 'utf8')).items;
    writeFileSync(join(dir, 'webhooks', 'annotations.a1.json'), JSON.stringify({ items: items.slice(0, 6) }));
    const b = items.slice(1, 7).map((i: { id: string; kind: string }) => ({ ...i, id: `b-${i.id}`, kind: i.id === 'https-only' ? 'fact' : i.kind }));
    writeFileSync(join(dir, 'webhooks', 'annotations.a2.json'), JSON.stringify({ items: b }));
    writeFileSync(join(dir, 'pagination', 'annotations.a1.json'), JSON.stringify({ items: [] }));
    const r = agreement(dir, 'annotations.a1.json', 'annotations.a2.json');
    assert.deepEqual(r.skipped, ['pagination']);
    const d = r.docs[0];
    // retry-limit and no-retry-4xx share a line; the evidence words keep them apart.
    assert.deepEqual([d.nA, d.nB, d.matched], [6, 6, 5]);
    assert.ok(d.pairs.some((p) => p.a === 'retry-limit' && p.b === 'b-retry-limit'));
    assert.ok(d.pairs.some((p) => p.a === 'no-retry-4xx' && p.b === 'b-no-retry-4xx'));
    assert.equal(d.f1, 10 / 12);
    assert.ok(d.kappa! > 0 && d.kappa! < 1);
    assert.deepEqual(d.unmatchedA.map((u) => u.id), ['hmac-signing']);
    assert.deepEqual(d.unmatchedB.map((u) => u.id), ['b-fixed-interval-superseded']);
    assert.deepEqual(d.unmatchedA[0].evidence, ['"sign every payload with HMAC-SHA256"']);
    assert.equal(r.pooled.confusion.constraint.fact, 1);
    // An adjudicator's pairs replace the automatic matching for that document.
    const pairsFile = join(dir, 'pairs.json');
    writeFileSync(pairsFile, JSON.stringify({ webhooks: [['retry-limit', 'b-retry-limit'], ['https-only', 'nope']] }));
    const out = join(dir, 'out');
    let log = '';
    assert.equal(main(['agreement', dir, '--a', 'annotations.a1.json', '--b', 'annotations.a2.json', '--pairs', pairsFile, '--out', out], (s) => { log += s; }), 0);
    const saved = JSON.parse(readFileSync(join(out, 'agreement.json'), 'utf8'));
    assert.equal(saved.docs[0].matching, 'pairs');
    assert.equal(saved.docs[0].matched, 1);
    assert.match(saved.docs[0].problems.join('\n'), /no item nope in B/);
    assert.equal(saved.docs[0].kappa, null);
    assert.match(log, /^# Inter-annotator agreement/);
    assert.match(readFileSync(join(out, 'agreement.md'), 'utf8'), /Unmatched in A \(5\):/);
    assert.throws(() => main(['agreement', dir, '--a', 'x.json'], () => {}), /needs --a <file> --b <file>/);
  } finally {
    done();
  }
});
