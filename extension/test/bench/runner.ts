import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseCounts, resetParseCache } from '../../src/core/parse';

/**
 * The benchmark runner (improvement roadmap t-03). It measures named scenarios, each a list of cases, in up to three
 * modes, and records for each:
 *
 * - latency over repeated runs: median, 95th percentile, mean, standard deviation and coefficient of variation;
 * - parse calls, cache hits and misses, and full and incremental block parses (in-process cases);
 * - file reads and distinct files read, and the stats and folder listings of discovery, all counted on `fs`;
 * - peak heap growth (in-process) or the process's peak resident memory (process cases).
 *
 * Modes. `cold` clears the parse cache and calls the case's `fresh` (a new server, say) before each run. `cached`
 * runs again on what the last run left. `incremental` makes the case's next small edit before each run. A process
 * case (CLI startup, extension activation) is a new process every time, so it has `cold` only.
 *
 * Scenarios are files in test/bench/scenarios. A task adds its own by adding a file there, without changing this one.
 * test/bench/README.md says how, and how to record a baseline before a change and compare after it.
 *
 *   npm run bench:scenarios                          every scenario, as a table
 *   npm run bench:scenarios -- --list                the scenarios and their cases
 *   npm run bench:scenarios -- --only include-reads  scenarios or cases whose "scenario / case" contains the text
 *   npm run bench:scenarios -- --runs 30 --warmup 5  timed runs per mode (default 15) and untimed runs first (3)
 *   npm run bench:scenarios -- --quick               3 runs after 1 warm-up, to check a scenario works
 *   npm run bench:scenarios -- --out before.json     also write the results, with the machine and the commit
 *   npm run bench:scenarios -- --compare before.json compare with saved results
 *   npm run bench:scenarios -- --json                the results as JSON on stdout
 */

export type Mode = 'cold' | 'cached' | 'incremental';
export const MODES: Mode[] = ['cold', 'cached', 'incremental'];

/** A case measured inside this process. `S` is what `setup` returns and every other function gets. */
export interface InProcessCase<S = unknown> {
  name: string;
  setup?: () => S;
  teardown?: (state: S) => void;
  /** Before each cold run: drop what the case keeps between runs (a server, its own caches). The parse cache is reset by the runner. */
  fresh?: (state: S) => void;
  /** Before each incremental run: make the n-th small edit (n counts from 0). A case without it has no incremental mode. */
  edit?: (state: S, n: number) => void;
  /** The work measured. It may return a promise. */
  run: (state: S) => unknown;
  /** The modes to measure, out of those the case supports. Default: all of them. */
  modes?: Mode[];
}

/** A case measured as a new Node process each run: its wall time, its file system calls and its peak memory. */
export interface ProcessCase<S = unknown> {
  name: string;
  setup?: () => S;
  teardown?: (state: S) => void;
  /** The arguments after `node` (the probe is added in front), and the folder to run in. */
  command: (state: S) => { args: string[]; cwd?: string };
  /** Numbers the process reports on its last stdout line, such as phases it timed itself. */
  metrics?: (stdout: string) => Record<string, number>;
}

export interface Scenario {
  /** Short and stable, since saved results are matched by it: lowercase words joined by hyphens. */
  name: string;
  description: string;
  /** The roadmap tasks that measure with it. */
  tasks: string[];
  kind?: 'in-process' | 'process';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cases: Array<InProcessCase<any>> | Array<ProcessCase<any>>;
}

/** Declares a scenario; the type check is all it adds. */
export const defineScenario = (scenario: Scenario): Scenario => scenario;

export interface Stats { runs: number; p50: number; p95: number; mean: number; stdev: number; cv: number; min: number; max: number }

export interface FsCounts {
  /** readFile and readFileSync calls, and the distinct paths they read. */
  fileReads: number;
  distinctFiles: number;
  /** stat, lstat and existsSync calls, and readdir calls: the work of finding files. */
  fileStats: number;
  dirListings: number;
}

