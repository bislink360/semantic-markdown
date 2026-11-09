import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, DocumentGraph, renderSmd, smdToMarkdown, validateSmd } from '../src/core';
import {
  idDefinitionLines, idHover, idReferences, idUseAt, idUses, namingUses, renameIdEdits, useTarget, type IdDocument, type IdEdit,
} from '../src/core/idRefs';
import { splitIdRef } from '../src/core/idTarget';
import { resolvePath } from '../src/core/graph';
import { exportTree } from '../src/core/exportTree';

/**
 * Block ids in editors (semantic tags R18: go to definition, find references, hover and rename) and references to
 * another document's blocks, `other.smd#R1`, in id attributes and `:ref` (R19). Test names give the requirement ids.
 */

const v2 = (...body: string[]) => `---\nsmd: 2\ntitle: T\n---\n\n${body.join('\n')}\n`;
/** Line of the first line that includes `s`, and the column of `s` in it plus `offset`. */
const at = (text: string, s: string, offset = 0) => {
  const lines = text.split(/\r?\n/);
  const line = lines.findIndex((l) => l.includes(s));
  return { line, column: lines[line].indexOf(s) + offset };
};
/** The text a use spans. */
const spanned = (text: string, u: { line: number; column: number; endColumn: number }) => text.split(/\r?\n/)[u.line].slice(u.column, u.endColumn);
/** Paths resolve as the graph resolves them: relative to the folder of the document they are written in. */
const resolve = (from: string, rel: string) => (rel ? resolvePath(from, rel) : from);
/** The documents after applying the edits (each document's edits from the end, so columns stay right). */
function apply(docs: IdDocument[], edits: IdEdit[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const doc of docs) {
    const eol = doc.text.includes('\r\n') ? '\r\n' : '\n';
    const lines = doc.text.split(/\r?\n/);
    const mine = edits.filter((e) => e.key === doc.key).sort((a, b) => b.line - a.line || b.column - a.column);
    for (const e of mine) lines[e.line] = lines[e.line].slice(0, e.column) + e.newText + lines[e.line].slice(e.endColumn);
    out[doc.key] = lines.join(eol);
  }
  return out;
}

const SPEC = v2(
  '## Requirements',
  '',
  ':::requirement{#R1 priority=P0 status=accepted} Export a report',
  'Users can export a report as CSV.',
  ':::',
  '',
  ':::requirement{#R2 depends-on=R1} Import a report',
  ':::',
  '',
  ':::acceptance{#AC1 verifies="R1, R2"}',
  'Given a report',
  ':::',
  '',
  'See :ref[R1] and [the export](#R1).',
  '',
  '- [ ] Write it :depends[R1,R2] {#T1}',
  '',
  ':::comment{for=R1 kind=note by=@a}',
  'Looks right.',
  ':::',
);
const PLAN = v2(
  ':::acceptance{#TC1 verifies=spec.smd#R1} Export',
  'Given a report',
  ':::',
  '',
  'Covers :ref[spec.smd#R1], not :ref[R1].',
  '',
  '- [ ] Test it :depends[spec.smd#R1] {#T9}',
  '',
  'Also [R1](spec.smd#R1).',
);

// --- Where ids are written ------------------------------------------------------------------------------------------

test('R19: splitIdRef reads other.smd#R1 as R1 in other.smd, and leaves anything else one id', () => {
  assert.deepEqual(splitIdRef('R1'), { path: '', id: 'R1' });
  assert.deepEqual(splitIdRef('spec.smd#R1'), { path: 'spec.smd', id: 'R1' });
  assert.deepEqual(splitIdRef('../req/spec.md#AC-2'), { path: '../req/spec.md', id: 'AC-2' });
  for (const raw of ['#R1', 'spec#R1', 'spec.smd#', 'javascript:x.smd#R1', '//host/x.smd#R1', 'a b.smd#R1']) {
    assert.equal(splitIdRef(raw).path, '', raw);
  }
});

