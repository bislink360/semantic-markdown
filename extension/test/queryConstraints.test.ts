// smd query --constraints and the CLI side of --follow (filtering S1, S2, G3, G5; research AF15, AC-D).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { documentConstraints, parseSelector, querySmd } from '../src/core';
import { runQuery, type QueryFlags } from '../src/queryCommand';
import { collect, queryRows, querySummary, queryText } from '../src/workspace';

const TODAY = '2026-11-07';
const flags = (more: Partial<QueryFlags> = {}): QueryFlags => ({ json: false, titles: false, brief: false, lineRefs: true, today: TODAY, ...more });

const RULES = [
  '---', 'smd: 2', 'title: Rules', '---',
  ':::constraint{#C0} Above every heading, so document-wide', ':::',
  '## Plan', '',
  ':::agent Read the plan with the rules', 'Never skip the review.', ':::',
  ':::decision{status=accepted} Ship weekly', 'Fine.', ':::',
  ':::constraint{#C1 scope=document} Keep the API stable', ':::',
  ':::constraint{#C2} Only for this section', ':::',
  '## Notes {agent=skip}', '',
  ':::agent Hidden from agents', 'x', ':::',
  ':::human', ':::constraint{#C3 scope=document} People only', ':::', ':::',
  '',
].join('\n');
const PLAIN = ['---', 'title: Plain', '---', '## Decisions', '', ':::decision{status=accepted} Use Postgres', 'Yes.', ':::', ''].join('\n');

function workspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-query-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('S1: documentConstraints lists agent blocks and document-wide constraints, leaving out skipped, human-only and matched ones', () => {
  const matches = querySmd(RULES, 'decision', { today: TODAY });
  assert.deepEqual(documentConstraints(RULES, matches, { today: TODAY }).map((b) => `${b.type}:${b.title}`), [
    'constraint:Above every heading, so document-wide', 'agent:Read the plan with the rules', 'constraint:Keep the API stable',
  ]);
  // A match that holds the agent block already shows it.
  assert.deepEqual(documentConstraints(RULES, querySmd(RULES, 'heading[title=Plan]', { today: TODAY }), { today: TODAY }).map((b) => b.title), ['Above every heading, so document-wide']);
});