export interface Counts extends FsCounts {
  parseCalls: number;
  parseHits: number;
  parseMisses: number;
  fullParses: number;
  incrementalParses: number;
}

export interface Result {
  scenario: string;
  case: string;
  mode: Mode;
  latency: Stats;
  /** From one counted run of the mode. Process cases have no parse counts. */
  counts: Counts | FsCounts;
  /** MB. In-process: the most heap one timed run added, measured from a collected heap when --expose-gc is on. Process: peak resident memory. */
  memory: { peakHeapGrowthMB?: number; peakRssMB?: number };
  metrics?: Record<string, Stats>;
}

export interface Settings { runs: number; warmup: number }

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const mb = (bytes: number) => round(bytes / 1048576, 1);
const percentile = (sorted: number[], q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];

/** Latency statistics of repeated runs. The coefficient of variation (stdev / mean) says how noisy they were. */
export function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance = sorted.length > 1 ? sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (sorted.length - 1) : 0;
  const stdev = Math.sqrt(variance);
  return {
    runs: sorted.length, p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), mean: round(mean), stdev: round(stdev),
    cv: mean > 0 ? round(stdev / mean, 3) : 0, min: round(sorted[0]), max: round(sorted.at(-1)!),
  };
}

type Patchable = Record<string, unknown>;

/** The `fs` module object itself. The `import * as fs` above is a copy whose properties can't be replaced. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs: typeof fs = require('node:fs');

/**
 * Counts file system calls until `stop()`: reads (with distinct paths), stats and folder listings, sync and async.
 * It replaces the functions on the `fs` module object, which every caller reaches at call time.
 */
export function countFileSystem(target: typeof fs = nodeFs): { stop: () => FsCounts } {
  const paths: string[] = [];
  let fileStats = 0;
  let dirListings = 0;
  const restore: Array<() => void> = [];
  const wrap = (owner: Patchable, name: string, count: (args: unknown[]) => void) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      count(args);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    owner[name] = Object.assign(wrapped, original);
    restore.push(() => { owner[name] = original; });
  };
  const read = (args: unknown[]) => paths.push(String(args[0]));
  const stat = () => { fileStats++; };
  const list = () => { dirListings++; };
  const owner = target as unknown as Patchable;
  for (const name of ['readFileSync', 'readFile']) wrap(owner, name, read);
  for (const name of ['statSync', 'lstatSync', 'existsSync', 'stat', 'lstat']) wrap(owner, name, stat);
  for (const name of ['readdirSync', 'readdir']) wrap(owner, name, list);
  const promises = target.promises as unknown as Patchable;
  wrap(promises, 'readFile', read);
  for (const name of ['stat', 'lstat']) wrap(promises, name, stat);
  wrap(promises, 'readdir', list);
  return {
    stop: () => {
      for (const undo of restore.reverse()) undo();
      return { fileReads: paths.length, distinctFiles: new Set(paths).size, fileStats, dirListings };
    },
  };
}

function zeroParseCounts(): void {
  for (const key of Object.keys(parseCounts) as Array<keyof typeof parseCounts>) parseCounts[key] = 0;
}

const gc = (globalThis as { gc?: () => void }).gc;
const settle = async (value: unknown) => {
  if (value && typeof (value as Promise<unknown>).then === 'function') await value;
};

/** The file system calls of one run. */
async function counted(run: () => unknown): Promise<FsCounts> {
  const fsCount = countFileSystem();
  try {
    await settle(run());
  } catch (err) {
    fsCount.stop();
    throw err;
  }
  return fsCount.stop();
}

/** The modes a case is measured in: those it asks for, out of those it supports. */
export function caseModes(scenario: Scenario, c: InProcessCase | ProcessCase): Mode[] {
  if (scenario.kind === 'process') return ['cold'];
  const own = c as InProcessCase;
  const supported = MODES.filter((m) => m !== 'incremental' || own.edit !== undefined);
  return own.modes ? supported.filter((m) => own.modes!.includes(m)) : supported;
}

