import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, applyFixes, renderSmd, smdToMarkdown, validateSmd } from '../src/core';
import { migrationPlan } from '../src/core/migrate';
import { ID_ATTRIBUTES, idList, INLINE_DIRECTIVES, isKnownDirective, V1_DIRECTIVES } from '../src/core/spec';

/**
 * Semantic tags groundwork (docs/rfcs/semantic-tags.smd): the frozen spec v1 directive list (D5), `:ref[id]` to any
 * block (D4, R14) and the id attribute checks `ref/unknown` and `ref/ambiguous` (R15 to R17). Test names give the
 * requirement and acceptance ids they cover.
 */

const v2 = (body: string) => `---\nsmd: 2\ntitle: T\n---\n\n${body}\n`;
const v1 = (body: string) => `---\nsmd: 1\ntitle: T\n---\n\n${body}\n`;
const codes = (text: string, prefix: RegExp) => validateSmd(text).filter((d) => prefix.test(d.code));
const refHtml = (text: string) => renderSmd(text).html.match(/<(?:a|span) class="smd-ref[^"]*"[^>]*>[^<]*<\/(?:a|span)>/g) ?? [];

// --- D5: spec v1 keeps its directive list -------------------------------------------------------------------------

test('D5: the v1 directive list is the nine 3.0 names, frozen, and all of them are still directives', () => {
  assert.deepEqual([...V1_DIRECTIVES], ['badge', 'kbd', 'progress', 'mention', 'status', 'priority', 'due', 'metric', 'ref']);
  assert.ok(Object.isFrozen(V1_DIRECTIVES));
  for (const name of V1_DIRECTIVES) assert.ok(Object.hasOwn(INLINE_DIRECTIVES, name), name);
});

test('D5: isKnownDirective reads the v1 list in spec v1 and the whole vocabulary in spec v2', () => {
  for (const name of Object.keys(INLINE_DIRECTIVES)) assert.equal(isKnownDirective(name, 2), true, name);
  assert.equal(isKnownDirective('since', 1), false);
  assert.equal(isKnownDirective('constructor', 1), false);
  assert.equal(isKnownDirective('constructor', 2), false);
  assert.equal(isKnownDirective('Badge', 1), false);
});

