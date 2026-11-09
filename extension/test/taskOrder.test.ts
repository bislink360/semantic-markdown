import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acyclicPrerequisites, checkMermaid, extractTasks, ganttDocument, orderByPrerequisites, taskPrerequisites, tasksToGantt, type MermaidParse, type TaskExportRow,
} from '../src/core';
import { compareTasks } from '../src/taskGroups';

/**
 * Tasks in the order of their declared prerequisites (`:depends[…]` naming a task's `{#id}`): `smd tasks --order deps`
 * and the Gantt export (semantic tags R47, R49).
 */

const TODAY = '2026-09-01';
const v2 = (body: string) => `---\nsmd: 2\ntitle: T\n---\n\n## Tasks\n\n${body}\n`;
const rowsOf = (text: string, file = 'plan.smd'): TaskExportRow[] => extractTasks(text, TODAY).map((t) => ({ ...t, file }));
const sorted = (text: string, file?: string) => rowsOf(text, file).map((r) => ({ ...r, file: r.file! })).sort(compareTasks);
const titles = (rows: Array<{ text: string }>) => rows.map((r) => r.text);

const PLAN = v2([
  '- [ ] Ship it :priority[P0] :depends[build] {#ship}',
  '- [ ] Write docs :priority[P1]',
  '- [ ] Build it :priority[P2] :depends[spec] {#build}',
  '- [ ] Spec it :priority[P3] {#spec}',
  '- [ ] Unrelated :priority[P1]',
].join('\n'));

test('orderByPrerequisites puts each task after the tasks it depends on, else keeps the order given', () => {
  const rows = sorted(PLAN);
  assert.deepEqual(titles(rows), ['Ship it', 'Write docs', 'Unrelated', 'Build it', 'Spec it'], 'priority order');
  assert.deepEqual(titles(orderByPrerequisites(rows)), ['Write docs', 'Unrelated', 'Spec it', 'Build it', 'Ship it']);
  assert.deepEqual(taskPrerequisites(rows), [[3], [], [], [4], []]);
});

test('orderByPrerequisites leaves rows without task prerequisites as they are', () => {
  const rows = sorted(v2('- [ ] B :priority[P1] :depends[R1]\n- [ ] A :priority[P0]\n- [ ] C :depends[nothing]'));
  assert.deepEqual(titles(orderByPrerequisites(rows)), titles(rows));
  assert.deepEqual(orderByPrerequisites([]), []);
});

test('orderByPrerequisites keeps a dependency cycle in its order, after what the cycle depends on, and never loops', () => {
  const text = v2([
    '- [ ] A :priority[P0] :depends[b] {#a}',
    '- [ ] B :priority[P1] :depends[c] {#b}',
    '- [ ] C :priority[P2] :depends[a,base] {#c}',
    '- [ ] Self :priority[P1] :depends[self] {#self}',
    '- [ ] Base :priority[P3] {#base}',
    '- [ ] After the cycle :priority[P0] :depends[a]',
  ].join('\n'));
  const rows = sorted(text);
  assert.deepEqual(titles(rows), ['A', 'After the cycle', 'B', 'Self', 'C', 'Base']);
  assert.deepEqual(titles(orderByPrerequisites(rows)), ['Self', 'Base', 'A', 'B', 'C', 'After the cycle']);
});

test('orderByPrerequisites resolves ids within a file, and an id two tasks give names neither', () => {
  const a = sorted(v2('- [ ] Later :priority[P0] :depends[first]\n- [ ] Elsewhere first :priority[P1] {#other}'), 'a.smd');
  const b = sorted(v2('- [ ] First :priority[P2] {#first}'), 'b.smd');
  const rows = [...a, ...b].sort(compareTasks);
  assert.deepEqual(titles(orderByPrerequisites(rows)), titles(rows), 'first is in another file');
  const twice = sorted(v2('- [ ] Later :priority[P0] :depends[x]\n- [ ] One :priority[P1] {#x}\n- [ ] Two :priority[P2] {#x}'));
  assert.deepEqual(titles(orderByPrerequisites(twice)), ['Later', 'One', 'Two']);
});