async function measureInProcess(scenario: Scenario, c: InProcessCase, settings: Settings, modes: Mode[]): Promise<Result[]> {
  const state = c.setup?.();
  const results: Result[] = [];
  let edits = 0;
  const prepare = (mode: Mode) => {
    if (mode === 'cold') {
      resetParseCache();
      c.fresh?.(state);
    } else if (mode === 'incremental') {
      c.edit!(state, edits++);
    }
  };
  try {
    for (const mode of modes) {
      // The cached mode measures a repeat, so the run before it must be the same work.
      if (mode === 'cached') await settle(c.run(state));
      prepare(mode);
      zeroParseCounts();
      const files = await counted(() => c.run(state));
      const p = parseCounts;
      const counts: Counts = {
        parseCalls: p.calls, parseHits: p.cached, parseMisses: p.calls - p.cached, fullParses: p.full, incrementalParses: p.incremental, ...files,
      };
      for (let i = 0; i < settings.warmup; i++) {
        prepare(mode);
        await settle(c.run(state));
      }
      // Heap: what one run adds, from a collected heap when --expose-gc is on, so garbage of earlier runs is not counted.
      let peak = 0;
      const samples: number[] = [];
      for (let i = 0; i < settings.runs; i++) {
        prepare(mode);
        gc?.();
        const before = process.memoryUsage().heapUsed;
        const t0 = performance.now();
        await settle(c.run(state));
        samples.push(performance.now() - t0);
        peak = Math.max(peak, process.memoryUsage().heapUsed - before);
      }
      results.push({ scenario: scenario.name, case: c.name, mode, latency: stats(samples), counts, memory: { peakHeapGrowthMB: mb(peak) } });
    }
  } finally {
    c.teardown?.(state);
  }
  return results;
}

export const PROBE = path.join(__dirname, 'benchProbe.cjs');

/** One run of a process case: wall time, what the probe saw, and the process's stdout. */
function runProcess(command: { args: string[]; cwd?: string }): { ms: number; probe: FsCounts & { peakRssMB: number }; stdout: string } {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smd-bench-')), 'probe.json');
  try {
    const t0 = performance.now();
    const child = spawnSync(process.execPath, ['--require', PROBE, ...command.args], {
      cwd: command.cwd, encoding: 'utf8', env: { ...process.env, SMD_BENCH_PROBE: report }, windowsHide: true,
    });
    const ms = performance.now() - t0;
    if (child.status !== 0) throw new Error(`node ${command.args.join(' ')} exited with ${child.status}: ${child.stderr}`);
    return { ms, probe: JSON.parse(fs.readFileSync(report, 'utf8')), stdout: child.stdout };
  } finally {
    fs.rmSync(path.dirname(report), { recursive: true, force: true });
  }
}

function measureProcess(scenario: Scenario, c: ProcessCase, settings: Settings): Result[] {
  const state = c.setup?.();
  try {
    const command = c.command(state);
    for (let i = 0; i < settings.warmup; i++) runProcess(command); // the disk cache, not the process, warms up
    const samples: number[] = [];
    const metricSamples = new Map<string, number[]>();
    let last: ReturnType<typeof runProcess> | undefined;
    for (let i = 0; i < settings.runs; i++) {
      last = runProcess(command);
      samples.push(last.ms);
      for (const [name, value] of Object.entries(c.metrics?.(last.stdout) ?? {})) {
        if (!metricSamples.has(name)) metricSamples.set(name, []);
        metricSamples.get(name)!.push(value);
      }
    }
    const { peakRssMB, ...counts } = last!.probe;
    const metrics = metricSamples.size ? Object.fromEntries([...metricSamples].map(([k, v]) => [k, stats(v)])) : undefined;
    return [{ scenario: scenario.name, case: c.name, mode: 'cold', latency: stats(samples), counts, memory: { peakRssMB }, ...(metrics ? { metrics } : {}) }];
  } finally {
    c.teardown?.(state);
  }
}

