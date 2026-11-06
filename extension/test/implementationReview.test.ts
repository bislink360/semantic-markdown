import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentView, type Tokenizer } from '../src/core';
import { Sandbox, smdTools } from '../src/mcp';
import { replaceFile, revisionOf } from '../src/mcpWrite';
import { readDocument } from '../src/readView';
import { isInside, readerFor } from '../src/workspace';
import { Reader } from './bench/netTokens';

/** Regression tests for the findings of the implementation review (C01, C02, C06, C07, C08, C09). */

const count = (text: string, word: string) => text.split(word).length - 1;

// ---------------------------------------------------------------------------
// C01: :::agent blocks nested in :::details survive brief, budgeted and section views.
// ---------------------------------------------------------------------------

const nested = [
  '---', 'smd: 2', 'title: Nested', '---', '',
  '## Requirements', '',
  ':::details More', 'HIDDEN_DETAIL', '::::agent Rules', 'PRESERVE_NESTED_RULE', '::::', ':::', '',
  '## Other', '', 'Other text.', '',
].join('\n');

test('C01: a nested :::agent block is kept in full, brief and budgeted views, once', () => {
  for (const options of [{}, { brief: true }, { maxTokens: 5 }]) {
    const view = agentView(nested, options);
    assert.equal(count(view.text, 'PRESERVE_NESTED_RULE'), 1, JSON.stringify(options));
    assert.match(view.text, /<agent-instructions title="Rules">/);
  }
  const brief = agentView(nested, { brief: true }).text;
  assert.match(brief, /\[details: More — omitted, see L8\]/, 'the details block is still condensed');
  assert.doesNotMatch(brief, /HIDDEN_DETAIL/, 'and its other content still left out');
});

test('C01: an instruction over the budget is kept and the result says it does not fit', () => {
  const view = agentView(nested, { maxTokens: 5 });
  assert.match(view.text, /PRESERVE_NESTED_RULE/);
  assert.equal(view.budget?.fits, false);
});

test('C01: a nested :::agent block outside the requested sections is still included', () => {
  for (const brief of [false, true]) {
    const view = agentView(nested, { sections: ['Other'], brief }).text;
    assert.match(view, /Document-wide agent instructions:[\s\S]*PRESERVE_NESTED_RULE/, `brief: ${brief}`);
    assert.doesNotMatch(view, /HIDDEN_DETAIL/);
  }
});

test('C01: :::details inside :::agent is part of the instructions, not condensed', () => {
  const doc = ['# T', '', ':::agent Rules', 'Top rule.', '::::details Extra', 'EXTRA_RULE', '::::', ':::', ''].join('\n');
  assert.match(agentView(doc, { brief: true }).text, /EXTRA_RULE/);
});

test('C01: :::agent text in code is not an instruction, in any view', () => {
  const doc = ['# T', '', ':::details Code', '```text', ':::agent Fake', 'NOT_A_RULE', ':::', '```', ':::', ''].join('\n');
  for (const brief of [false, true]) assert.doesNotMatch(agentView(doc, { brief }).text, /<agent-instructions/);
  assert.doesNotMatch(agentView(doc, { brief: true }).text, /NOT_A_RULE/);
});

test('C01: :::human blocks still drop the :::agent blocks in them by default', () => {
  const doc = ['# T', '', ':::human', '::::agent Rules', 'HUMAN_ONLY', '::::', ':::', ''].join('\n');
  assert.doesNotMatch(agentView(doc, { brief: true }).text, /HUMAN_ONLY/);
});

// ---------------------------------------------------------------------------
// C09: exact section selection.
// ---------------------------------------------------------------------------

const apiDoc = ['---', 'smd: 2', 'title: A', '---', '', '## API', '', 'Short.', '', '## API details', '', 'Long.', '', '## Café', '', 'Coffee.', ''].join('\n');

test('C09: partial matching stays the default; --exact selects the id or whole title only', () => {
  const partial = agentView(apiDoc, { sections: ['API'] });
  assert.deepEqual(partial.resolvedSections?.[0].headings.map((h) => h.text), ['API', 'API details']);
  const exact = agentView(apiDoc, { sections: ['API'], exactSections: true });
  assert.deepEqual(exact.resolvedSections, [{ query: 'API', headings: [{ id: 'api', text: 'API', line: 5 }] }]);
  assert.doesNotMatch(exact.text, /Long\./);
  assert.match(agentView(apiDoc, { sections: ['api-details'], exactSections: true }).text, /Long\./);
  assert.match(agentView(apiDoc, { sections: ['café'], exactSections: true }).text, /Coffee\./);
  const missing = agentView(apiDoc, { sections: ['AP'], exactSections: true });
  assert.deepEqual(missing.missingSections, ['AP']);
  assert.equal(agentView(apiDoc).resolvedSections, undefined, 'only when sections are requested');
});

