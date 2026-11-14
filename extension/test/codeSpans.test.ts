import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, extractTasks } from '../src/core';
import { codeSpans, dependsLists, maskCodeSpans } from '../src/core/codeSpans';
import { DocumentGraph } from '../src/core/graph';
import { idUses } from '../src/core/idRefs';
import { dependsIds } from '../src/core/semanticTags';

/**
 * One code-span masker and one `:depends` pattern (improvement roadmap t-06, CL-02): every reader of `:depends[…]`
 * skips code spans the way CommonMark reads them.
 */

test('t-06: a code span closes only on a run of the same length', () => {
  assert.deepEqual(codeSpans('``a`b`` c'), [[0, 7]]);
  assert.deepEqual(codeSpans('`a``b` c'), [[0, 6]]);
  assert.equal(maskCodeSpans('x ``a`b`` y'), `x ${' '.repeat(7)} y`);
});

test('t-06: a backslash-escaped backtick opens nothing, and an even run of backslashes does not escape it', () => {
  assert.deepEqual(codeSpans('\\`a :depends[X] `b`'), [[16, 19]]);
  assert.deepEqual(codeSpans('\\\\`code`'), [[2, 8]]);
  // Inside code a backslash is text, so it does not stop the span from closing.
  assert.deepEqual(codeSpans('`a\\` b'), [[0, 4]]);
});

test('t-06: an unmatched run is text, and what follows it is read', () => {
  assert.deepEqual(codeSpans('` :depends[X]'), []);
  assert.deepEqual(codeSpans('``a` :depends[X]'), []);
  assert.equal(maskCodeSpans('open ` only'), 'open ` only');
});

test('t-06: :depends lists keep their columns in the source line', () => {
  const line = '- [ ] Do `x` it :depends[A, B] and :DEPENDS[C]';
  const lists = dependsLists(line);
  assert.deepEqual(lists.map((d) => d.list), ['A, B', 'C']);
  for (const d of lists) assert.equal(line.slice(d.column, d.column + d.list.length), d.list);
});

/** What each reader of `:depends` sees on one task line. */
function readers(task: string) {
  const text = `---\nsmd: 2\n---\n\n${task}\n`;
  const graph = new DocumentGraph([{ path: 't.smd', text }]).edgesOf('t.smd').filter((e) => e.type === 'depends-on').map((e) => e.target);
  const uses = idUses(text).filter((u) => u.kind === 'depends').map((u) => u.id);
  return { dependsIds: dependsIds(task, 2), extractTasks: extractTasks(text)[0]?.depends ?? [], graph, uses };
}

test('t-06: dependsIds, extractTasks, DocumentGraph and idUses agree on every code-span case', () => {
  const cases: Array<[string, string[]]> = [
    ['- [ ] Ship ``a `:depends[X]` b``', []],
    ['- [ ] Ship `` a ` b `` :depends[X] `', ['X']],
    ['- [ ] Ship \\`a :depends[X] `b`', ['X']],
    ['- [ ] Ship `:depends[X]` :depends[Y]', ['Y']],
    ['- [ ] Ship ``` x `` :depends[X] ```', []],
  ];
  for (const [task, expected] of cases) {
    const seen = readers(task);
    assert.deepEqual(seen, { dependsIds: expected, extractTasks: expected, graph: expected, uses: expected }, task);
  }
});

test('t-06: task mentions keep their own masking', () => {
  const text = '---\nsmd: 2\n---\n\n- [ ] Ship `@code` it @ana\n';
  assert.deepEqual(extractTasks(text)[0].assignees, ['@ana']);
});

const DOC = (task: string) => [
  '---', 'smd: 2', 'title: Deps', '---', '',
  '## Work', '', task, '',
  '## Basis', '', ':::requirement{#R4} Task target', 'R4_BODY', ':::', '',
].join('\n');

test('t-06: whether a :depends sits in code decides whether a section read carries its target', () => {
  const carried = (task: string) => /R4_BODY/.test(agentView(DOC(task), { sections: ['Work'] }).text);
  assert.equal(carried('- [ ] Ship it :depends[R4]'), true);
  assert.equal(carried('- [ ] Ship it ``a `:depends[R4]` b``'), false);
  assert.equal(carried('- [ ] Ship it \\`a :depends[R4] `b`'), true);
});
