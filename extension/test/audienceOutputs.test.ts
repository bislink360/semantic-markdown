import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentText, peopleOnly } from '../src/core/applicability';
import { indexEntry, outline } from '../src/core';
import { taskRows } from '../src/workspace';

// 6.0.0: content for people, a section marked {agent=skip} (subsections included) or a :::human block, never reaches
// an agent through any agent-facing output. No flag, selection or command lifts it.

const doc = [
  '---', 'smd: 2', 'title: Audience', '---', '',
  '## Work', '',
  '- [ ] VISIBLE-TASK @amy',
  ':::decision{#D1 status=accepted} VISIBLE-DECISION', 'Ship it.', ':::',
  ':::risk{#K1 impact=high} VISIBLE-RISK', 'It may fail.', ':::',
  ':::requirement{#R1} VISIBLE-REQ', 'Export the report.', ':::', '',
  '::::human',
  '- [ ] HUMAN-TASK @bob',
  ':::risk{#K3 impact=high} HUMAN-RISK', 'Only people see this.', ':::',
  '::::', '',
  '## Notes {agent=skip}', '',
  '- [ ] SKIPPED-TASK @bob',
  ':::decision{#D9 status=accepted} SKIPPED-DECISION', 'Old call.', ':::',
  ':::risk{#K9 impact=high} SKIPPED-RISK', 'Old risk.', ':::',
  ':::requirement{#R9} SKIPPED-REQ', 'Old requirement.', ':::', '',
  '### Deeper', '',
  '- [ ] NESTED-TASK @bob', '',
  '## After', '',
  'Visible again.', '',
].join('\n');

const HIDDEN = /HUMAN-|SKIPPED-|NESTED-|Notes|Deeper|skipped for agents/;

test('agentText blanks every line for people and keeps the line numbers', () => {
  const shown = agentText(doc);
  assert.equal(shown.split('\n').length, doc.split('\n').length);
  assert.doesNotMatch(shown, HIDDEN);
  for (const marker of ['VISIBLE-TASK', 'VISIBLE-DECISION', 'VISIBLE-RISK', 'VISIBLE-REQ', 'Visible again.']) {
    assert.equal(shown.split('\n').indexOf(doc.split('\n').find((l) => l.includes(marker))!), doc.split('\n').findIndex((l) => l.includes(marker)));
  }
  // A document with nothing for people comes back unchanged, line endings included.
  const plain = '## A\r\n\r\nText.\r\n';
  assert.equal(agentText(plain), plain);
  assert.deepEqual(peopleOnly(plain), []);
});

test('the outline and the index list no section marked {agent=skip} and count nothing for people', () => {
  const o = outline(doc);
  assert.doesNotMatch(o, HIDDEN);
  assert.match(o, /## Work\s+≈\d+\s+1 open task, decision, risk, requirement/);
  assert.match(o, /## After/);
  const entry = indexEntry(doc, 'a.smd');
  assert.deepEqual(entry.sections.map((s) => s.text), ['Work', 'After']);
  assert.equal(entry.counts.openTasks, 1);
  assert.deepEqual(entry.counts.decisions, { accepted: 1 });
  assert.equal(entry.counts.risks, 1);
});

test('task rows leave out tasks for people (CLI smd tasks and the MCP tasks tool)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-audience-'));
  try {
    const file = join(dir, 'a.smd');
    writeFileSync(file, doc);
    const rows = taskRows([file], { all: true });
    assert.deepEqual(rows.map((r) => r.text), ['VISIBLE-TASK']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const cli = join(__dirname, '..', 'dist', 'cli.js');
test('CLI: tasks, risks, trace, decisions, meta, outline, index and read never show content for people', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-audience-cli-'));
  try {
    const file = join(dir, 'a.smd');
    writeFileSync(file, doc);
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    const outputs: Record<string, string> = {
      tasks: run('tasks', file, '--all'),
      'tasks --json': run('tasks', file, '--all', '--json'),
      risks: run('risks', file, '--all'),
      'risks --json': run('risks', file, '--all', '--json'),
      trace: run('trace', file),
      decisions: run('decisions', file),
      'decisions --json': run('decisions', file, '--json'),
      meta: run('meta', file),
      outline: run('outline', file),
      index: run('index', file),
      read: run('read', file),
      'read --section Notes': run('read', file, '--section', 'Notes'),
      'agent --section Notes': run('agent', file, '--section', 'Notes'),
      'query task': run('query', 'task', file),
    };
    for (const [name, out] of Object.entries(outputs)) {
      // A section read echoes the name the caller asked for in its header, and nothing of what the section holds.
      const hidden = name.includes('--section') ? /HUMAN-|SKIPPED-|NESTED-|Deeper|Old (call|risk|requirement)/ : HIDDEN;
      assert.doesNotMatch(out, hidden, `${name} shows content for people`);
    }
    assert.match(outputs.tasks, /VISIBLE-TASK/);
    assert.match(outputs.risks, /VISIBLE-RISK/);
    assert.match(outputs.trace, /VISIBLE-REQ/);
    assert.match(outputs['decisions --json'], /VISIBLE-DECISION/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