test('R18: idUses finds every {#id}, id attribute, :ref, :depends and link, with the columns of the id itself', () => {
  const uses = idUses(SPEC);
  const of = (kind: string) => uses.filter((u) => u.kind === kind).map((u) => `${u.id}:${spanned(SPEC, u)}${u.key ? `:${u.key}` : ''}`);
  assert.deepEqual(of('definition'), ['R1:R1', 'R2:R2', 'AC1:AC1', 'T1:T1']);
  assert.deepEqual(of('attribute'), ['R1:R1:depends-on', 'R1:R1:verifies', 'R2:R2:verifies', 'R1:R1:for']);
  assert.deepEqual(of('ref'), ['R1:R1']);
  assert.deepEqual(of('depends'), ['R1:R1', 'R2:R2']);
  assert.deepEqual(of('link'), ['R1:R1']);
  assert.ok(uses.every((u) => u.path === ''));
});

test('R19: idUses gives the path of an id in another document and spans the id after the #', () => {
  const cross = idUses(PLAN).filter((u) => u.path);
  assert.deepEqual(cross.map((u) => [u.kind, u.path, u.id, spanned(PLAN, u)]), [
    ['attribute', 'spec.smd', 'R1', 'R1'], ['ref', 'spec.smd', 'R1', 'R1'], ['depends', 'spec.smd', 'R1', 'R1'], ['link', 'spec.smd', 'R1', 'R1'],
  ]);
  const ref = cross[1];
  assert.equal(PLAN.split('\n')[ref.line].slice(ref.start, ref.endColumn), 'spec.smd#R1');
});

test('R18: nothing in code is an id use, and a spec v1 document has no :depends', () => {
  const text = v2('```', ':::acceptance{#X verifies=R1}', ':ref[R1]', '```', '', 'Inline `:ref[R1]` too.');
  assert.deepEqual(idUses(text), []);
  const v1 = '---\nsmd: 1\n---\n\n- [ ] Task :depends[R1] {#T1}\n';
  assert.deepEqual(idUses(v1).map((u) => u.kind), ['definition']);
});

test('R18: idUseAt finds the use under the cursor anywhere in other.smd#R1, and none elsewhere', () => {
  const p = at(PLAN, ':ref[spec.smd#R1]', 6);
  assert.equal(idUseAt(PLAN, p.line, p.column)?.id, 'R1');
  assert.equal(idUseAt(PLAN, p.line, p.column - 2), undefined, 'on the directive name');
  const def = at(SPEC, '#R2');
  assert.equal(idUseAt(SPEC, def.line, def.column + 1)?.kind, 'definition');
});

// --- Definition, references, hover ---------------------------------------------------------------------------------

test('R18: go to definition gives the line of the block, every line of an ambiguous id, and none for an unknown one', () => {
  assert.deepEqual(idDefinitionLines(SPEC, 'R1'), [7]);
  assert.deepEqual(idDefinitionLines(SPEC, 'T1'), [20]);
  assert.deepEqual(idDefinitionLines(v2(':::note{#x}', ':::', '- [ ] A {#x}'), 'x'), [5, 7]);
  assert.deepEqual(idDefinitionLines(SPEC, 'R9'), []);
});

test('R18, R19: find references lists every use of an id across documents, and the {#id} with the declaration', () => {
  const docs = [{ key: 'docs/spec.smd', text: SPEC }, { key: 'docs/plan.smd', text: PLAN }, { key: 'other/spec.smd', text: SPEC }];
  const found = idReferences(docs, { key: 'docs/spec.smd', id: 'R1' }, resolve);
  assert.deepEqual(found.map((f) => `${f.key}:${f.use.line}:${f.use.kind}`), [
    'docs/spec.smd:11:attribute', 'docs/spec.smd:14:attribute', 'docs/spec.smd:18:ref', 'docs/spec.smd:18:link', 'docs/spec.smd:20:depends',
    'docs/spec.smd:22:attribute',
    'docs/plan.smd:5:attribute', 'docs/plan.smd:9:ref', 'docs/plan.smd:11:depends', 'docs/plan.smd:13:link',
  ]);
  const withDeclaration = idReferences(docs, { key: 'docs/spec.smd', id: 'R1' }, resolve, true);
  assert.equal(withDeclaration.length, found.length + 1);
  assert.equal(withDeclaration[0].use.kind, 'definition');
  // `:ref[R1]` in the plan names the plan's own R1, which it doesn't have: not a reference to the spec's.
  assert.ok(!found.some((f) => f.key === 'docs/plan.smd' && spanned(PLAN, f.use) === 'R1' && !f.use.path));
});