/** Measures one scenario's cases, or those whose "scenario / case" contains `only`. */
export async function measureScenario(scenario: Scenario, settings: Settings, only?: string): Promise<Result[]> {
  const results: Result[] = [];
  for (const c of scenario.cases) {
    if (only && !`${scenario.name} / ${c.name}`.includes(only)) continue;
    if (scenario.kind === 'process') results.push(...measureProcess(scenario, c as ProcessCase, settings));
    else results.push(...await measureInProcess(scenario, c as InProcessCase, settings, caseModes(scenario, c)));
  }
  return results;
}

export const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

/** The scenarios in `dir`: each file's default export, or its `scenarios` array, in file name order. */
export function loadScenarios(dir = SCENARIOS_DIR): Scenario[] {
  const out: Scenario[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.[cm]?[jt]s$/.test(f)).sort()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(path.join(dir, file)) as { default?: Scenario; scenarios?: Scenario[] };
    const found = mod.scenarios ?? (mod.default ? [mod.default] : []);
    if (!found.length) throw new Error(`${file} exports no scenario: export default defineScenario({ … })`);
    out.push(...found);
  }
  const names = new Set<string>();
  for (const s of out) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.name)) throw new Error(`scenario name "${s.name}": lowercase words joined by hyphens`);
    if (names.has(s.name)) throw new Error(`two scenarios are named "${s.name}"`);
    names.add(s.name);
  }
  return out;
}

export interface Comparison { key: string; before: number; after: number; ratio: number; verdict: 'faster' | 'slower' | 'same'; counts: string[] }

const keyOf = (r: Pick<Result, 'scenario' | 'case' | 'mode'>) => `${r.scenario} / ${r.case} / ${r.mode}`;

/**
 * Saved results against new ones, by scenario, case and mode. A median counts as faster or slower only when it moved
 * by more than 5% and by more than twice the larger standard deviation, so ordinary noise reads as "same". Counts
 * are compared exactly and listed when they differ.
 */
export function compareResults(before: Result[], after: Result[]): Comparison[] {
  const old = new Map(before.map((r) => [keyOf(r), r]));
  const out: Comparison[] = [];
  for (const r of after) {
    const b = old.get(keyOf(r));
    if (!b) continue;
    const delta = r.latency.p50 - b.latency.p50;
    const noise = 2 * Math.max(r.latency.stdev, b.latency.stdev);
    const ratio = b.latency.p50 > 0 ? round(r.latency.p50 / b.latency.p50, 3) : 1;
    const moved = Math.abs(delta) > noise && Math.abs(ratio - 1) > 0.05;
    const counts = Object.keys(r.counts).filter((k) => (r.counts as unknown as Record<string, number>)[k] !== (b.counts as unknown as Record<string, number>)[k])
      .map((k) => `${k} ${(b.counts as unknown as Record<string, number>)[k]} → ${(r.counts as unknown as Record<string, number>)[k]}`);
    out.push({ key: keyOf(r), before: b.latency.p50, after: r.latency.p50, ratio, verdict: moved ? (delta < 0 ? 'faster' : 'slower') : 'same', counts });
  }
  return out;
}

function gitOut(args: string[]): string | undefined {
  const run = spawnSync('git', args, { cwd: __dirname, encoding: 'utf8' }); // NOSONAR(typescript:S4036): the maintainer's or CI runner's own git, found on PATH like the release scripts
  return run.status === 0 ? run.stdout.trim() : undefined;
}

/** The machine and the code the results come from. */
export function machine() {
  const cpus = os.cpus();
  return {
    node: process.version, os: `${os.type()} ${os.release()} ${process.arch}`, cpu: cpus[0]?.model.trim() ?? 'unknown', cpus: cpus.length,
    memoryGB: round(os.totalmem() / 1073741824, 1), commit: gitOut(['rev-parse', 'HEAD']) ?? null,
    dirty: (gitOut(['status', '--porcelain', '--', '.']) ?? '') !== '',
  };
}