test('orderByPrerequisites handles long chains without recursion', () => {
  const n = 20000;
  const rows = Array.from({ length: n }, (_, i) => ({
    text: `T${i}`, line: i, id: `t${i}`, done: false, section: null, assignees: [], file: 'plan.smd', ...(i + 1 < n ? { depends: [`t${i + 1}`] } : {}),
  }));
  const ordered = orderByPrerequisites(rows);
  assert.equal(ordered.length, n);
  assert.equal(ordered[0].text, `T${n - 1}`);
  assert.equal(ordered[n - 1].text, 'T0');
});

// --- Gantt --------------------------------------------------------------------------------------------------------

const GANTT = v2([
  '- [ ] Ship it @maya :due[2026-10-10] :depends[spec] {#ship}',
  '- [x] Spec it :due[2026-10-01] {#spec}',
  '- [ ] Announce :due[2026-10-20] :depends[ship,spec]',
  '- [ ] Too early :due[2026-09-15] :depends[ship]',
  '- [ ] Undated prerequisite :due[2026-10-05] :depends[nodate]',
  '- [ ] No date {#nodate}',
].join('\n'));

test('R49: the Gantt chart orders a task after what it depends on and starts it "after" them', () => {
  assert.equal(tasksToGantt(rowsOf(GANTT)), [
    'gantt',
    '  title Tasks',
    '  dateFormat YYYY-MM-DD',
    '  section plan.smd',
    '    Spec it :done, milestone, spec, 2026-10-01, 0d',
    '    Undated prerequisite :milestone, 2026-10-05, 0d',
    '    Ship it @maya :ship, after spec, 2026-10-10',
    '    Too early :milestone, 2026-09-15, 0d',
    '    Announce :after spec ship, 2026-10-20',
    '',
  ].join('\n'));
});

test('R49: a Gantt chart without dependencies between charted tasks is unchanged', () => {
  const text = v2('- [ ] A :due[2026-10-02] :depends[R1] {#a}\n- [ ] B :due[2026-10-01] {#b}');
  assert.equal(tasksToGantt(rowsOf(text)), 'gantt\n  title Tasks\n  dateFormat YYYY-MM-DD\n  section plan.smd\n    B :milestone, 2026-10-01, 0d\n    A :milestone, 2026-10-02, 0d\n');
});

test('R49: Gantt ids are the task ids when Mermaid can read them, else task-N', () => {
  const text = v2([
    '- [ ] Done word :due[2026-10-01] {#done}',
    '- [ ] Under :due[2026-10-01] {#a_b}',
    '- [ ] Then :due[2026-10-03] :depends[done,a_b]',
  ].join('\n'));
  const chart = tasksToGantt(rowsOf(text));
  assert.match(chart, /^ {4}Done word :milestone, task-1, 2026-10-01, 0d$/m);
  assert.match(chart, /^ {4}Under :milestone, a_b, 2026-10-01, 0d$/m);
  assert.match(chart, /^ {4}Then :after task-1 a_b, 2026-10-03$/m);
  // Two files with the same id: each gets its own Mermaid id, and each file's tasks link within it.
  const two = tasksToGantt([...rowsOf(GANTT, 'a.smd'), ...rowsOf(GANTT, 'b.smd')]);
  assert.match(two, /section a.smd\n {4}Spec it :done, milestone, task-1, 2026-10-01, 0d\n {4}Undated prerequisite :milestone, 2026-10-05, 0d\n {4}Ship it @maya :task-2, after task-1, 2026-10-10/);
  assert.match(two, /section b.smd\n {4}Spec it :done, milestone, task-3, 2026-10-01, 0d\n {4}Undated prerequisite :milestone, 2026-10-05, 0d\n {4}Ship it @maya :task-4, after task-3, 2026-10-10/);
});

test('R19: :depends[plan.smd#T1] orders a task after a task of another listed file, resolved from its own folder', () => {
  const plan = v2('- [ ] Build it {#T1}');
  const ops = v2('- [ ] Deploy :depends[../plan/plan.smd#T1]\n- [ ] Other');
  const rows = [...rowsOf(ops, 'docs/ops/ops.smd'), ...rowsOf(plan, 'docs/plan/plan.smd')];
  assert.deepEqual(taskPrerequisites(rows), [[2], [], []]);
  assert.deepEqual(titles(orderByPrerequisites(rows)), ['Other', 'Build it', 'Deploy']);
  // A file that isn't listed, or rows without a file, order nothing.
  assert.deepEqual(taskPrerequisites(rowsOf(ops, 'docs/ops/ops.smd')), [[], []]);
  assert.deepEqual(taskPrerequisites([...rowsOf(ops, ''), ...rowsOf(plan, '')]), [[], [], []]);
  // Backslashes in a host's paths name the same file.
  assert.deepEqual(taskPrerequisites([...rowsOf(ops, 'docs\\ops\\ops.smd'), ...rowsOf(plan, 'docs\\plan\\plan.smd')]), [[2], [], []]);
});