test('R18: useTarget names the document a use points at: its own for a {#id}, the path resolved for other.smd#R1', () => {
  const ref = idUseAt(PLAN, at(PLAN, 'spec.smd#R1').line, at(PLAN, 'spec.smd#R1').column)!;
  assert.deepEqual(useTarget('docs/plan.smd', ref, resolve), { key: 'docs/spec.smd', id: 'R1' });
  const def = idUses(SPEC).find((u) => u.kind === 'definition')!;
  assert.deepEqual(useTarget('docs/spec.smd', def, resolve), { key: 'docs/spec.smd', id: 'R1' });
});

test('R18: hover shows the block an id names: kind, attributes, title and the first lines of its body', () => {
  const hover = idHover(SPEC, 'R1')!;
  assert.match(hover, /^\*\*R1\*\* · :::requirement `priority=P0 status=accepted` — Export a report\n\nUsers can export a report as CSV\.$/);
  assert.match(idHover(SPEC, 'T1')!, /\*\*T1\*\* · task \(open\) — Write it :depends\[R1,R2\]/);
  assert.match(idHover(SPEC, 'R1', 'spec.smd')!, /requirement `[^`]*` in spec\.smd — Export/);
  assert.match(idHover(v2(':::note{#x}', ':::', '- [ ] A {#x}'), 'x')!, /is the id of 2 blocks \(lines 6, 8\)/);
  assert.equal(idHover(SPEC, 'R9'), undefined);
});

// --- Rename ---------------------------------------------------------------------------------------------------------

test('R18: renaming a block id updates its {#id}, every id attribute, :ref, :depends and link, across documents', () => {
  const docs = [{ key: 'docs/spec.smd', text: SPEC }, { key: 'docs/plan.smd', text: PLAN }];
  const result = renameIdEdits(docs, { key: 'docs/spec.smd', id: 'R1' }, 'EXPORT-1', resolve);
  assert.ok('edits' in result);
  const out = apply(docs, result.edits);
  assert.equal(out['docs/spec.smd'], SPEC.replaceAll('R1', 'EXPORT-1'));
  // The plan's own `:ref[R1]` names nothing in the spec, so it stays.
  assert.equal(out['docs/plan.smd'], PLAN.replaceAll('spec.smd#R1', 'spec.smd#EXPORT-1'));
});

test('R18: a rename keeps line endings and touches nothing but the ids', () => {
  const crlf = SPEC.replaceAll('\n', '\r\n');
  const docs = [{ key: 'docs/spec.smd', text: crlf }];
  const result = renameIdEdits(docs, { key: 'docs/spec.smd', id: 'R2' }, 'R3', resolve);
  assert.ok('edits' in result);
  assert.equal(apply(docs, result.edits)['docs/spec.smd'], crlf.replaceAll('R2', 'R3'));
  assert.ok(result.edits.every((e) => e.endColumn - e.column === 2));
});

test('R18: a rename is refused for a bad id, a taken id, an unknown id and a heading id from its text', () => {
  const docs = [{ key: 'spec.smd', text: SPEC }];
  const error = (id: string, to: string) => {
    const r = renameIdEdits(docs, { key: 'spec.smd', id }, to, resolve);
    return 'error' in r ? r.error : '';
  };
  assert.match(error('R1', 'R 1'), /can't be an id/);
  assert.match(error('R1', 'R2'), /already an id/);
  assert.match(error('R1', 'requirements'), /already an id/, 'a heading slug is taken too');
  assert.match(error('R9', 'R10'), /No block has the id "R9"/);
  assert.match(error('requirements', 'reqs'), /rename the heading/);
  assert.deepEqual(renameIdEdits(docs, { key: 'spec.smd', id: 'R1' }, 'R1', resolve), { edits: [] });
});

test('R18: an id two blocks give is renamed only at the {#id} under the cursor, which tells them apart', () => {
  const text = v2(':::note{#x} A', ':::', '', '- [ ] B {#x}', '', 'See :ref[x].');
  const docs = [{ key: 'a.smd', text }];
  assert.match((renameIdEdits(docs, { key: 'a.smd', id: 'x' }, 'y', resolve) as { error: string }).error, /id of 2 blocks/);
  const cursor = at(text, '{#x}', 2);
  const result = renameIdEdits(docs, { key: 'a.smd', id: 'x' }, 'y', resolve, { key: 'a.smd', ...cursor });
  assert.ok('edits' in result);
  assert.equal(apply(docs, result.edits)['a.smd'], text.replace(':::note{#x}', ':::note{#y}'));
});

test('R18: a heading rename moves the id attributes, :ref and :depends that name its old id (namingUses)', () => {
  const text = v2('## Export', '', ':::constraint{#C1 applies-to=export} Fast', ':::', '', 'See :ref[export] and [it](#export).');
  const uses = namingUses(text, 'export', (p) => p === '');
  assert.deepEqual(uses.map((u) => u.kind), ['attribute', 'ref'], 'links are left to the host, which already moves them');
  assert.deepEqual(namingUses(text, 'export', () => false), []);
});

// --- R19: validation ------------------------------------------------------------------------------------------------

const files = (map: Record<string, string>) => ({
  fileExists: (p: string) => Object.hasOwn(map, p) || p === 'notes.txt',
  readFile: (p: string) => map[p],
});
const diags = (text: string, map: Record<string, string> = {}) =>
  validateSmd(text, files(map)).filter((d) => /^(?:ref|link|figure|acceptance)\//.test(d.code)).map((d) => `${d.line}:${d.code}`);

test('R19: an id in another document is not checked without file checks, so templates and snippets stay clean', () => {
  assert.deepEqual(validateSmd(PLAN).filter((d) => d.severity === 'warning' || d.severity === 'error').map((d) => d.code), ['figure/unknown-ref']);
  assert.match(validateSmd(PLAN).find((d) => d.code === 'figure/unknown-ref')!.message, /"R1" in this document/);
});

test('R19: other.smd#R1 in an id attribute and :ref resolves in that document, with no warnings', () => {
  const plan = v2(':::acceptance{#TC1 verifies=spec.smd#R1}', ':::', '', 'See :ref[spec.smd#R2].');
  assert.deepEqual(diags(plan, { 'spec.smd': SPEC }), []);
});

test('R19: a missing file is link/missing-file, as for links', () => {
  const plan = v2(':::acceptance{#TC1 verifies=gone.smd#R1}', ':::', '', 'See :ref[gone.smd#R1].');
  const found = validateSmd(plan, files({})).filter((d) => d.code === 'link/missing-file');
  assert.deepEqual(found.map((d) => [d.line, d.severity, spanned(plan, d)]), [[5, 'warning', 'gone.smd#R1'], [8, 'warning', 'gone.smd#R1']]);
  assert.match(found[0].message, /"gone\.smd" does not exist \(named in verifies on ":::acceptance"\)/);
  assert.match(found[1].message, /named in :ref\[gone\.smd#R1\]/);
});

test('R19: an unknown id in the other document is ref/unknown (attributes) or figure/unknown-ref (:ref), with a fix', () => {
  const plan = v2(':::acceptance{#TC1 verifies=spec.smd#R3}', ':::', '', 'See :ref[spec.smd#R3].');
  const found = validateSmd(plan, files({ 'spec.smd': SPEC })).filter((d) => d.code === 'ref/unknown' || d.code === 'figure/unknown-ref');
  assert.deepEqual(found.map((d) => [d.code, d.severity]), [['ref/unknown', 'warning'], ['figure/unknown-ref', 'warning']]);
  assert.match(found[0].message, /No block with id "R3" in "spec\.smd"/);
  for (const d of found) {
    assert.equal(spanned(plan, d.fix!), 'R3', 'the fix replaces the id, not the path');
    assert.match(d.fix!.replacement, /^R[12]$/);
  }
});

test('R19: an id two blocks of the other document give is ref/ambiguous', () => {
  const other = v2(':::note{#x}', ':::', '- [ ] A {#x}');
  const found = validateSmd(v2(':::constraint{#C1 applies-to=o.smd#x}', ':::', 'See :ref[o.smd#x].'), files({ 'o.smd': other }))
    .filter((d) => d.code === 'ref/ambiguous');
  assert.equal(found.length, 2);
  assert.match(found[0].message, /is the id of 2 blocks in "o\.smd" \(lines 6 and 8\)/);
});

test('R19: verifies across documents must name a requirement there (acceptance/verifies-type)', () => {
  assert.deepEqual(diags(v2(':::acceptance{#TC1 verifies=spec.smd#AC1}', ':::'), { 'spec.smd': SPEC }), ['5:acceptance/verifies-type']);
});

test('R19: a file that exists but can\'t be read (outside the allowed folders) is not checked further', () => {
  assert.deepEqual(diags(v2(':::acceptance{#TC1 verifies=spec.smd#R9}', ':::'), {}).length, 1, 'missing');
  const allowedNot = { fileExists: () => true, readFile: () => undefined };
  assert.deepEqual(validateSmd(v2(':::acceptance{#TC1 verifies=spec.smd#R9}', ':::'), allowedNot).filter((d) => d.code.startsWith('ref/')), []);
});

test('R16: an id with a # that is not a document path is still ref/unknown, and says how to name another document', () => {
  const [d] = validateSmd(v2(':::acceptance{#TC1 verifies=spec#R1}', ':::')).filter((x) => x.code === 'ref/unknown');
  assert.match(d.message, /write the path of a \.smd or \.md file before the id, as in other\.smd#R1/);
});

// --- R19: rendering, exports and the graph --------------------------------------------------------------------------

test('R19: :ref and id attributes to another document render as links to it, shown as written', () => {
  const html = renderSmd(PLAN).html;
  assert.match(html, /<a class="smd-ref smd-ref-document" href="spec\.smd#R1">spec\.smd#R1<\/a>/);
  assert.match(html, /verifies <a class="smd-ref smd-ref-document" href="spec\.smd#R1">spec\.smd#R1<\/a>/);
  assert.match(smdToMarkdown(PLAN), /Covers \[spec\.smd#R1\]\(spec\.smd#R1\), not :ref\[R1\]\./);
  assert.match(agentView(PLAN).text, /Covers spec\.smd#R1, not :ref\[R1\]\./);
  assert.ok(JSON.stringify(exportTree(PLAN)).includes('"href":"spec.smd#R1"'));
});

test('R19: the graph resolves other.smd#R1 in the other document, read through readDocument', () => {
  const graph = new DocumentGraph([{ path: 'docs/plan.smd', text: PLAN }], {
    readDocument: (p) => (p === 'docs/spec.smd' ? { text: SPEC } : { status: 'missing' }),
  });
  const edges = graph.edgesOf('docs/plan.smd').filter((e) => e.target === 'spec.smd#R1');
  assert.deepEqual(edges.map((e) => [e.type, e.file, e.status, e.to?.type, e.to?.line]), [
    ['verifies', 'docs/spec.smd', 'resolved', 'requirement', 7], ['ref', 'docs/spec.smd', 'resolved', 'requirement', 7],
    ['depends-on', 'docs/spec.smd', 'resolved', 'requirement', 7], ['link', 'docs/spec.smd', 'resolved', 'requirement', 7],
  ]);
  const denied = new DocumentGraph([{ path: 'docs/plan.smd', text: PLAN }]);
  assert.ok(denied.edgesOf('docs/plan.smd').filter((e) => e.target === 'spec.smd#R1').every((e) => e.status === 'denied'));
});
