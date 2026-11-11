import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocument } from '../src/readView';
import { main } from './eval/cli';
import { matchSection, outlineUse, outlineUseOf, outlineUseText, parseOutline } from './eval/outlineUse';

/** Study 1 "Outline cost use": what S3 agents read after an outline, against the costs it showed. */

const para = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} of filler text that makes this section cost more tokens.`).join(' ');
const DOC = [
  '---', 'smd: 2', 'title: Rollout plan', '---', '',
  '## Overview', para(4), '',
  '## Phase 2 rollout', para(60), '',
  '## Rollback', para(12), '',
  '### Rollback checks', para(2), '',
  '## History', para(120), '',
].join('\n');
const OUTLINE = readDocument(DOC, { mode: 'outline' }).text;

const transcript = (calls: Array<{ args: unknown; result: string }>, assistant: string[] = [], condition = 'S3') => ({
  model: { label: 'model-a' }, doc: 'plan', task: 't1', condition, run: 1,
  messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'q' }, ...assistant.map((content) => ({ role: 'assistant', content }))],
  toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: 'read', arguments: c.args, result: c.result, executed: true })),
});

test('parseOutline reads the section rows of a real outline, with levels, lines and costs', () => {
  const rows = parseOutline(OUTLINE);
  assert.ok(rows, OUTLINE);
  assert.deepEqual(rows.map((r) => [r.heading, r.level]), [['Overview', 2], ['Phase 2 rollout', 2], ['Rollback', 2], ['Rollback checks', 3], ['History', 2]]);
  for (const r of rows) assert.ok(r.cost > 0 && r.lines[0] <= r.lines[1], JSON.stringify(r));
  const cost = (h: string) => rows.find((r) => r.heading === h)!.cost;
  assert.ok(cost('History') > cost('Phase 2 rollout') && cost('Phase 2 rollout') > cost('Overview'));
});

test('parseOutline returns null for a section read', () => {
  assert.equal(parseOutline(readDocument(DOC, { sections: ['Overview'] }).text), null);
});

test('matchSection takes an exact title first, then the only title that contains the request', () => {
  const rows = parseOutline(OUTLINE)!;
  assert.equal(matchSection(rows, 'rollback')?.heading, 'Rollback');
  assert.equal(matchSection(rows, '## History')?.heading, 'History');
  assert.equal(matchSection(rows, 'checks')?.heading, 'Rollback checks');
  assert.equal(matchSection(rows, 'roll'), null, 'two titles contain it');
  assert.equal(matchSection(rows, 'checks', true), null, 'exact asks for the whole title');
  assert.equal(matchSection(rows, 'Pricing'), null);
});

test('outlineUseOf logs each section read after an outline with its cost and rank', () => {
  const rows = parseOutline(OUTLINE)!;
  const ep = outlineUseOf(transcript([
    { args: { file: 'plan.smd', sections: ['Overview'] }, result: 'before any outline' },
    { args: { file: 'plan.smd' }, result: OUTLINE },
    { args: { file: 'plan.smd', sections: ['Overview', 'History', 'Pricing'], maxTokens: 500 }, result: 'section text' },
    { args: { file: 'plan.smd', mode: 'full' }, result: 'whole view' },
  ], ['I will read the cheapest section first, it costs ≈40 tokens.']), 'transcripts/model-a/t1/S3/run-1.json')!;
  assert.equal(ep.outlines, 1);
  assert.equal(ep.choices.length, 3, 'the read before the outline is not a choice from it');
  const [overview, history, pricing] = ep.choices;
  assert.equal(overview.heading, 'Overview');
  assert.equal(overview.cost, rows.find((r) => r.heading === 'Overview')!.cost);
  assert.equal(overview.of, 5);
  assert.equal(history.cheaper, 4);
  assert.equal(history.percentile, 1);
  assert.equal(pricing.heading, null);
  assert.equal(pricing.percentile, null);
  assert.equal(ep.budgetArgs, 1);
  assert.equal(ep.fullReads, 1);
  assert.equal(ep.mentionsCost, true);
  assert.equal(ep.failed, false);
});

test('outlineUseOf skips conditions without a costed outline and keeps S3 ablations', () => {
  assert.equal(outlineUseOf(transcript([], [], 'M2'), 'x.json'), null);
  assert.equal(outlineUseOf(transcript([], [], 'S2'), 'x.json'), null);
  assert.equal(outlineUseOf(transcript([], [], 'S3.no-agent'), 'x.json')?.condition, 'S3.no-agent');
  assert.equal(outlineUseOf(transcript([], ['The answer is 42.']), 'x.json')?.mentionsCost, false);
});

test('outlineUse summarizes answered episodes per model and condition, and the CLI writes the report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'outline-use-'));
  try {
    const put = (rel: string, t: unknown) => {
      const file = join(dir, 'transcripts', ...rel.split('/'));
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify(t));
    };
    put('model-a/t1/S3/run-1.json', transcript([{ args: { file: 'plan.smd' }, result: OUTLINE }, { args: { file: 'plan.smd', sections: ['Overview'] }, result: 's' }]));
    put('model-a/t2/S3/run-1.json', transcript([{ args: { file: 'plan.smd' }, result: OUTLINE }, { args: { file: 'plan.smd', sections: ['History'] }, result: 's' }]));
    put('model-a/t3/S3/run-1.failed-1.json', transcript([{ args: { file: 'plan.smd' }, result: OUTLINE }]));
    put('model-a/t1/M2/run-1.json', transcript([], [], 'M2'));

    const r = outlineUse(dir);
    assert.equal(r.episodes.length, 3, 'M2 is left out, the failed S3 episode is logged');
    assert.equal(r.summary.length, 1);
    const s = r.summary[0];
    assert.equal(s.episodes, 2, 'the summary counts answered episodes only');
    assert.equal(s.withOutline, 2);
    assert.equal(s.matched, 2);
    assert.equal(s.medianPercentile, 0.625, 'Overview has one cheaper section of five (0.25), History four (1)');
    assert.equal(s.cheaperHalf, 0.5);
    assert.match(outlineUseText(r), /\| model-a \| S3 \| 2 \| 2 \| 2 \| 2 \| 0\.63 \| 50\.0% \|/);

    const logs: string[] = [];
    assert.equal(await main(['outline-use', dir], (s) => logs.push(s)), 0);
    assert.match(logs.join(''), /# Outline cost use/);
    assert.match(readFileSync(join(dir, 'outline-use', 'outline-use.md'), 'utf8'), /# Outline cost use/);
    assert.equal(readFileSync(join(dir, 'outline-use', 'episodes.jsonl'), 'utf8').trim().split('\n').length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outlineUse reports a folder without S3 transcripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'outline-use-'));
  try {
    const r = outlineUse(dir);
    assert.equal(r.episodes.length, 0);
    assert.match(r.problems.join('\n'), /no S3 transcripts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
