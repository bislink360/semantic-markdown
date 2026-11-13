import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentView, type Tokenizer } from '../src/core';
import { Sandbox, smdTools } from '../src/mcp';
import { replaceFile, revisionOf } from '../src/mcpWrite';
import { readDocument } from '../src/readView';
import { isInside, readerFor } from '../src/workspace';
import { CALL, Reader, runRecord } from './bench/netTokens';

/** Regression tests for the findings of the implementation review (C01, C02, C04, C05, C06, C07, C08, C09). */

const count = (text: string, word: string) => text.split(word).length - 1;

// C01: :::agent blocks nested in :::details survive brief, budgeted and section views.

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

// C09: exact section selection.

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

// C06: routing on the tokenizer's count; MCP read takes maxTokens.

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

// C07: one containment check for the CLI and MCP readers.

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

// C08: guarded writes.

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

// C02: the benchmark reads files where they are, with the fixed date, and reports what smd read showed.

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

test('C02: a failing CLI read throws instead of giving a number', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = join(root, 'bench-fail');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'doc.smd');
  writeFileSync(file, '# Doc\n\nText.\n');
  const doc = { name: 'doc', text: readFileSync(file, 'utf8'), dir, file };
  // The CLI exits 2 on a tokenizer it does not know.
  const unknown: Tokenizer = { name: 'NOT_AN_ENCODING', count: (t) => t.length };
  assert.throws(() => new Reader('cli', unknown).read(doc), /smd read .* failed \(exit 2\)/);
  // A file that is not there.
  assert.throws(() => new Reader('cli').read({ ...doc, file: join(dir, 'missing.smd') }), /smd read .* failed \(exit [1-9]/);
});

test('C02: the run record names the commit, CLI build, Node, OS, settings and each document hash', () => {
  const text = '# Doc\n\nText.\n';
  const docs = [{ name: 'doc', text, dir: root }];
  const heavy: Tokenizer = { name: 'heavy', count: (t) => t.length };
  const record = runRecord(new Reader('in-process', heavy), heavy, docs, ['--json', '--reader', 'in-process']);
  assert.match(record.commit ?? '', /^[0-9a-f]{40}$/, 'the commit of this checkout');
  assert.equal(typeof record.dirty, 'boolean');
  if (existsSync(cli)) {
    assert.deepEqual(record.cli, { file: 'extension/dist/cli.js', sha256: createHash('sha256').update(readFileSync(cli)).digest('hex') });
  } else {
    assert.equal(record.cli, null);
  }
  assert.equal(record.node, process.version);
  assert.ok(record.platform.startsWith(`${process.platform} `), record.platform);
  assert.equal(record.reader, 'in-process');
  assert.equal(record.today, '2026-10-28');
  assert.equal(record.tokenizer, 'heavy');
  assert.match(record.routing, /heavy/);
  assert.equal(record.callTokens, CALL);
  assert.deepEqual(record.args, ['--json', '--reader', 'in-process']);
  assert.deepEqual(record.documents, [{ name: 'doc', sha256: createHash('sha256').update(text).digest('hex') }]);
  const estimate = runRecord(new Reader('in-process'), undefined, docs, []);
  assert.match(estimate.tokenizer, /^estimate/);
  assert.match(estimate.routing, /estimate/);
});