// ---------------------------------------------------------------------------
// C06: routing on the tokenizer's count; MCP read takes maxTokens.
// ---------------------------------------------------------------------------

test('C06: readDocument routes on the tokenizer count when one is given, and says so', () => {
  const doc = '# Small\n\nShort text.\n';
  const heavy: Tokenizer = { name: 'heavy', count: (t) => t.length * 100 };
  assert.equal(readDocument(doc).shown, 'full');
  assert.equal(readDocument(doc).tokenBasis, 'estimate');
  const exact = readDocument(doc, { tokenizer: heavy });
  assert.equal(exact.shown, 'outline', 'the estimate fits, the exact count does not');
  assert.equal(exact.tokenBasis, 'heavy');
  assert.match(exact.text, /heavy tokens\) is over the 2000-token budget/);
  assert.equal(exact.counted?.tokenizer, 'heavy');
});

const root = mkdtempSync(join(tmpdir(), 'smd-review-'));
after(() => rmSync(root, { recursive: true, force: true }));
const box = new Sandbox(root);
const tool = (name: string, allowWrite = false) => smdTools(box, { allowWrite }).find((t) => t.name === name)!;

test('C06/C09: MCP read takes maxTokens and exact', async () => {
  writeFileSync(join(root, 'api.smd'), apiDoc);
  assert.match(await tool('read').run({ file: 'api.smd', maxTokens: 1 }), /over the 1-token budget/);
  const exact = await tool('read').run({ file: 'api.smd', sections: ['API'], exact: true });
  assert.match(exact, /Short\./);
  assert.doesNotMatch(exact, /Long\./);
});

const cli = join(__dirname, '..', 'dist', 'cli.js');
const smd = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });

test('C06/C09: smd read rejects an unknown tokenizer; read and agent take --exact', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  writeFileSync(join(root, 'api.smd'), apiDoc);
  const bad = smd('read', join(root, 'api.smd'), '--tokenizer', 'NOT_AN_ENCODING');
  assert.equal(bad.status, 2, bad.stdout);
  for (const command of ['read', 'agent']) {
    const out = smd(command, join(root, 'api.smd'), '--section', 'API', '--exact');
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /Long\./, command);
  }
});

// ---------------------------------------------------------------------------
// C07: one containment check for the CLI and MCP readers.
// ---------------------------------------------------------------------------

test('C07: isInside compares whole path segments', () => {
  assert.ok(isInside(join(root, 'a'), join(root, 'a', 'b.txt')));
  assert.ok(isInside(join(root, 'a'), join(root, 'a')));
  assert.ok(!isInside(join(root, 'a'), join(root, 'ab', 'c.txt')), 'a similar prefix is not inside');
  assert.ok(!isInside(join(root, 'a'), join(root, 'a', '..', 'b')));
});