test('AC17 (R61): an smd: 1 document with :since[1.6] renders it as text and gets no directive warning', () => {
  const text = v1('Added :since[1.6] and :depends[R7] here.');
  assert.match(renderSmd(text).html, /Added :since\[1\.6\] and :depends\[R7\] here\./);
  assert.match(agentView(text).text, /Added :since\[1\.6\] and :depends\[R7\] here\./);
  assert.deepEqual(codes(text, /^directive\//), []);
});

test('AC17 (R61): smd migrate --to 2 escapes v1 text such as :since[1.6] so it stays text', () => {
  const plan = migrationPlan(v1('Added :since[1.6] here.'));
  assert.match(plan.result, /Added \\:since\[1\.6\] here\./);
  assert.match(renderSmd(plan.result).html, /Added :since\[1\.6\] here\./);
});

// --- D4, R14: :ref[id] to any block --------------------------------------------------------------------------------

test('AC2 (R14): :ref to a heading, task or container shows its id, linked, with its title as the accessible name', () => {
  const text = v2([
    '## Export rules {#R1}', '', '- [ ] Write the exporter {#T1}', '',
    ':::note{#N1} Keep it short', 'Body', ':::', '', 'See :ref[R1], :ref[T1] and :ref[N1].',
  ].join('\n'));
  assert.deepEqual(refHtml(text), [
    '<a class="smd-ref" href="#R1" title="Export rules" aria-label="R1, Export rules">R1</a>',
    '<a class="smd-ref" href="#T1" title="Write the exporter" aria-label="T1, Write the exporter">T1</a>',
    '<a class="smd-ref" href="#N1" title="Keep it short" aria-label="N1, Keep it short">N1</a>',
  ]);
  assert.deepEqual(codes(text, /ref/), []);
});

test('D4: a figure keeps its label and first-match rule, even when another block has the same id', () => {
  const text = v2([':::figure{#fig-a} Flow', '![x](x.png)', ':::', '', '## Flow notes {#fig-a}', '', 'See :ref[fig-a].'].join('\n'));
  assert.deepEqual(refHtml(text), ['<a class="smd-ref" href="#fig-a">Figure 1</a>']);
  assert.match(agentView(text).text, /See Figure 1 \(fig-a\)\./);
  assert.deepEqual(codes(text, /^ref\//), []);
});

test('D4: the agent view shows a block reference as its id, and plain Markdown links it', () => {
  const text = v2('## Rules {#R1}\n\nSee :ref[R1].');
  assert.match(agentView(text).text, /See R1\./);
  assert.match(smdToMarkdown(text), /See \[R1\]\(#R1\)\./);
});

test('AC3 (R17): :ref to an id two blocks give links to neither and warns ref/ambiguous', () => {
  const text = v2('## One {#d}\n\n<b id="d">x</b>\n\nSee :ref[d].');
  assert.deepEqual(refHtml(text), ['<span class="smd-ref smd-ref-ambiguous" title="More than one block has this id">d</span>']);
  assert.match(agentView(text).text, /See :ref\[d\]\./);
  assert.match(smdToMarkdown(text), /See :ref\[d\]\./);
  const [ambiguous] = codes(text, /^ref\/ambiguous$/);
  assert.match(ambiguous.message, /is the id of 2 blocks \(lines 6 and 8\)/);
});

test('R16: an unknown :ref keeps figure/unknown-ref and its released output, now offering any block id', () => {
  const text = v2('## Rules {#R1}\n\nSee :ref[R2].');
  assert.deepEqual(refHtml(text), ['<span class="smd-ref smd-ref-missing" title="No figure with this id">R2</span>']);
  assert.match(smdToMarkdown(text), /See :ref\[R2\]\./);
  const [unknown] = codes(text, /^figure\/unknown-ref$/);
  assert.match(unknown.message, /No block with id "R2"/);
  assert.equal(unknown.fix?.replacement, 'R1');
});

// --- R15 to R17: id attributes -------------------------------------------------------------------------------------

test('R15: id attributes take one id or a comma-separated list, bare or quoted', () => {
  assert.deepEqual(idList('R1'), ['R1']);
  assert.deepEqual(idList('R1,R2'), ['R1', 'R2']);
  assert.deepEqual(idList(' R1, R2 ,'), ['R1', 'R2']);
  assert.deepEqual(Object.keys(ID_ATTRIBUTES), ['verifies', 'applies-to', 'depends-on', 'supports', 'contradicts', 'supersedes', 'between', 'for']);
});

test('AC1 (R13, R16): an id in verifies that names nothing warns ref/unknown with a fix to the closest id', () => {
  const text = v2('## Rules {#R1}\n\n:::acceptance{#AC1 verifies="R1, R9"}\nGiven x\n:::');
  const [unknown, ...rest] = codes(text, /^ref\//);
  assert.equal(rest.length, 0);
  assert.equal(unknown.code, 'ref/unknown');
  assert.match(unknown.message, /No block with id "R9".*verifies on ":::acceptance"/);
  assert.equal(text.split('\n')[unknown.line].slice(unknown.column, unknown.endColumn), 'R9');
  assert.match(applyFixes(text, [unknown]).text, /verifies="R1, R1"/);
});

test('R16: applies-to names any block, and a reference to another document is reported until R19', () => {
  const text = v2('## Rules {#R1}\n\n:::constraint{applies-to=R1,other.smd#R2}\nx\n:::');
  const found = codes(text, /^ref\//);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /"other\.smd#R2".*not read yet/);
  assert.equal(found[0].fix, undefined);
});

test('AC3 (R17): an id attribute naming a duplicate id warns ref/ambiguous next to id/duplicate', () => {
  const text = v2('## A {#R1}\n\n## B {#R1}\n\n:::acceptance{#AC1 verifies=R1}\nx\n:::');
  assert.deepEqual(validateSmd(text).filter((d) => /^(ref|id)\//.test(d.code)).map((d) => d.code).sort(), ['id/duplicate', 'ref/ambiguous']);
});

test('R63: id attributes on other containers and documents without them are not checked', () => {
  assert.deepEqual(codes(v2(':::note{verifies=R9}\nx\n:::'), /^ref\//), []);
  assert.deepEqual(codes(v2('```text\n:::acceptance{verifies=R9}\n```'), /^ref\//), []);
});
