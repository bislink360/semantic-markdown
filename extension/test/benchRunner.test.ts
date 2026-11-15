import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSmd } from '../src/core/parse';
import {
  caseModes, compareResults, countFileSystem, defineScenario, loadScenarios, measureScenario, stats, type Counts, type Result,
} from './bench/runner';

/** The benchmark runner (improvement roadmap t-03). */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs: typeof fs = require('node:fs');
const built = fs.existsSync(path.join(__dirname, '..', 'dist', 'cli.js')) && fs.existsSync(path.join(__dirname, '..', 'dist', 'extension.js'));

test('t-03: latency statistics give the median, the 95th percentile and the variance of repeated runs', () => {
  const s = stats([10, 12, 11, 13, 9, 30]);
  assert.deepEqual([s.runs, s.p50, s.p95, s.min, s.max, s.mean], [6, 11, 30, 9, 30, 14.17]);
  assert.equal(s.stdev, 7.88, 'sample standard deviation');
  assert.ok(Math.abs(s.cv - s.stdev / s.mean) < 0.002, 'standard deviation over the mean');
  assert.deepEqual(stats([5]), { runs: 1, p50: 5, p95: 5, mean: 5, stdev: 0, cv: 0, min: 5, max: 5 });
});

test('t-03: file system calls are counted while a run lasts, and the functions are put back after it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-bench-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    const original = nodeFs.readFileSync;
    const count = countFileSystem();
    nodeFs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
    nodeFs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
    nodeFs.existsSync(path.join(dir, 'b.txt'));
    nodeFs.statSync(dir);
    nodeFs.readdirSync(dir);
    assert.deepEqual(count.stop(), { fileReads: 2, distinctFiles: 1, fileStats: 2, dirListings: 1 });
    assert.equal(nodeFs.readFileSync, original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('t-03: a case is measured cold, cached and after edits, with parse counts, file reads and its own preparation', async () => {
  const calls: string[] = [];
  let text = '# A\n\nOne.\n';
  const scenario = defineScenario({
    name: 'synthetic', description: 'test', tasks: [],
    cases: [{
      name: 'parse',
      setup: () => { calls.push('setup'); return 'state'; },
      teardown: (s: string) => { calls.push(`teardown ${s}`); },
      fresh: () => { calls.push('fresh'); },
      edit: (_s: string, n: number) => { calls.push(`edit ${n}`); text = `# A\n\nOne ${n}.\n`; },
      run: () => { calls.push('run'); return parseSmd(text); },
    }],
  });
  const results = await measureScenario(scenario, { runs: 3, warmup: 1 });
  assert.deepEqual(results.map((r) => r.mode), ['cold', 'cached', 'incremental']);
  const [cold, cached, incremental] = results.map((r) => r.counts as Counts);
  assert.deepEqual([cold.parseCalls, cold.parseMisses, cold.fullParses], [1, 1, 1], 'cold: the parse cache is cleared first');
  assert.deepEqual([cached.parseCalls, cached.parseHits, cached.parseMisses], [1, 1, 0], 'cached: the same text again');
  assert.deepEqual([incremental.parseMisses, incremental.incrementalParses], [1, 1], 'incremental: an edit updates the parse');
  assert.equal(results.every((r) => r.latency.runs === 3), true);
  assert.equal(calls[0], 'setup');
  assert.equal(calls.at(-1), 'teardown state');
  // Cold: fresh before each of 1 counted, 1 warm-up and 3 timed runs.
  assert.equal(calls.filter((c) => c === 'fresh').length, 5);
  assert.deepEqual(calls.filter((c) => c.startsWith('edit')), ['edit 0', 'edit 1', 'edit 2', 'edit 3', 'edit 4']);
});

test('t-03: process cases have only cold runs, and a case without edits has no incremental mode', () => {
  const inProcess = defineScenario({ name: 'a', description: '', tasks: [], cases: [{ name: 'x', run: () => 0 }, { name: 'y', run: () => 0, edit: () => 0, modes: ['incremental'] }] });
  assert.deepEqual(caseModes(inProcess, inProcess.cases[0]), ['cold', 'cached']);
  assert.deepEqual(caseModes(inProcess, inProcess.cases[1]), ['incremental']);
  const process = defineScenario({ name: 'b', description: '', tasks: [], kind: 'process', cases: [{ name: 'x', command: () => ({ args: [] }) }] });
  assert.deepEqual(caseModes(process, process.cases[0]), ['cold']);
});

test('t-03: the shared scenarios ship, and a task adds its own by adding a file, without changing the runner', async () => {
  const shipped = loadScenarios();
  for (const name of ['workspace-discovery', 'references-rename', 'include-reads', 'cli-startup', 'extension-activation', 'rule-chain', 'protected-budget']) {
    const s = shipped.find((x) => x.name === name);
    assert.ok(s, `${name} ships`);
    assert.ok(s.cases.length > 0 && s.description && s.tasks.every((t) => /^t-\d+$/.test(t)), `${name} is described`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-bench-scenarios-'));
  try {
    const runner = path.join(__dirname, 'bench', 'runner').replaceAll('\\', '/');
    fs.writeFileSync(path.join(dir, 'graph-traversal.ts'), [
      `import { defineScenario } from '${runner}';`,
      `export default defineScenario({ name: 'graph-traversal', description: 'a task scenario', tasks: ['t-17'], cases: [{ name: 'walk', run: () => [1, 2, 3].map((n) => n * 2) }] });`,
    ].join('\n'));
    const [own] = loadScenarios(dir);
    assert.equal(own.name, 'graph-traversal');
    const results = await measureScenario(own, { runs: 2, warmup: 0 });
    assert.deepEqual(results.map((r) => `${r.case} ${r.mode}`), ['walk cold', 'walk cached']);
    fs.writeFileSync(path.join(dir, 'z.ts'), `export default { name: 'Bad Name', description: '', tasks: [], cases: [] };`);
    assert.throws(() => loadScenarios(dir), /lowercase words joined by hyphens/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const result = (p50: number, stdev: number, counts: Partial<Counts> = {}): Result => ({
  scenario: 's', case: 'c', mode: 'cold', latency: { ...stats([p50]), stdev },
  counts: { parseCalls: 1, parseHits: 0, parseMisses: 1, fullParses: 1, incrementalParses: 0, fileReads: 3, distinctFiles: 1, fileStats: 0, dirListings: 0, ...counts },
  memory: {},
});

test('t-03: a comparison calls a change faster or slower only when it is beyond the noise, and lists changed counts', () => {
  assert.equal(compareResults([result(100, 5)], [result(104, 5)])[0].verdict, 'same', 'within twice the standard deviation');
  assert.equal(compareResults([result(100, 1)], [result(103, 1)])[0].verdict, 'same', 'under 5%');
  assert.equal(compareResults([result(100, 5)], [result(60, 5)])[0].verdict, 'faster');
  const slower = compareResults([result(100, 5)], [result(150, 5, { fileReads: 1, parseMisses: 0 })])[0];
  assert.deepEqual([slower.verdict, slower.ratio, slower.counts], ['slower', 1.5, ['parseMisses 1 → 0', 'fileReads 3 → 1']]);
});

test('t-03: every shared in-process scenario runs, with the counts its tasks need', { timeout: 120_000 }, async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    for (const s of loadScenarios().filter((x) => x.kind !== 'process')) {
      const [first] = await measureScenario({ ...s, cases: s.cases.slice(0, 1) as typeof s.cases }, { runs: 2, warmup: 0 });
      assert.ok(first.latency.p50 > 0, `${s.name} ran`);
    }
    const refs = await measureScenario(loadScenarios().find((x) => x.name === 'references-rename')!, { runs: 2, warmup: 0 }, 'references, 40');
    const cold = refs[0].counts as Counts;
    assert.ok(cold.fileReads >= 39 && cold.dirListings > 0 && cold.fileStats > 0 && cold.parseCalls >= 40, 'discovery, reads and parses are counted apart');
    const includes = await measureScenario(loadScenarios().find((x) => x.name === 'include-reads')!, { runs: 2, warmup: 0 }, 'validate');
    assert.equal((includes[0].counts as Counts).distinctFiles, 3, 'the included files');
  } finally {
    console.warn = warn;
  }
});

test('t-03: CLI startup and extension activation run as new processes with their peak memory', { skip: !built && 'run npm run build first', timeout: 120_000 }, async () => {
  const scenarios = loadScenarios();
  const [version] = await measureScenario(scenarios.find((x) => x.name === 'cli-startup')!, { runs: 2, warmup: 0 }, 'smd --version');
  assert.ok(version.latency.p50 > 0 && version.memory.peakRssMB! > 10);
  const [activation] = await measureScenario(scenarios.find((x) => x.name === 'extension-activation')!, { runs: 2, warmup: 0 });
  assert.ok(activation.metrics?.['load ms'].p50 && activation.metrics['activate ms'].runs === 2, 'the load and activate phases');
});