test('C02: the benchmark rejects a --reader value other than cli or in-process', () => {
  const script = join(__dirname, 'bench', 'netTokens.ts');
  const res = spawnSync(process.execPath, ['--import', 'tsx', script, '--reader', 'bogus'], { cwd: join(__dirname, '..'), encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(res.status, 0, res.stdout);
  assert.match(res.stderr, /--reader takes cli or in-process/);
  assert.equal(res.stdout, '', 'no report');
});

// C01: the MCP read tool keeps a nested :::agent block once.

test('C01: MCP read keeps a :::agent block nested in :::details once, brief and with sections', async () => {
  writeFileSync(join(root, 'nested.smd'), nested);
  const cases = [
    { brief: true },
    { sections: ['Requirements'] },
    { sections: ['Other'] },
    { sections: ['Other'], brief: true },
    { sections: ['Requirements'], brief: true, exact: true },
  ];
  for (const args of cases) {
    const out = await tool('read').run({ file: 'nested.smd', ...args });
    assert.equal(count(out, 'PRESERVE_NESTED_RULE'), 1, JSON.stringify(args));
    assert.match(out, /<agent-instructions title="Rules">/, JSON.stringify(args));
    if (args.brief || args.sections?.[0] === 'Other') assert.doesNotMatch(out, /HIDDEN_DETAIL/, JSON.stringify(args));
  }
});

// C04: trust wording and constraints outside the selected sections.

const repo = join(__dirname, '..', '..');

test('C04: the reader skill, the agent rules and AGENTS.md say agent instructions grant no permissions', () => {
  for (const rel of ['skills/semantic-markdown-reader/SKILL.md', 'skills/agent-rules.md', 'docs/reference/agents.md']) {
    const text = readFileSync(join(repo, rel), 'utf8');
    const line = text.split('\n').find((l) => /:::agent/.test(l) && /permission/i.test(l));
    assert.ok(line, `${rel}: a line on :::agent and permissions`);
    assert.match(line, /never grants? permissions|grants? no permissions/i, rel);
    assert.match(line, /user/i, `${rel}: bound to the user's task or below the user`);
  }
});

/** Rules that disagree, all outside the selected section. */
const retentionHead = ['---', 'smd: 2', 'title: Retention', 'status: draft', '---', '', '## Scope', '', 'SCOPE_TEXT', ''];
const storage = [
  '## Storage', '',
  ':::decision{status=accepted} Keep logs 30 days', 'Short retention.', ':::', '',
  ':::danger Never delete audit logs', 'AUDIT_LOGS_STAY.', ':::', '',
];
const cleanup = [
  '## Cleanup', '',
  ':::decision{status=accepted} Keep logs 365 days', 'Long retention.', ':::', '',
  ':::warning Delete old audit logs nightly', 'Free the disk.', ':::', '',
];
const conflicting = [...retentionHead, ...storage, ...cleanup].join('\n');

test('C04: constraints that disagree are all listed as written, in document order, nothing resolved', () => {
  const r = agentView(conflicting, { sections: ['Scope'], constraints: true });
  assert.deepEqual(r.constraints!.pointers.map((p) => [p.type, p.title, p.section]), [
    ['decision', 'Keep logs 30 days', 'Storage'],
    ['danger', 'Never delete audit logs', 'Storage'],
    ['decision', 'Keep logs 365 days', 'Cleanup'],
    ['warning', 'Delete old audit logs nightly', 'Cleanup'],
  ]);
  assert.equal(r.constraints!.shown, 1);
  assert.match(r.text, /<danger title="Never delete audit logs"> \[L\d+\]\nAUDIT_LOGS_STAY\.\n<\/danger>/);
  assert.match(r.text, /- accepted decision "Keep logs 30 days" \[L\d+\] in "Storage"\n- accepted decision "Keep logs 365 days" \[L\d+\] in "Cleanup"\n- warning "Delete old audit logs nightly" \[L\d+\] in "Cleanup"/);
  assert.doesNotMatch(r.text, /conflict|supersede|overrid|wins|priority/i, 'no ranking or resolution added');
  // Swapping the sections swaps the list: the order is the document's, not a ranking.
  const swapped = [...retentionHead, ...cleanup, ...storage].join('\n');
  const s = agentView(swapped, { sections: ['Scope'], constraints: true });
  assert.deepEqual(s.constraints!.pointers.map((p) => p.title), ['Keep logs 365 days', 'Delete old audit logs nightly', 'Keep logs 30 days', 'Never delete audit logs']);
});

test('C04: smd agent --section --constraints lists the constraints elsewhere; without it only the dangers are added', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const file = join(root, 'retention.smd');
  writeFileSync(file, conflicting);
  const plain = smd('agent', file, '--section', 'Scope');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Dangers elsewhere in the document:\n<danger title="Never delete audit logs"> \[L\d+\]\nAUDIT_LOGS_STAY\.\n<\/danger>/, 'dangers apply to every section (decided 2026-11-06)');
  assert.doesNotMatch(plain.stdout, /Constraints elsewhere|Keep logs|Delete old audit logs/, 'decisions and warnings stay behind --constraints');
  const out = smd('agent', file, '--section', 'Scope', '--constraints');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /SCOPE_TEXT/);
  assert.match(out.stdout, /Constraints elsewhere in the document:\n<danger title="Never delete audit logs"> \[L\d+\]\nAUDIT_LOGS_STAY\.\n<\/danger>/);
  for (const pointer of ['accepted decision "Keep logs 30 days"', 'accepted decision "Keep logs 365 days"', 'warning "Delete old audit logs nightly"']) {
    assert.ok(out.stdout.includes(`- ${pointer} [L`), pointer);
  }
  assert.doesNotMatch(out.stdout, /Short retention|Long retention|Free the disk/, 'pointers, not text');
  assert.equal(out.stdout, agentView(conflicting, { sections: ['Scope'], constraints: true, file }).text, 'the CLI prints the library view');
});

