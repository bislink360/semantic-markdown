import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTasks, renderSmd, resolveId } from '../src/core';
import { idOwners } from '../src/core/parse';
import { splitTaskId } from '../src/core/taskId';
import { taskLine } from '../src/workspace';

/** Task ids (`- [ ] Ship it {#ship}`): what is an id, and the line-based readers and rendering agree. */

const doc = (body: string[], spec = 2) => ['---', `smd: ${spec}`, 'title: T', '---', '', ...body, ''].join('\n');
/** Each task's text and id as `smd tasks` reads them, and the ids rendering gives the task items. */
const both = (text: string) => ({
  read: extractTasks(text).map((t) => [t.text, t.id ?? null]),
  rendered: [...renderSmd(text).html.matchAll(/<li(?: id="([^"]*)")? class="smd-task/g)].map((m) => m[1] ?? null),
});

test('splitTaskId reads only a trailing {#id} after a space', () => {
  assert.deepEqual(splitTaskId('Ship it {#ship}'), { text: 'Ship it', id: 'ship' });
  assert.deepEqual(splitTaskId('Ship it {#ship}   '), { text: 'Ship it', id: 'ship' });
  assert.deepEqual(splitTaskId('Ship it  {#a-b_9}'), { text: 'Ship it', id: 'a-b_9' });
  for (const text of ['Ship it {#ship .x}', 'Ship :badge[x]{#y}', 'Ship \\{#ship}', '{#ship}', 'Ship {#}', 'Ship {#a b}', 'Ship {#ship} now', 'Ship {.x}']) {
    assert.deepEqual(splitTaskId(text), { text }, text);
  }
});

test('rendering and the task readers agree on which tasks have ids', () => {
  const text = doc([
    '- [ ] One {#one}',
    '- [x] Two :priority[P2] {#two}',
    '- [ ] Not an id {#three .x}',
    '- [ ] Escaped \\{#four}',
    '- [ ] Id on the first line {#five}',
    '  continued on the next',
    '- [ ] An id on a continuation line',
    '  is text {#six}',
    '  - [ ] Nested {#seven}',
    '',
    '1. [ ] Ordered {#nine}',
  ]);
  const { read, rendered } = both(text);
  assert.deepEqual(read, [
    ['One', 'one'], ['Two', 'two'], ['Not an id {#three .x}', null], ['Escaped \\{#four}', null], ['Id on the first line', 'five'],
    ['An id on a continuation line', null], ['Nested', 'seven'], ['Ordered', 'nine'],
  ]);
  assert.deepEqual(rendered, read.map(([, id]) => id));
  assert.match(renderSmd(text).html, /is text \{#six\}/, 'an id on a later line stays text');
});

test('a task in a blockquote, which smd tasks does not list, still renders with its id', () => {
  const text = doc(['> - [ ] Quoted {#quoted}']);
  assert.match(renderSmd(text).html, /<li id="quoted" class="smd-task"/);
  assert.equal(resolveId(text, 'quoted').status, 'resolved');
});

test('a task id in code is no id, and spec v1 documents read task ids too', () => {
  const code = doc(['```', '- [ ] In code {#code}', '```']);
  assert.deepEqual(extractTasks(code), []);
  assert.equal(resolveId(code, 'code').status, 'missing');
  assert.deepEqual(both(doc(['- [ ] Old {#old}'], 1)), { read: [['Old', 'old']], rendered: ['old'] });
});

test('smd tasks shows the id as the line writes it', () => {
  const [task] = extractTasks(doc(['## Plan', '', '- [ ] Ship it @ann :due[2026-12-01] {#ship}']), '2026-11-06');
  assert.equal(taskLine({ ...task, file: 'plan.smd' }), 'plan.smd:8  [ ] Ship it @ann (due 2026-12-01) {#ship}  — Plan');
});

test('the blocks that give an id keep their lines when an edit above moves them', () => {
  const before = doc(['## A', '', '- [ ] Ship {#ship}', '', 'Text.', '', '- [ ] Again {#ship}']);
  assert.deepEqual(idOwners(before).get('ship')?.map((o) => o.line), [7, 11]);
  const after = before.replace('## A', '## A\n\nNew paragraph.');
  assert.deepEqual(idOwners(after).get('ship')?.map((o) => o.line), [9, 13]);
  const edited = after.replace('Text.', 'Text, edited.');
  assert.deepEqual(idOwners(edited).get('ship')?.map((o) => o.line), [9, 13]);
});
