import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, serverInstructions, smdTools } from '../src/mcp';
import { ToolError } from '../src/mcpProtocol';
import { revisionOf } from '../src/mcpWrite';
import { reviewItems } from '../src/core/review';

/** `smd mcp --allow-suggest` (collaboration RFC, "Agents as collaborators"; feedback loop RFC, F4). */

const root = mkdtempSync(join(tmpdir(), 'smd-suggest-'));
after(() => rmSync(root, { recursive: true, force: true }));
const box = new Sandbox(root);
const DOC = '---\r\nsmd: 2\r\ntitle: T\r\n---\r\n\r\n## Cache\r\n\r\n:::requirement{#R1} Cache\r\nTen minutes.\r\n:::\r\n';

const tool = (name: string, options = { allowSuggest: true }) => smdTools(box, options).find((t) => t.name === name)!;

test('the default tool list and instructions are unchanged; --allow-suggest adds suggest only', () => {
  const names = (options = {}) => smdTools(box, options).filter((t) => !t.hidden).map((t) => t.name);
  assert.deepEqual(names(), ['read', 'tasks', 'query', 'validate']);
  assert.deepEqual(JSON.stringify(smdTools(box).filter((t) => !t.hidden).map((t) => [t.name, t.description, t.inputSchema])),
    JSON.stringify(smdTools(box, { allowSuggest: false }).filter((t) => !t.hidden).map((t) => [t.name, t.description, t.inputSchema])));
  assert.deepEqual(names({ allowSuggest: true }), ['read', 'tasks', 'query', 'validate', 'suggest']);
  assert.equal(serverInstructions({ allowSuggest: false }), serverInstructions());
  assert.match(serverInstructions({ allowSuggest: true }), /"suggest"/);
});

test('suggest inserts a suggestion with the target revision and the agent as author; read gives the revision', async () => {
  writeFileSync(join(root, 'doc.smd'), DOC);
  const read = await tool('read').run({ file: 'doc.smd' });
  const revision = /\[revision ([0-9a-f]{12})\]/.exec(read)?.[1];
  assert.equal(revision, revisionOf(DOC));
  assert.doesNotMatch(await tool('read', { allowSuggest: false }).run({ file: 'doc.smd' }), /\[revision/);
  const out = await tool('suggest').run({ file: 'doc.smd', id: 'R1', text: 'Five minutes.', revision, title: 'Shorter' });
  assert.match(out, /Suggested new text for R1 in doc\.smd, line 12\./);
  const text = readFileSync(join(root, 'doc.smd'), 'utf8');
  assert.ok(text.startsWith(DOC.replace(/\r\n$/, '')), 'every line before is kept');
  assert.ok(!/[^\r]\n/.test(text), 'CRLF kept');
  const [item] = reviewItems(text);
  assert.equal(item.type, 'suggestion');
  assert.equal(item.attrs.author, '@agent');
  assert.equal(item.stale, false);
  assert.equal(item.body, 'Five minutes.');
});

test('suggest refuses a changed document, an unknown block, and leaves the file alone', async () => {
  writeFileSync(join(root, 'doc.smd'), DOC);
  const refused = async (args: Record<string, unknown>, pattern: RegExp) => {
    await assert.rejects(async () => tool('suggest').run({ file: 'doc.smd', ...args }), (e: Error) => e instanceof ToolError && pattern.test(e.message));
    assert.equal(readFileSync(join(root, 'doc.smd'), 'utf8'), DOC);
  };
  await refused({ id: 'R1', text: 'x', revision: '000000000000' }, /changed since revision/);
  await refused({ id: 'R9', text: 'x', revision: revisionOf(DOC) }, /No block with id "R9"/);
  await refused({ id: 'R1', text: 'x', revision: revisionOf(DOC), author: 'two words' }, /one word/);
  await assert.rejects(async () => tool('suggest').run({ file: '../outside.smd', id: 'R1', text: 'x', revision: 'a' }));
});