// C05: smd agent and smd read --provenance write the manifest and leave stdout alone.

test('C05: --provenance writes a smd-projection/1 manifest and leaves stdout unchanged', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = join(root, 'provenance');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'retention.smd');
  writeFileSync(file, conflicting);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const [command, extra] of [['agent', []], ['agent', ['--section', 'Scope', '--constraints']], ['read', []], ['read', ['--outline']]] as const) {
    const label = `${command} ${extra.join(' ')}`;
    const manifest = join(dir, `${command}-${extra.length}.json`);
    const plain = smd(command, file, '--today', '2026-11-06', ...extra);
    const out = smd(command, file, '--today', '2026-11-06', ...extra, '--provenance', manifest);
    assert.equal(out.status, 0, `${label}: ${out.stderr}`);
    assert.equal(out.stdout, plain.stdout, `${label}: stdout unchanged`);
    const json = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(json.schema, 'smd-projection/1', label);
    assert.equal(json.source.sha256, sha256, label);
    assert.equal(json.source.revision, revisionOf(conflicting), label);
    assert.match(json.settings.tool, /^smd \d+\.\d+\.\d+/, label);
    assert.equal(json.settings.today, '2026-11-06', label);
    assert.equal(json.projection, extra[0] === '--outline' ? 'outline' : 'agent-view', label);
  }
  const missing = smd('agent', file, '--provenance');
  assert.notEqual(missing.status, 0, 'a manifest needs a file name');
});

// C08: the write tools refuse a change that adds a Mermaid syntax error.

/** Runs `smd mcp --allow-write` in `dir` with these tool calls and returns each call's result. */
function mcpCalls(dir: string, calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: c })),
  ];
  const res = spawnSync(process.execPath, [cli, 'mcp', '--root', dir, '--allow-write'], { input: messages.map((m) => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: 60_000 });
  assert.equal(res.status, 0, res.stderr);
  const replies = res.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result: { content: Array<{ text: string }>; isError?: boolean } });
  return calls.map((_, i) => replies.find((r) => r.id === i + 2)!.result);
}

