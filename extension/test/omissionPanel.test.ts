import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentView } from '../src/core';
import { briefOnlyItems, omissionItems, omissionSummary } from '../src/omissionPanel';

/** C10: the editor's list of what the agent view leaves out, built from the provenance manifest. */

const SAMPLES = join(__dirname, 'samples');
const reader = (p: string) => { try { return readFileSync(join(SAMPLES, p), 'utf8'); } catch { return undefined; } };
const manifest = (text: string, brief = false, readFile?: (p: string) => string | undefined) =>
  agentView(text, { provenance: true, brief, file: 'doc.smd', readFile }).provenance!;

const doc = [
  '# Doc', '', 'Text.', '',
  ':::human For reviewers', 'HIDDEN', ':::', '',
  '## History {agent=skip}', '', 'Old.', '',
  '## Plan', '', '- [x] Done one', '- [x] Done two', '- [ ] Open', '',
  ':::include{file="parts/missing.smd"}', ':::', '',
].join('\n');

test('C10: one item per omission, with its lines, reason and where to go', () => {
  const items = omissionItems(manifest(doc));
  const human = items.find((i) => i.label.includes(':::human'))!;
  assert.equal(human.label, '$(person) :::human block');
  assert.equal(human.description, 'L5–L7');
  assert.match(human.detail, /^A :::human block is for people/);
  assert.deepEqual([human.start, human.end, human.own, human.file], [4, 6, true, 'doc.smd']);
  const skipped = items.find((i) => i.label.includes('skipped'))!;
  assert.equal(skipped.label, '$(eye-closed) Section skipped for agents: History');
  assert.match(skipped.detail, /Shown by: smd agent doc\.smd --section "History"/);
  const include = items.find((i) => i.label.includes('Include'))!;
  assert.equal(include.description, 'L19');
  assert.match(include.detail, /parts\/missing\.smd was not shown/);
  assert.doesNotMatch(JSON.stringify(items), /HIDDEN|For reviewers/, 'the list never shows hidden text');
});

test('C10: the brief view adds its own condensations, listed apart', () => {
  const full = manifest(doc);
  const brief = manifest(doc, true);
  const extra = briefOnlyItems(full, brief);
  assert.deepEqual(extra.map((i) => i.label), ['$(tasklist) Completed tasks counted']);
  assert.equal(extra[0].description, 'L15–L16 · 2 tasks');
});

test('C10: items in included files name the file, and the summary counts by kind', () => {
  const root = '# Root\n\n:::include{file="part.smd"}\n:::\n';
  const items = omissionItems(manifest(root, false, (p) => (p === 'part.smd' ? '## Part\n\n<!-- note -->\nText.\n' : undefined)));
  assert.equal(items.length, 1);
  assert.equal(items[0].own, false);
  assert.equal(items[0].description, 'part.smd L3');
  assert.equal(omissionSummary(manifest(doc)),
    'Left out: 1 × :::human block, 1 × section skipped for agents, 1 × include not shown. See "What the Agent View Leaves Out…" for each one and why.');
  assert.equal(omissionSummary(manifest('# Clean\n\nNothing hidden.\n')), '');
});

test('C10: every sample gives a list whose lines are inside its file', () => {
  for (const f of ['showcase.smd', 'checkout-redesign.smd', 'feature-spec.smd']) {
    const text = readFileSync(join(SAMPLES, f), 'utf8');
    const lines = text.split('\n').length;
    for (const brief of [false, true]) {
      for (const item of omissionItems(manifest(text, brief, reader))) {
        if (item.own) assert.ok(item.start >= 0 && item.end < lines && item.start <= item.end, `${f} ${item.label} ${item.description}`);
      }
    }
  }
});