test('C07: the reader refuses links that lead outside its roots', (t) => {
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  mkdirSync(join(project, 'docs'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(project, 'docs', 'ok.txt'), 'OK');
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  writeFileSync(join(root, 'projectx.txt'), 'SIBLING');
  const read = readerFor(join(project, 'doc.smd'), [project]);
  assert.equal(read('docs/ok.txt'), 'OK');
  assert.equal(read('../outside/secret.txt'), undefined);
  assert.equal(read('../projectx.txt'), undefined);
  try {
    symlinkSync(outside, join(project, 'link'), 'junction');
  } catch (e) {
    t.skip(`links can't be created here (${(e as NodeJS.ErrnoException).code}); the lexical checks ran`);
    return;
  }
  assert.equal(read('link/secret.txt'), undefined, 'a junction out of the project is refused');
  const mcpRoot = new Sandbox(project);
  writeFileSync(join(project, 'doc.smd'), '# D\n');
  assert.equal(mcpRoot.reader(join(project, 'doc.smd'))('link/secret.txt'), undefined, 'and the MCP reader agrees');
});

// ---------------------------------------------------------------------------
// C08: guarded writes.
// ---------------------------------------------------------------------------

const plan = ['---', 'smd: 2', 'title: Plan', 'status: draft', '---', '', '## Tasks', '', '- [ ] Ship it', ''].join('\n');

test('C08: read gives a revision when writes are on; a stale revision is refused and nothing is written', async () => {
  writeFileSync(join(root, 'plan.smd'), plan);
  assert.doesNotMatch(await tool('read').run({ file: 'plan.smd' }), /\[revision/);
  const read = await tool('read', true).run({ file: 'plan.smd' });
  const revision = /\[revision ([0-9a-f]{12})\]/.exec(read)?.[1];
  assert.equal(revision, revisionOf(plan));
  writeFileSync(join(root, 'plan.smd'), plan.replace('Ship it', 'Ship it now'));
  const before = readFileSync(join(root, 'plan.smd'), 'utf8');
  await assert.rejects(async () => tool('check_task', true).run({ file: 'plan.smd', line: 9, revision }), /changed since revision/);
  assert.equal(readFileSync(join(root, 'plan.smd'), 'utf8'), before);
  const done = await tool('check_task', true).run({ file: 'plan.smd', line: 9, revision: revisionOf(before) });
  assert.match(done, /\[revision [0-9a-f]{12}\]/);
  assert.deepEqual(readdirSync(root).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');
});

test('C08: writes use the folder rule config; existing errors do not block a repair', async () => {
  const dir = join(root, 'configured');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'smd.config.json'), JSON.stringify({ rules: { 'link/missing-file': 'error' } }));
  writeFileSync(join(dir, 'plan.smd'), plan);
  const before = readFileSync(join(dir, 'plan.smd'), 'utf8');
  await assert.rejects(
    async () => tool('add_decision', true).run({ file: 'configured/plan.smd', section: 'Tasks', title: 'T', body: 'See [x](missing.smd).' }),
    /Not written[\s\S]*link\/missing-file/,
  );
  assert.equal(readFileSync(join(dir, 'plan.smd'), 'utf8'), before, 'nothing written on refusal');
  // A document that already has the configured error can still be changed.
  writeFileSync(join(dir, 'plan.smd'), plan.replace('- [ ] Ship it', '- [ ] Ship it, see [x](missing.smd)'));
  assert.match(await tool('check_task', true).run({ file: 'configured/plan.smd', line: 9 }), /^Done/);
});

test('C08: replaceFile refuses a file that changed while the tool ran and leaves it as it is', () => {
  const file = join(root, 'race.smd');
  writeFileSync(file, 'now\n');
  assert.throws(() => replaceFile(file, 'before\n', 'after\n'), /changed while the tool ran/);
  assert.equal(readFileSync(file, 'utf8'), 'now\n');
  replaceFile(file, 'now\n', 'after\r\n');
  assert.equal(readFileSync(file, 'utf8'), 'after\r\n');
  assert.deepEqual(readdirSync(root).filter((f) => f.endsWith('.tmp')), []);
});

// ---------------------------------------------------------------------------
// C02: the benchmark reads files where they are, with the fixed date, and reports what smd read showed.
// ---------------------------------------------------------------------------

test('C02: the benchmark reader resolves relative includes and uses the fixed date', () => {
  const dir = join(root, 'bench');
  mkdirSync(join(dir, 'parts'), { recursive: true });
  writeFileSync(join(dir, 'parts', 'p.smd'), '---\nsmd: 2\ntitle: P\n---\n\nINCLUDED_TEXT\n');
  const text = ['---', 'smd: 2', 'title: Inc', '---', '', '## A', '', ':::include{file="parts/p.smd"}', ':::', '', '- [ ] Late :due[2026-10-01]', ''].join('\n');
  writeFileSync(join(dir, 'root.smd'), text);
  const modes = existsSync(cli) ? (['in-process', 'cli'] as const) : (['in-process'] as const);
  for (const mode of modes) {
    const reader = new Reader(mode);
    for (const doc of [{ name: 'root', text, dir, file: join(dir, 'root.smd') }, { name: 'generated', text, dir }]) {
      const out = reader.read(doc);
      assert.equal(out.shown, 'full', `${mode} ${doc.name}`);
      assert.match(out.text, /INCLUDED_TEXT/, `${mode} ${doc.name}: the include resolves`);
      assert.match(out.text, /OVERDUE/, `${mode} ${doc.name}: read with the benchmark's date`);
    }
  }
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('.')), [], 'no generated file left');
});