const fixed = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

/** The results as a table, one row per scenario, case and mode. */
export function table(results: Result[]): string {
  const header = ['scenario', 'case', 'mode', 'p50 ms', 'p95 ms', 'cv', 'runs', 'parses (misses)', 'reads (distinct)', 'stats', 'listings', 'peak MB'];
  const rows = results.map((r) => {
    const c = r.counts as Partial<Counts>;
    return [
      r.scenario, r.case, r.mode, fixed(r.latency.p50), fixed(r.latency.p95), `${Math.round(r.latency.cv * 100)}%`, String(r.latency.runs),
      c.parseCalls === undefined ? '-' : `${c.parseCalls} (${c.parseMisses})`, `${c.fileReads} (${c.distinctFiles})`, String(c.fileStats), String(c.dirListings),
      String(r.memory.peakHeapGrowthMB ?? r.memory.peakRssMB),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');
  const extra = results.filter((r) => r.metrics).map((r) => `${keyOf(r)}: ${Object.entries(r.metrics!).map(([k, s]) => `${k} p50 ${fixed(s.p50)} (cv ${Math.round(s.cv * 100)}%)`).join(', ')}`);
  return [line(header), ...rows.map(line), ...(extra.length ? ['', ...extra] : [])].join('\n');
}

const argValue = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

export async function main(args: string[]): Promise<number> {
  const scenarios = loadScenarios();
  if (args.includes('--list')) {
    for (const s of scenarios) {
      console.log(`${s.name} (${s.kind ?? 'in-process'}; ${s.tasks.join(', ')}): ${s.description}`);
      for (const c of s.cases) console.log(`  ${c.name}: ${caseModes(s, c).join(', ')}`);
    }
    return 0;
  }
  const quick = args.includes('--quick');
  const settings: Settings = { runs: Number(argValue(args, '--runs') ?? (quick ? 3 : 15)), warmup: Number(argValue(args, '--warmup') ?? (quick ? 1 : 3)) };
  if (!(settings.runs >= 2) || !(settings.warmup >= 0)) throw new Error('--runs takes a number of at least 2, --warmup at least 0.');
  const only = argValue(args, '--only');
  const warn = console.warn;
  console.warn = () => undefined; // KaTeX strict-mode notes are not interesting here
  const results: Result[] = [];
  try {
    for (const s of scenarios) {
      if (only && !s.cases.some((c) => `${s.name} / ${c.name}`.includes(only))) continue;
      results.push(...await measureScenario(s, settings, only));
    }
  } finally {
    console.warn = warn;
  }
  const document = { format: 1, run: { ...machine(), settings: { ...settings, gcExposed: gc !== undefined, args }, units: { latency: 'ms', memory: 'MB' } }, results };
  const out = argValue(args, '--out');
  if (out) fs.writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(document, null, 2) + '\n');
    return 0;
  }
  const run = document.run;
  console.log(`Node ${run.node}, ${run.os}, ${run.cpu} (${run.cpus} threads), commit ${run.commit?.slice(0, 12) ?? 'unknown'}${run.dirty ? ' + local changes' : ''}`);
  console.log(`${settings.runs} timed runs per mode after ${settings.warmup} warm-up runs${gc ? '' : ' (no --expose-gc: peak heap is rougher)'}.\n`);
  console.log(table(results));
  const against = argValue(args, '--compare');
  if (against) {
    const before = (JSON.parse(fs.readFileSync(against, 'utf8')) as { results: Result[] }).results;
    console.log(`\nCompared with ${against}:`);
    for (const c of compareResults(before, results)) {
      console.log(`  ${c.verdict.padEnd(6)}  ${c.key}: ${fixed(c.before)} → ${fixed(c.after)} ms (×${c.ratio})${c.counts.length ? `; ${c.counts.join(', ')}` : ''}`);
    }
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