test('R19, R49: the Gantt chart starts a task after a dated task of another file', () => {
  const plan = v2('- [ ] Build it :due[2026-10-01] {#T1}');
  const ops = v2('- [ ] Deploy :due[2026-10-05] :depends[plan.smd#T1]');
  const chart = tasksToGantt([...rowsOf(ops, 'ops.smd'), ...rowsOf(plan, 'plan.smd')]);
  assert.match(chart, /section ops.smd\n {4}Deploy :after T1, 2026-10-05\n {2}section plan.smd\n {4}Build it :milestone, T1, 2026-10-01, 0d/);
});

test('R49: tasks of a dependency cycle due the same day draw no "after" between them', () => {
  const text = v2([
    '- [ ] A :due[2026-10-01] :depends[b] {#a}',
    '- [ ] B :due[2026-10-01] :depends[a] {#b}',
    '- [ ] C :due[2026-10-03] :depends[a]',
  ].join('\n'));
  assert.deepEqual(acyclicPrerequisites(rowsOf(text)), [[], [], [0]]);
  const chart = tasksToGantt(rowsOf(text));
  assert.match(chart, /^ {4}A :milestone, a, 2026-10-01, 0d$/m);
  assert.match(chart, /^ {4}B :milestone, 2026-10-01, 0d$/m);
  assert.match(chart, /^ {4}C :after a, 2026-10-03$/m);
});

const bundle = path.join(__dirname, '..', 'dist', 'mermaid-parse.js');
test('R49: the Gantt chart with dependencies parses with the bundled Mermaid parser', { skip: !fs.existsSync(bundle) && 'run npm run build first' }, async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require(bundle) as { parse: MermaidParse };
  for (const chart of [tasksToGantt(rowsOf(GANTT)), tasksToGantt([...rowsOf(GANTT, 'a.smd'), ...rowsOf(GANTT, 'b.smd')])]) {
    assert.deepEqual(await checkMermaid(ganttDocument(chart), parse), [], chart);
  }
});

// --- CLI ----------------------------------------------------------------------------------------------------------

// Requires `npm run build`.
const cli = path.join(__dirname, '..', 'dist', 'cli.js');
const smd = (...args: string[]) => spawnSync(process.execPath, [cli, 'tasks', ...args], { encoding: 'utf8' });

test('CLI: smd tasks --order deps lists prerequisites first; the default order is unchanged', { skip: !fs.existsSync(cli) && 'run npm run build first' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-order-'));
  try {
    const file = path.join(dir, 'plan.smd');
    fs.writeFileSync(file, PLAN);
    const run = (...args: string[]) => smd(file, '--today', TODAY, ...args).stdout;
    const names = (out: string) => out.split('\n').filter(Boolean).map((l) => /(Write docs|Unrelated|Spec it|Build it|Ship it)/.exec(l)?.[1]);
    assert.deepEqual(names(run()), ['Ship it', 'Write docs', 'Unrelated', 'Build it', 'Spec it']);
    assert.equal(run('--order', 'priority'), run());
    const byDeps = run('--order', 'deps');
    assert.deepEqual(names(byDeps), ['Write docs', 'Unrelated', 'Spec it', 'Build it', 'Ship it']);
    assert.match(byDeps, /plan\.smd:8 {2}\[ \] \[P0\] Ship it \(depends on build; BLOCKED by build\) \{#ship\}  — Tasks\n$/);
    const json = JSON.parse(smd(file, '--today', TODAY, '--order', 'deps', '--json').stdout) as Array<{ text: string }>;
    assert.deepEqual(json.map((r) => r.text), ['Write docs', 'Unrelated', 'Spec it', 'Build it', 'Ship it']);
    const bad = smd(file, '--order', 'topo');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--order is priority \(the default\) or deps, not "topo"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
