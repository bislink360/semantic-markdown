import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, renderSmd, validateSmd } from '../src/core';
import { documentIdIndex } from '../src/core/includedIds';

/**
 * Ids that included content gives (improvement roadmap t-15 and t-59): validation and reads resolve them as rendering
 * shows the document, through one index (includedIds.ts), and an include's fallback text gives no ids once the file
 * is read.
 */

const FILES: Record<string, string> = {
  'inc.smd': [
    '---', 'smd: 2', '---', '',
    '## Included part', '',
    ':::requirement{#RI} Included requirement', 'RI_BODY', ':::', '',
    '[Target]{#inc-span} in included text.', '',
    ':::figure{#fig-inc} A chart', '![A chart](c.png)', ':::', '',
    ':::include{file="inner.smd"}', ':::', '',
    '## Second part', '',
    ':::requirement{#RS} Outside a section include', 'RS_BODY', ':::', '',
  ].join('\n'),
  'inner.smd': ['---', 'smd: 2', '---', '', ':::requirement{#RN} Nested requirement', 'RN_BODY', ':::', ''].join('\n'),
  'dup.smd': ['---', 'smd: 2', '---', '', ':::requirement{#R1} Same id as the document', 'DUP_BODY', ':::', ''].join('\n'),
  'fallback.smd': ['---', 'smd: 2', '---', '', 'Read from the file.', ''].join('\n'),
  'fig-span.smd': ['---', 'smd: 2', '---', '', '[A span]{#shared}', ''].join('\n'),
  'fig-figure.smd': ['---', 'smd: 2', '---', '', ':::figure{#shared} The figure', '![x](x.png)', ':::', ''].join('\n'),
};
const readFile = (p: string) => FILES[p];
const codes = (doc: string, read: ((p: string) => string | undefined) | undefined = readFile) =>
  validateSmd(doc, { readFile: read }).map((d) => d.code);

const doc = (...body: string[]) => ['---', 'smd: 2', 'title: Plan', '---', '', ...body, ''].join('\n');

const PLAN = doc(
  '## Work', '',
  ':::include{file="inc.smd"}', ':::', '',
  '## Rules', '',
  ':::constraint{#C3 applies-to=RI} Rule on an included block', 'C3_BODY', ':::', '',
  ':::constraint{#C4 applies-to=RN} Rule on a nested included block', 'C4_BODY', ':::', '',
  '## Other', '', 'Other text.',
);