test('C08: add_decision refuses a change that adds a Mermaid syntax error and writes nothing', { skip: !(existsSync(cli) && existsSync(join(__dirname, '..', 'dist', 'mermaid-parse.js'))) && 'run npm run build first (the Mermaid parser ships beside the bundle)' }, () => {
  // In process (tsx) the Mermaid parser is not beside src/, so only the built server checks diagrams.
  const dir = join(root, 'mermaid-write');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'plan.smd');
  writeFileSync(file, plan);
  const decision = (title: string, diagram: string) => ({ name: 'add_decision', arguments: { file: 'plan.smd', section: 'Tasks', title, body: `Flow:\n\n\`\`\`mermaid\nflowchart LR\n${diagram}\n\`\`\`` } });
  const [broken] = mcpCalls(dir, [decision('Broken diagram', '  A[open --> B')]);
  assert.equal(broken.isError, true, broken.content[0].text);
  assert.match(broken.content[0].text, /Not written[\s\S]*mermaid\/syntax/);
  assert.equal(readFileSync(file, 'utf8'), plan, 'nothing written');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  // The same change with a valid diagram is written, so the refusal was the syntax error.
  const [valid] = mcpCalls(dir, [decision('Valid diagram', '  A --> B')]);
  assert.notEqual(valid.isError, true, valid.content[0].text);
  assert.match(readFileSync(file, 'utf8'), /:::decision[^\n]* Valid diagram[\s\S]*A --> B/);
});

// C09: exact selection with duplicate titles, punctuation and custom ids.

const headed = [
  '---', 'smd: 2', 'title: Headings', '---', '',
  '## Setup', '', 'FIRST_SETUP', '',
  '## Usage', '', 'USAGE_TEXT', '',
  '### Setup', '', 'SECOND_SETUP', '',
  '## Q&A: what, why?', '', 'PUNCT_TEXT', '',
  '## Title {#custom-id}', '', 'CUSTOM_TEXT', '',
  '## Titles', '', 'PLURAL_TEXT', '',
].join('\n');

test('C09: an exact title shared by two headings selects both and is reported ambiguous; the generated id selects one', () => {
  const both = agentView(headed, { sections: ['Setup'], exactSections: true, provenance: true });
  assert.deepEqual(both.resolvedSections, [{ query: 'Setup', headings: [{ id: 'setup', text: 'Setup', line: 5 }, { id: 'setup-1', text: 'Setup', line: 13 }] }]);
  assert.match(both.text, /FIRST_SETUP[\s\S]*SECOND_SETUP/);
  assert.doesNotMatch(both.text, /USAGE_TEXT/, 'the parent of the second is not selected');
  assert.deepEqual(both.provenance!.selection!.ambiguous, ['Setup']);
  const second = agentView(headed, { sections: ['setup-1'], exactSections: true });
  assert.deepEqual(second.resolvedSections?.[0].headings.map((h) => h.id), ['setup-1']);
  assert.match(second.text, /SECOND_SETUP/);
  assert.doesNotMatch(second.text, /FIRST_SETUP/);
});

test('C09: exact selection matches a title with punctuation, by its text or its id', () => {
  for (const query of ['Q&A: what, why?', 'q&a: what, why?', 'qa-what-why']) {
    const view = agentView(headed, { sections: [query], exactSections: true });
    assert.deepEqual(view.resolvedSections?.[0].headings.map((h) => h.id), ['qa-what-why'], query);
    assert.match(view.text, /PUNCT_TEXT/, query);
  }
  assert.deepEqual(agentView(headed, { sections: ['Q&A'], exactSections: true }).missingSections, ['Q&A'], 'no prefix match');
});

test('C09: a custom heading id {#custom-id} is selected by the id and the title, not by a longer title', () => {
  for (const query of ['custom-id', 'Title']) {
    const view = agentView(headed, { sections: [query], exactSections: true });
    assert.deepEqual(view.resolvedSections, [{ query, headings: [{ id: 'custom-id', text: 'Title', line: 21 }] }], query);
    assert.match(view.text, /CUSTOM_TEXT/, query);
    assert.doesNotMatch(view.text, /PLURAL_TEXT/, query);
  }
  assert.deepEqual(agentView(headed, { sections: ['title'], exactSections: true }).missingSections, [], 'titles match without case');
  assert.deepEqual(agentView(headed, { sections: ['custom'], exactSections: true }).missingSections, ['custom']);
});