test('S1: without --constraints the output is the released one, plus one line for a document that has agent blocks or constraints', () => {
  const dir = workspace({ 'rules.smd': RULES, 'plain.smd': PLAIN });
  try {
    const files = collect(dir);
    const out = runQuery('decision', [dir], flags());
    const rows = queryRows(files, [{ type: 'decision', tests: [] }], { today: TODAY });
    const note = `[smd] ${path.join(dir, 'rules.smd')}: 1 agent block and 2 document-wide constraints not included. Add --constraints to include them.`;
    // plain.smd comes first: its part is exactly the released text, then rules.smd's part ends with the note.
    assert.equal(out.stdout, `${queryText(rows, false).trimEnd()}\n\n${note}\n`);
    assert.equal(out.stderr, `[smd] ${querySummary(rows, 2)}\n`);
    assert.equal(out.code, 0);
    // --titles: the note is one more line.
    assert.equal(runQuery('decision', [dir], flags({ titles: true })).stdout, `${queryText(rows, true)}${note}\n`);
    // A document with neither: byte for byte the released output.
    assert.equal(runQuery('decision', [path.join(dir, 'plain.smd')], flags()).stdout, queryText(queryRows([path.join(dir, 'plain.smd')], [{ type: 'decision', tests: [] }], { today: TODAY }), false));
    // --json keeps the released array (no ancestors) and puts the note on stderr.
    const json = runQuery('decision', [dir], flags({ json: true }));
    assert.deepEqual(JSON.parse(json.stdout), rows);
    assert.equal(json.stderr, `${note}\n[smd] ${querySummary(rows, 2)}\n`);
    // Nothing matches: no output, exit code 1, as before.
    assert.deepEqual(runQuery('risk', [dir], flags()), { code: 1, stdout: '', stderr: '[smd] 0 match(es) in 0 of 2 file(s).\n' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T7, S1: on the samples, output without the new options is the released output plus the S1 note lines', () => {
  const samples = path.join(__dirname, 'samples');
  const files = collect(samples);
  for (const selector of ['decision', 'risk[impact>=high]', 'task[done=false]', 'heading[level=2]', 'question, api', '*[owner]']) {
    for (const titles of [false, true]) {
      const out = runQuery(selector, [samples], flags({ titles }));
      const without = out.stdout.replace(/\[smd\] [^\n]*not included\. Add --constraints to include them\.\n*/g, '');
      const released = queryText(queryRows(files, parseSelector(selector), { today: TODAY }), titles);
      assert.equal(without.trimEnd(), released.trimEnd(), `${selector} ${titles}`);
      assert.ok(without.endsWith('\n'));
    }
  }
});

test('S1, S2: --constraints adds the agent blocks and document-wide constraints, never skipped or human-only ones', () => {
  const dir = workspace({ 'rules.smd': RULES });
  try {
    const out = runQuery('decision', [dir], flags({ constraints: true }));
    assert.match(out.stdout, /Agent blocks and document-wide constraints of .*rules\.smd, which apply to every match in it:/);
    assert.match(out.stdout, /<agent-instructions title="Read the plan with the rules">|Never skip the review\./);
    assert.match(out.stdout, /rules\.smd:5-6\n/);
    assert.match(out.stdout, /rules\.smd:15-16 {2}— Plan\n/);
    assert.doesNotMatch(out.stdout, /Only for this section|Hidden from agents|People only|not included/);
    assert.match(out.stderr, /^\[smd\] 1 match\(es\) in 1 of 1 file\(s\)\. 3 agent block\(s\) and document constraint\(s\) included\.\n$/);
    const json = JSON.parse(runQuery('decision', [dir], flags({ constraints: true, json: true })).stdout);
    assert.deepEqual(json.constraints[0].blocks.map((b: { title: string }) => b.title), ['Above every heading, so document-wide', 'Read the plan with the rules', 'Keep the API stable']);
    assert.equal(json.constraints[0].included, true);
    assert.deepEqual(json.matches[0].ancestors, [{ type: 'heading', line: 6, title: 'Plan', id: 'plan' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G5, AC-D: --follow reads other files inside the paths given, and denies those outside without showing them', () => {
  const a = [
    '---', 'smd: 2', 'title: A', '---', '## Work', '',
    ':::requirement{#R1} Do it', 'See [B](b.smd#b), [secret](../outside/secret.smd) and [gone](gone.smd).', ':::',
    ':::include{file="../outside/secret.smd"}', ':::',
    '',
  ].join('\n');
  const dir = workspace({ 'docs/a.smd': a, 'docs/b.smd': '---\ntitle: B\n---\n## B\n\nText of B.\n', 'outside/secret.smd': '---\ntitle: Secret\n---\nTop secret words.\n' });
  try {
    // Only docs/a.smd is given: docs/b.smd is outside it, so denied too.
    const one = runQuery('requirement, include', [path.join(dir, 'docs', 'a.smd')], flags({ follow: '*' }));
    assert.match(one.stdout, /-> link {6} {2}denied {2}b\.smd#b/);
    // The folder: B is read, the secret stays denied and its words never show, the missing file is missing.
    const out = runQuery('requirement, include', [path.join(dir, 'docs')], flags({ follow: '*' }));
    assert.match(out.stdout, /-> link {6} {2}heading {2}B {2}.*b\.smd \[L4\] {2}≈\d+ tokens/);
    assert.match(out.stdout, /-> link {6} {2}denied {2}\.\.\/outside\/secret\.smd/);
    assert.match(out.stdout, /-> link {6} {2}missing {2}gone\.smd {2}\(not found\)/);
    assert.match(out.stdout, /Unsatisfied dependency: include "\.\.\/outside\/secret\.smd" from L10 .*\(denied\)\./);
    assert.doesNotMatch(out.stdout, /Top secret|Secret/);
    assert.match(out.stderr, /Incomplete: 1 unsatisfied dependency\.\n$/);
    assert.equal(out.code, 0);
    const json = JSON.parse(runQuery('requirement', [path.join(dir, 'docs')], flags({ follow: 'link', json: true })).stdout);
    assert.deepEqual(json.edges.map((e: { target: string; status: string }) => `${e.target}=${e.status}`), ['b.smd#b=resolved', '../outside/secret.smd=denied', 'gone.smd=missing']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G3: --follow, --direction and --depth say what is wrong with their values', () => {
  const dir = workspace({ 'a.smd': PLAIN });
  try {
    const err = (more: Partial<QueryFlags>) => runQuery('decision', [dir], flags(more));
    assert.match(err({ follow: 'supercedes' }).stderr, /Unknown edge type "supercedes"\. Did you mean "supersedes"\?/);
    assert.equal(err({ follow: 'supercedes' }).code, 2);
    assert.match(err({ follow: '*', direction: 'up' }).stderr, /--direction takes out, in or both/);
    assert.match(err({ follow: '*', depth: '4' }).stderr, /--depth takes 1, 2 or 3/);
    assert.match(err({ depth: '2' }).stderr, /--direction and --depth go with --follow/);
    assert.match(err({ follow: '*' }).stderr, /^\[smd\] 1 match\(es\) in 1 of 1 file\(s\)\. 0 neighbor\(s\) as pointers \(≈0 tokens not read\)\. ≈\d+ tokens shown\.\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
