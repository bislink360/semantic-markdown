// smd query --contract and the MCP query tool's `contract`: the blocks a selector matches, with what a section read
// carries (view laws L1 to L3, completeness). The plain query output stays as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentView, queryView } from '../src/core';
import { Sandbox, smdTools } from '../src/mcp';
import { runQuery, type QueryFlags } from '../src/queryCommand';

const TODAY = '2026-11-12';
const flags = (more: Partial<QueryFlags> = {}): QueryFlags => ({ json: false, titles: false, brief: false, lineRefs: true, today: TODAY, ...more });

// The ledger runbook of the read-contract article: R1's prerequisite R2 sits in Prepare, the rule C2 on R1 sits in
// Rules and depends on R2, C3 binds Prepare, and the danger sits above the first heading.
const RUNBOOK = [
  '---', 'smd: 2', 'title: Ledger migration runbook', 'status: approved', '---',
  ':::danger Money safety', 'Never replay a settlement batch.', ':::',
  ':::constraint{#C1 scope=document} Change window', 'Run every step inside the approved change window.', ':::',
  '',
  '## Prepare',
  ':::requirement{#R2 status=accepted} Snapshot the ledger', 'Take a snapshot and record its id before any write.', ':::',
  ':::constraint{#C3} Read replica only', 'Run the preparation queries on the read replica.', ':::',
  '',
  '## Rules',
  ':::constraint{#C2 applies-to=R1 depends-on=R2} Snapshot age', 'Start the cutover only when the snapshot is under ten minutes old.', ':::',
  ':::decision{#D1 status=superseded} Dual write for a week', 'Write to both ledgers for seven days.', ':::',
  ':::decision{#D2 status=accepted supersedes=D1} Single cutover', 'Switch writes in one step.', ':::',
  '',
  '## Cutover',
  ':::requirement{#R1 status=accepted depends-on=R2} Switch writes', 'Point the writer at the new ledger.', ':::',
  ':::agent', 'Stop and ask a person when a check fails.', ':::',
  '',
  '## History {agent=skip}',
  'The 2024 attempt and why it was rolled back.',
  '',
].join('\n');

function workspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-contract-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function inWorkspace<T>(files: Record<string, string>, run: (dir: string) => T): T {
  const dir = workspace(files);
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ids = (xs: ReadonlyArray<{ id?: string }> | undefined) => (xs ?? []).map((x) => x.id ?? '?').sort();

test('contract query: R1 of the ledger runbook carries what the section read of Cutover carries', () => {
  const contract = queryView(RUNBOOK, 'requirement[id=R1]', { file: 'runbook.smd', today: TODAY })!;
  const section = agentView(RUNBOOK, { sections: ['Cutover'], file: 'runbook.smd', today: TODAY });
  assert.deepEqual(ids(contract.mandatory?.constraints), ['C1', 'C2', 'C3']);
  assert.deepEqual(ids(contract.mandatory?.constraints), ids(section.mandatory?.constraints));
  assert.deepEqual(ids(contract.mandatory?.dependencies), ['R2']);
  assert.deepEqual(ids(contract.mandatory?.dependencies), ids(section.mandatory?.dependencies));
  assert.deepEqual(contract.mandatory?.unsatisfied, []);
  assert.deepEqual(contract.mandatory?.completeness, { coverage: true, resolution: true, budget: true });
  for (const text of [contract.text, section.text]) {
    assert.match(text, /<danger title="Money safety">[^]*Never replay a settlement batch\./);
    assert.match(text, /Stop and ask a person when a check fails\./);
    assert.match(text, /<constraint id="C1"[^]*<constraint id="C3"[^]*<constraint id="C2"/);
    assert.match(text, /Dependencies of the selected content:\n<requirement id="R2"/);
    assert.doesNotMatch(text, /2024 attempt/);
  }
  // The matched block under its heading, and not the rest of the runbook.
  assert.match(contract.text, /\(excerpt — query: requirement\[id=R1\]; 1 block\)/);
  assert.match(contract.text, /## Cutover {2}\[L32\]\n<requirement id="R1"/);
  assert.doesNotMatch(contract.text, /Single cutover|Dual write/);
  assert.deepEqual(contract.matches.map((m) => m.attrs.id), ['R1']);
});

test('contract query: --constraints and --follow leave out what --contract carries for R1', () => {
  inWorkspace({ 'runbook.smd': RUNBOOK }, (dir) => {
    const file = path.join(dir, 'runbook.smd');
    const shown = (out: string) => ['C1', 'C2', 'C3', 'R2'].filter((id) => new RegExp(`id="${id}"`).test(out));
    const plain = runQuery('requirement[id=R1]', [file], flags({ constraints: true }));
    assert.deepEqual(shown(plain.stdout), ['C1']);
    assert.doesNotMatch(plain.stdout, /Money safety/);
    const follow = runQuery('requirement[id=R1]', [file], flags({ constraints: true, follow: '*' }));
    assert.deepEqual(shown(follow.stdout), ['C1', 'C2', 'R2']);
    assert.doesNotMatch(follow.stdout, /Money safety/);
    const contract = runQuery('requirement[id=R1]', [file], flags({ contract: true }));
    assert.equal(contract.code, 0);
    assert.deepEqual(shown(contract.stdout), ['C1', 'C2', 'C3', 'R2']);
    assert.match(contract.stdout, /Money safety/);
    assert.match(contract.stdout, /Stop and ask a person/);
    assert.match(contract.stderr, /^\[smd\] 1 match\(es\) in 1 of 1 file\(s\)\. With the read contract: 3 constraint\(s\) and 1 dependency carried, ≈\d+ tokens shown, complete\.\n$/);
  });
});

test('contract query: without --contract the selector output is byte for byte what it was', () => {
  inWorkspace({ 'runbook.smd': RUNBOOK }, (dir) => {
    const out = runQuery('requirement[id=R1]', [path.join(dir, 'runbook.smd')], flags());
    const where = path.join(dir, 'runbook.smd');
    assert.equal(out.stdout, [
      `${where}:33-35  — Cutover`, '<requirement id="R1" status="accepted" depends-on="R2"> Switch writes', 'Point the writer at the new ledger.', '</requirement>', '',
      `[smd] ${where}: 1 agent block and 1 document-wide constraint not included. Add --constraints to include them.`, '',
    ].join('\n'));
    assert.equal(out.stderr, '[smd] 1 match(es) in 1 of 1 file(s).\n');
    assert.equal(out.manifests, undefined);
    // --provenance is ignored without --contract, as it always was.
    assert.equal(runQuery('requirement[id=R1]', [where], flags({ provenance: true })).manifests, undefined);
  });
});

test('contract query (L2): a scope=section rule of the section around the match applies; one of a sibling section does not', () => {
  const doc = [
    '---', 'title: Ops', '---',
    '## Operations',
    ':::constraint{#COPS} Two people on every change', ':::',
    '### Cutover',
    ':::constraint{#CCUT} Announce the cutover', ':::',
    ':::requirement{#R1} Switch writes', ':::',
    '### Rollback',
    ':::constraint{#CRB} Keep the old ledger warm', ':::',
    ':::requirement{#R9} Roll back', ':::',
    '',
  ].join('\n');
  const view = queryView(doc, 'requirement[id=R1]', { today: TODAY })!;
  assert.deepEqual(ids(view.mandatory?.constraints), ['CCUT', 'COPS']);
  assert.ok(view.mandatory?.constraints.every((c) => c.applies === 'section'));
  assert.doesNotMatch(view.text, /Keep the old ledger warm|Roll back/);
  // As the section read of Cutover has it.
  assert.deepEqual(ids(agentView(doc, { sections: ['Cutover'], today: TODAY }).mandatory?.constraints), ['COPS']);
  assert.match(agentView(doc, { sections: ['Cutover'], today: TODAY }).text, /Announce the cutover/);
});

test('contract query (L2, L3): an unresolved rule target and a missing dependency make the view incomplete, by part', () => {
  const doc = [
    '---', 'title: Frontier', '---',
    '## Work',
    ':::requirement{#R1 depends-on=R404} Do the work', ':::',
    '## Rules',
    ':::constraint{#CX applies-to=NOPE} A rule whose target is gone', ':::',
    ':::constraint{#CY} Binds only Rules', ':::',
    '',
  ].join('\n');
  inWorkspace({ 'doc.smd': doc }, (dir) => {
    const file = path.join(dir, 'doc.smd');
    const out = runQuery('requirement[id=R1]', [file], flags({ contract: true, json: true }));
    const json = JSON.parse(out.stdout);
    assert.equal(json.complete, false);
    assert.deepEqual(json.completeness, { coverage: true, resolution: false, budget: true });
    const [document] = json.documents;
    assert.deepEqual(document.matches, [{ type: 'requirement', title: 'Do the work', id: 'R1', line: 5, endLine: 6, section: 'Work' }]);
    assert.deepEqual(document.mandatory.constraints.map((c: { id: string; applies: string }) => `${c.id} ${c.applies}`), ['CX unplaced']);
    assert.deepEqual(document.mandatory.unsatisfied.map((u: { kind: string; target: string }) => `${u.kind} ${u.target}`).sort(), ['missing R404', 'unresolved-target NOPE']);
    assert.match(document.text, /Not satisfied:\n[^]*\[incomplete: resolution failed for 1 rule target and 1 dependency\]/);
    assert.match(out.stderr, /\[smd\] warning: incomplete view of .*doc\.smd, resolution failed for 1 rule target and 1 dependency/);
    assert.doesNotMatch(out.stderr, /complete\./);
  });
});

test('contract query (L1): dangers and agent blocks of hidden parts stay out, those of other sections come in', () => {
  const doc = [
    '---', 'title: Audience', '---',
    '## Work',
    ':::task-list', ':::',
    ':::requirement{#R1} Do it', ':::',
    '## Elsewhere',
    '> [!CAUTION]', '> Back up first.',
    ':::non-goals', '- No rewrite.', ':::',
    '## Archive {agent=skip}',
    ':::danger Old danger', 'Gone.', ':::',
    ':::human', ':::agent', 'Not for agents.', ':::', ':::',
    '',
  ].join('\n');
  const view = queryView(doc, 'requirement[id=R1]', { today: TODAY })!;
  assert.match(view.text, /Back up first\./);
  assert.match(view.text, /No rewrite\./);
  assert.doesNotMatch(view.text, /Old danger|Not for agents/);
});

test('contract query: several documents, --provenance manifests, and the options it does not go with', () => {
  const other = ['---', 'title: Other', '---', '## Plan', ':::requirement{#R7} Another', ':::', ''].join('\n');
  inWorkspace({ 'a/runbook.smd': RUNBOOK, 'b/other.smd': other, 'c/none.smd': '# Nothing\n' }, (dir) => {
    const out = runQuery('requirement', [dir], flags({ contract: true, provenance: true }));
    assert.equal(out.code, 0);
    const heads = out.stdout.split('\n').filter((l) => l.startsWith('==> '));
    assert.deepEqual(heads.map((l) => path.basename(l.slice(4, -4))), ['runbook.smd', 'other.smd']);
    assert.match(out.stderr, /3 match\(es\) in 2 of 3 file\(s\)/);
    assert.equal(out.manifests?.length, 2);
    assert.deepEqual(out.manifests?.[0].query, {
      selector: 'requirement',
      matches: [
        { type: 'requirement', title: 'Snapshot the ledger', id: 'R2', line: 14, endLine: 16, section: 'Prepare' },
        { type: 'requirement', title: 'Switch writes', id: 'R1', line: 33, endLine: 35, section: 'Cutover' },
      ],
    });
    assert.ok(out.manifests?.[0].mandatory);
    // A single document's view is printed as it is, with no file line.
    const one = runQuery('requirement[id=R7]', [dir], flags({ contract: true }));
    assert.ok(one.stdout.startsWith('# Other\n'));
    assert.equal(runQuery('risk', [dir], flags({ contract: true })).code, 1);
    for (const more of [{ follow: '*' }, { titles: true }]) {
      const bad = runQuery('requirement', [dir], flags({ contract: true, ...more }));
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /does not go with it/);
    }
  });
});

test('contract query: the MCP query tool takes contract, and keeps its plain output without it', async () => {
  const dir = workspace({ 'docs/runbook.smd': RUNBOOK });
  try {
    const query = smdTools(new Sandbox(dir)).find((t) => t.name === 'query')!;
    assert.ok('contract' in (query.inputSchema.properties ?? {}));
    const contract = await query.run({ selector: 'requirement[id=R1]', contract: true });
    assert.match(contract, /^# Ledger migration runbook\n/);
    assert.match(contract, /Stop and ask a person[^]*<constraint id="C3"[^]*<requirement id="R2"[^]*Money safety/);
    assert.match(contract, /\n\n1 match\(es\) in 1 of 1 file\(s\)\. With the read contract: 3 constraint\(s\) and 1 dependency carried, ≈\d+ tokens shown, complete\.\n$/);
    const plain = await query.run({ selector: 'requirement[id=R1]' });
    assert.match(plain, /^docs\/runbook\.smd:33-35 {2}— Cutover\n<requirement id="R1"/);
    assert.doesNotMatch(plain, /Money safety/);
    await assert.rejects(async () => query.run({ selector: 'requirement', contract: true, titles: true }), /does not go with "titles"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