test('t-59: a rule whose applies-to names an included block is carried by a read that shows the block, from another section', () => {
  const r = agentView(PLAN, { sections: ['Work'], readFile, file: 'plan.smd' });
  assert.deepEqual(r.mandatory?.constraints.map((c) => [c.id, c.applies]), [['C3', 'applies-to'], ['C4', 'applies-to']]);
  assert.deepEqual(r.mandatory?.unsatisfied, []);
  assert.equal(r.mandatory?.complete, true);
  assert.match(r.text, /Constraints that apply here:[\s\S]*C3_BODY[\s\S]*C4_BODY[\s\S]*## Work/);
  // A read that doesn't show the included block doesn't carry the rule, and adds no "Not satisfied" entry.
  const other = agentView(PLAN, { sections: ['Other'], readFile, file: 'plan.smd' });
  assert.deepEqual(other.mandatory?.constraints ?? [], []);
  assert.doesNotMatch(other.text, /C3_BODY|Not satisfied/);
});

test('t-59: validation stops reporting ref/unknown for an included target, and still reports it when the include cannot be read', () => {
  assert.ok(!codes(PLAN).includes('ref/unknown'));
  const unread = validateSmd(PLAN, { readFile: () => undefined }).filter((d) => d.code === 'ref/unknown');
  assert.deepEqual(unread.map((d) => /"(R\w+)"/.exec(d.message)?.[1]), ['RI', 'RN']);
  // Without the file the read keeps the safe path: the rule is unplaced and the view is incomplete.
  const r = agentView(PLAN, { sections: ['Work'], readFile: () => undefined, file: 'plan.smd' });
  assert.deepEqual(r.mandatory?.constraints.map((c) => [c.id, c.applies]), [['C3', 'unplaced'], ['C4', 'unplaced']]);
  assert.equal(r.mandatory?.complete, false);
});

test('t-59: a section include gives only the ids of its section', () => {
  const text = doc(
    '## Work', '', ':::include{file="inc.smd" section="Included part"}', ':::', '',
    '## Rules', '',
    ':::constraint{#C5 applies-to=RI} On the included section', 'C5_BODY', ':::', '',
    ':::constraint{#C6 applies-to=RS} On a part the include leaves out', 'C6_BODY', ':::',
  );
  const r = agentView(text, { sections: ['Work'], readFile, file: 'plan.smd' });
  assert.deepEqual(r.mandatory?.constraints.map((c) => [c.id, c.applies]), [['C5', 'applies-to'], ['C6', 'unplaced']]);
  assert.deepEqual(r.mandatory?.unsatisfied.map((u) => [u.kind, u.target]), [['unresolved-target', 'RS']]);
  assert.deepEqual(validateSmd(text, { readFile }).filter((d) => d.code === 'ref/unknown').map((d) => /"(R\w+)"/.exec(d.message)?.[1]), ['RS']);
});

test('t-59: an id the document and an included file both give is ambiguous, in the read and in validation', () => {
  const text = doc(
    '## Work', '', ':::requirement{#R1} The document\'s own', 'OWN_BODY', ':::', '',
    ':::include{file="dup.smd"}', ':::', '',
    '## Rules', '', ':::constraint{#C7 applies-to=R1} Names a duplicate', 'C7_BODY', ':::',
  );
  const r = agentView(text, { sections: ['Rules'], readFile, file: 'plan.smd' });
  assert.deepEqual(r.mandatory?.unsatisfied.map((u) => [u.kind, u.target]), [['unresolved-target', 'R1']]);
  assert.match(r.mandatory!.unsatisfied[0].reason, /several blocks give this id/);
  const ambiguous = validateSmd(text, { readFile }).filter((d) => d.code === 'ref/ambiguous');
  assert.equal(ambiguous.length, 1);
  assert.match(ambiguous[0].message, /lines 8 and 5 of dup\.smd/);
});

test('t-59: a depends-on that names an included block resolves too, so the read adds it from another section', () => {
  const text = doc(
    '## Work', '', ':::include{file="inc.smd"}', ':::', '',
    '## Other', '', ':::requirement{#R0 depends-on=RI} Needs the included one', 'R0_BODY', ':::',
  );
  const r = agentView(text, { sections: ['Other'], readFile, file: 'plan.smd' });
  assert.deepEqual(r.mandatory?.dependencies.map((d) => [d.id, d.file]), [['RI', 'inc.smd']]);
  assert.equal(r.mandatory?.complete, true);
  assert.match(r.text, /Dependencies of the selected content:[\s\S]*RI_BODY/);
  assert.ok(!codes(text).includes('ref/unknown'));
});

test('t-15: links to ids in included text, including figures, are not missing anchors', () => {
  const text = doc('## Work', '', ':::include{file="inc.smd"}', ':::', '', 'See [the span](#inc-span), [the figure](#fig-inc) and [nested](#RN).');
  assert.deepEqual(codes(text), []);
  // The renderer links them the same way.
  const html = renderSmd(text, { readFile }).html;
  for (const id of ['inc-span', 'fig-inc', 'RN']) assert.match(html, new RegExp(`id="${id}"`));
});

test('t-15: :ref to an included span or requirement agrees with what the renderer links', () => {
  const text = doc('## Work', '', ':::include{file="inc.smd"}', ':::', '', 'See :ref[inc-span], :ref[RI] and :ref[fig-inc].');
  assert.deepEqual(codes(text), []);
  const html = renderSmd(text, { readFile }).html;
  assert.match(html, /<a class="smd-ref" href="#inc-span"/);
  assert.match(html, /<a class="smd-ref" href="#RI"/);
  // An id included text doesn't give is still unknown, to both.
  const missing = doc('## Work', '', ':::include{file="inc.smd"}', ':::', '', 'See :ref[nowhere].');
  assert.deepEqual(codes(missing), ['figure/unknown-ref']);
  assert.match(renderSmd(missing, { readFile }).html, /smd-ref-missing/);
});

test('t-15: a figure an include brings in comes before another block with the same id, as rendering resolves it', () => {
  const text = doc('## Work', '', ':::include{file="fig-span.smd"}', ':::', '', ':::include{file="fig-figure.smd"}', ':::', '', 'See :ref[shared].');
  assert.deepEqual(codes(text).filter((c) => c !== 'id/duplicate'), []);
  assert.match(renderSmd(text, { readFile }).html, /<a class="smd-ref" href="#shared">Figure 1</);
});

test('t-15: fallback ids stop resolving once an include is read, and still resolve when it cannot be read', () => {
  const text = doc(
    '## Work', '',
    ':::include{file="fallback.smd"}', '[Fallback]{#fb-id} text for old renderers.', ':::', '',
    'See [it](#fb-id) and :ref[fb-id].', '',
    ':::constraint{#C8 scope=section applies-to=fb-id} On fallback text', 'C8_BODY', ':::',
  );
  const read = validateSmd(text, { readFile }).map((d) => d.code).sort();
  assert.deepEqual(read, ['figure/unknown-ref', 'link/missing-anchor', 'ref/unknown']);
  const unread = validateSmd(text, { readFile: () => undefined }).map((d) => d.code);
  assert.ok(!unread.includes('link/missing-anchor') && !unread.includes('figure/unknown-ref') && !unread.includes('ref/unknown'), unread.join());
  // The rendered document agrees: no element gives the id once the file is read.
  assert.doesNotMatch(renderSmd(text, { readFile }).html, /id="fb-id"/);
  assert.match(renderSmd(text, { readFile: () => undefined }).html, /id="fb-id"/);
  assert.deepEqual(documentIdIndex(text, readFile).fallback, [[8, 8]]);
});

test('t-15: a heading id the include rewrites to stay unique resolves under its new id', () => {
  const files: Record<string, string> = { 'same.smd': ['---', 'smd: 2', '---', '', '## Work', '', 'Included work.', ''].join('\n') };
  const text = doc('## Work', '', ':::include{file="same.smd"}', ':::', '', 'See [included](#work-1) and [own](#work).');
  assert.deepEqual(validateSmd(text, { readFile: (p) => files[p] }).map((d) => d.code), []);
  assert.match(renderSmd(text, { readFile: (p) => files[p] }).html, /id="work-1"/);
});
