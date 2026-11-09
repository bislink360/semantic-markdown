import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { agentView, estimateTokens, outline, type AgentViewOptions } from '../../src/core';
import { sectionCosts } from '../../src/core/agentView';
import { parseFrontMatter } from '../../src/core/frontmatter';
import { parseCounts, parseSmd, resetParseCache } from '../../src/core/parse';
import { readDocument } from '../../src/readView';

/**
 * Profiles the read paths: how often each call parses the document, how many included and embedded files it reads,
 * its latency (p50/p95 over warm runs) and rough heap growth. Measurement only; docs/reports/performance.md has the results.
 *
 *   npm run bench:profile                     table on stdout
 *   npm run bench:profile -- --runs 50        timed runs per call and cache state (default 30)
 *   npm run bench:profile -- --warmup 3       untimed runs first (default 5)
 *   npm run bench:profile -- --only composite only the documents whose name contains this
 *   npm run bench:profile -- --json           raw numbers, with the machine, the commit and the settings
 *
 * Each call is timed twice: `cold` clears the parse cache before every run (a fresh `smd read` process), `warm`
 * keeps it (a long-lived MCP server or editor asking again about the same text). Parse counts come from the
 * internal `parseCounts` in src/core/parse.ts.
 */

const repo = path.join(__dirname, '..', '..', '..');
const samplesDir = path.join(__dirname, '..', 'samples');
const TODAY = '2026-11-01';

/** A document: its text and the folder its relative includes and embeds resolve in. */
export interface ProfileDoc { name: string; text: string; dir: string }

export interface ProfileSettings { runs: number; warmup: number; today: string }

/** What one call did, from one run with the parse cache in a given state. */
export interface CallCounts {
  /** parseSmd calls, and how many the cache answered. */
  parseCalls: number;
  cacheHits: number;
  /** Block parses behind the misses: full parses and incremental updates. */
  fullParses: number;
  incrementalParses: number;
  /** Lines markdown-it read, and that over the document's body lines (included files count too). */
  linesParsed: number;
  documentsParsed: number;
  /** expandedFigures passes (figure numbering, which walks includes). */
  figurePasses: number;
  /** readFile calls and distinct paths (includes, and embeds with `embed`). */
  reads: number;
  distinctReads: number;
}

export interface LatencyStats { p50: number; p95: number; min: number; max: number; mean: number }

export interface CallProfile {
  name: string;
  cold: CallCounts;
  warm: CallCounts;
  latency: { cold: LatencyStats; warm: LatencyStats };
  /** MB, from process.memoryUsage around the timed runs: rough, since the garbage collector runs when it likes. */
  memory: { heapGrowth: number; peakHeapGrowth: number; rssGrowth: number };
}

export interface DocProfile {
  name: string;
  chars: number;
  lines: number;
  tokens: number;
  agentTokens: number;
  /** What `smd read` with the default budget returns for it. */
  autoShows: string;
  sectionQuery: string;
  calls: CallProfile[];
}

type Run = (text: string, options: AgentViewOptions, section: string) => unknown;

/** The calls profiled. `edits`: each run sees the text after a different small edit, as the editor does. */
const CALLS: Array<{ name: string; run: Run; edits?: true }> = [
  { name: 'readDocument full', run: (t, o) => readDocument(t, { ...o, mode: 'full' }) },
  { name: 'readDocument outline', run: (t, o) => readDocument(t, { ...o, mode: 'outline' }) },
  { name: 'agentView', run: (t, o) => agentView(t, o) },
  { name: 'agentView brief', run: (t, o) => agentView(t, { ...o, brief: true }) },
  { name: 'agentView section', run: (t, o, s) => agentView(t, { ...o, sections: [s] }) },
  { name: 'agentView maxTokens=1000', run: (t, o) => agentView(t, { ...o, maxTokens: 1000 }) },
  { name: 'agentView embed', run: (t, o) => agentView(t, { ...o, embed: true }) },
  { name: 'outline', run: (t, o) => outline(t, o) },
  { name: 'sectionCosts', run: (t, o) => sectionCosts(t, o) },
  // The status bar: a full and a brief view of the same text on every update (agentViewUi.ts).
  { name: 'editor status', run: (t, o) => [agentView(t, o), agentView(t, { ...o, brief: true })] },
  { name: 'editor status after edit', run: (t, o) => [agentView(t, o), agentView(t, { ...o, brief: true })], edits: true },
];

/** `text` with a word added to the prose line nearest its middle; `n` makes each edit different. */
export function edited(text: string, n: number): string {
  const lines = text.split('\n');
  let at = lines.length >> 1;
  while (at < lines.length - 1 && !/^[A-Za-z]/.test(lines[at])) at++;
  lines[at] = `${lines[at]} edit${n}`;
  return lines.join('\n');
}

/** A readFile for `dir` that counts its calls and the distinct paths asked for. */
function countingReader(dir: string) {
  const paths: string[] = [];
  const readFile = (rel: string): string | undefined => {
    paths.push(rel);
    try {
      return fs.readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
  return { readFile, paths };
}

function zeroCounts(): void {
  for (const key of Object.keys(parseCounts) as Array<keyof typeof parseCounts>) parseCounts[key] = 0;
}

function snapshot(paths: string[], bodyLines: number): CallCounts {
  const c = parseCounts;
  return {
    parseCalls: c.calls, cacheHits: c.cached, fullParses: c.full, incrementalParses: c.incremental, linesParsed: c.lines,
    documentsParsed: Math.round((c.lines / Math.max(bodyLines, 1)) * 100) / 100, figurePasses: c.figures,
    reads: paths.length, distinctReads: new Set(paths).size,
  };
}

/** Nearest-rank percentile of sorted values. */
const percentile = (sorted: number[], q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const mb = (bytes: number) => round(bytes / 1048576, 1);

export function stats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), min: round(sorted[0]), max: round(sorted.at(-1)!), mean: round(mean) };
}

const gc = (globalThis as { gc?: () => void }).gc;

/** Profiles one call on one document: counts from one cold and one warm run, then timed cold and warm runs. */
function profileCall(call: (typeof CALLS)[number], doc: ProfileDoc, settings: ProfileSettings, section: string, bodyLines: number): CallProfile {
  const reader = countingReader(doc.dir);
  const options: AgentViewOptions = { today: settings.today, readFile: reader.readFile };
  let edit = 0;
  const run = () => call.run(call.edits ? edited(doc.text, edit++) : doc.text, options, section);
  const counted = (): CallCounts => {
    zeroCounts();
    reader.paths.length = 0;
    run();
    return snapshot(reader.paths, bodyLines);
  };

  resetParseCache();
  const cold = counted();
  const warm = counted();
  for (let i = 0; i < settings.warmup; i++) run();

  gc?.();
  const before = process.memoryUsage();
  let peakHeap = before.heapUsed;
  const timed = (clear: boolean) => {
    const samples: number[] = [];
    for (let i = 0; i < settings.runs; i++) {
      if (clear) resetParseCache();
      const t0 = performance.now();
      run();
      samples.push(performance.now() - t0);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    return stats(samples);
  };
  const coldLatency = timed(true);
  // The first warm run follows a cold one, so the cache already holds this text (or the previous edit).
  const warmLatency = timed(false);
  const after = process.memoryUsage();
  return {
    name: call.name, cold, warm, latency: { cold: coldLatency, warm: warmLatency },
    memory: { heapGrowth: mb(after.heapUsed - before.heapUsed), peakHeapGrowth: mb(peakHeap - before.heapUsed), rssGrowth: mb(after.rss - before.rss) },
  };
}

/** Profiles every call on one document. `only` limits the calls by exact name. */
export function profileDocument(doc: ProfileDoc, settings: ProfileSettings, only?: string[]): DocProfile {
  const headings = parseSmd(doc.text).headings;
  const section = (headings.find((h) => h.level === 2) ?? headings[0])?.slug ?? '';
  const lines = doc.text.split(/\r?\n/).length;
  const bodyLines = lines - parseFrontMatter(doc.text).bodyStartLine;
  const read = readDocument(doc.text, { today: settings.today, readFile: countingReader(doc.dir).readFile });
  const calls = CALLS.filter((c) => !only || only.includes(c.name)).map((c) => profileCall(c, doc, settings, section, bodyLines));
  return {
    name: doc.name, chars: doc.text.length, lines, tokens: estimateTokens(doc.text), agentTokens: read.fullTokens, autoShows: read.shown, sectionQuery: section, calls,
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function smdFile(file: string): ProfileDoc {
  return { name: path.relative(repo, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8'), dir: path.dirname(file) };
}

/**
 * The samples' bodies one after another until about `target` tokens, as netTokens.ts builds its composites: one
 * `:::agent` block (the first), and headings made unique with ` (label + number)`.
 */
export function composite(target: number, label = ''): string {
  const bodies = fs.readdirSync(samplesDir).filter((f) => f.endsWith('.smd')).sort()
    .map((f) => fs.readFileSync(path.join(samplesDir, f), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
  const parts = [`---\nsmd: 1\ntitle: Composite ${label}\nsummary: Example documents one after another, for the profile benchmark.\nstatus: draft\n---\n`];
  let size = parts[0].length;
  let agentKept = false;
  for (let i = 0; size / 4 < target; i++) {
    const out: string[] = [];
    let fence = '';
    let skipUntil: RegExp | undefined;
    for (const line of bodies[i % bodies.length].split(/\r?\n/)) {
      if (skipUntil) {
        if (skipUntil.test(line)) skipUntil = undefined;
        continue;
      }
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f && (!fence || f[1].startsWith(fence))) fence = fence ? '' : f[1];
      const agent = fence ? null : /^(:{3,})\s*agent\b/.exec(line);
      if (agent && agentKept) {
        skipUntil = new RegExp(`^${agent[1]}\\s*$`);
        continue;
      }
      if (agent) agentKept = true;
      const h = fence ? null : /^(#{1,6})\s+(.*?)(\s*\{[^}]*\})?\s*$/.exec(line);
      out.push(h ? `${h[1]} ${h[2]} (${label}${i + 1})${h[3] ?? ''}` : line);
    }
    const part = `\n${out.join('\n')}\n`;
    parts.push(part);
    size += part.length;
  }
  return parts.join('');
}

/**
 * A root document that includes `part-a.smd` whole, which includes `part-b.smd` (two levels), plus one section of
 * `part-b.smd` directly. Written to a new folder under the OS temp folder; the caller removes it.
 */
export function includeComposite(target: number): ProfileDoc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-profile-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(path.join(samplesDir, 'src', 'pricing.ts'), path.join(dir, 'src', 'pricing.ts'));
  const partB = composite(Math.round(target / 8), 'b');
  const partA = `${composite(Math.round(target / 8), 'a')}\n:::include{file="part-b.smd"}\n:::\n`;
  const bSection = parseSmd(partB).headings.find((h) => h.level === 2)?.slug ?? '';
  const body = composite(Math.round((target * 5) / 8), 'r').split('\n');
  const middle = body.findIndex((l, i) => i > body.length / 2 && /^## /.test(l));
  body.splice(middle, 0, ':::include{file="part-a.smd"}', ':::', '');
  const root = `${body.join('\n')}\n:::include{file="part-b.smd" section="${bSection}"}\n:::\n`;
  fs.writeFileSync(path.join(dir, 'part-a.smd'), partA);
  fs.writeFileSync(path.join(dir, 'part-b.smd'), partB);
  fs.writeFileSync(path.join(dir, 'root.smd'), root);
  return { name: `composite ≈${Math.round(target / 1000)}k with includes`, text: root, dir };
}

function documents(): { docs: ProfileDoc[]; temp: string[] } {
  const docs = [
    ...['docs/rfcs/collaboration.smd', 'docs/rfcs/spec-v2.smd'].map((f) => path.join(repo, f)).filter((f) => fs.existsSync(f)),
    ...fs.readdirSync(samplesDir).filter((f) => f.endsWith('.smd')).sort().map((f) => path.join(samplesDir, f)),
  ].map(smdFile);
  for (const target of [8000, 20000, 50000]) docs.push({ name: `composite ≈${target / 1000}k`, text: composite(target), dir: samplesDir });
  const included = includeComposite(8000);
  docs.push(included);
  return { docs, temp: [included.dir] };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function gitOut(args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function machine() {
  const cpus = os.cpus();
  return {
    node: process.version,
    os: `${os.type()} ${os.release()} ${process.arch}`,
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    cpus: cpus.length,
    memoryGB: round(os.totalmem() / 1073741824, 1),
    commit: gitOut(['rev-parse', 'HEAD']) ?? null,
    dirty: (gitOut(['status', '--porcelain', '--', 'extension/src']) ?? '') !== '',
  };
}

const parses = (c: CallCounts) => `${c.fullParses}+${c.incrementalParses}`;
const ms = (n: number) => n.toFixed(1);

function table(profile: DocProfile): string {
  const header = ['call', 'parseSmd (hits)', 'parses cold', 'parses warm', 'lines ×doc', 'figures', 'reads (distinct)', 'cold p50', 'cold p95', 'warm p50', 'warm p95', 'max', 'peak heap MB'];
  const rows = profile.calls.map((c) => [
    c.name, `${c.cold.parseCalls} (${c.cold.cacheHits})`, parses(c.cold), parses(c.warm), String(c.cold.documentsParsed), String(c.cold.figurePasses),
    `${c.cold.reads} (${c.cold.distinctReads})`, ms(c.latency.cold.p50), ms(c.latency.cold.p95), ms(c.latency.warm.p50), ms(c.latency.warm.p95),
    ms(Math.max(c.latency.cold.max, c.latency.warm.max)), String(c.memory.peakHeapGrowth),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join(' | ')} |`;
  const title = `${profile.name}: ${profile.lines} lines, ≈${profile.tokens} tokens, agent view ≈${profile.agentTokens}, smd read shows ${profile.autoShows}`;
  return [title, '', line(header), `|${widths.map((w, i) => (i === 0 ? '-'.repeat(w + 2) : `${'-'.repeat(w + 1)}:`)).join('|')}|`, ...rows.map(line), ''].join('\n');
}

const argValue = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function main(args: string[]): void {
  const settings: ProfileSettings = { runs: Number(argValue(args, '--runs') ?? 30), warmup: Number(argValue(args, '--warmup') ?? 5), today: TODAY };
  if (!(settings.runs >= 1) || !(settings.warmup >= 0)) throw new Error('--runs takes a number of at least 1, --warmup at least 0.');
  const only = argValue(args, '--only');
  const { docs, temp } = documents();
  try {
    const profiles = docs.filter((d) => !only || d.name.includes(only)).map((d) => profileDocument(d, settings));
    const run = { ...machine(), settings: { ...settings, gcExposed: gc !== undefined, args }, units: { latency: 'ms', memory: 'MB' } };
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify({ run, documents: profiles }, null, 2) + '\n');
      return;
    }
    const lines = [
      `Node ${run.node}, ${run.os}, ${run.cpu} (${run.cpus} threads), commit ${run.commit ?? 'unknown'}${run.dirty ? ' + local changes' : ''}`,
      `${settings.runs} timed runs per call and cache state after ${settings.warmup} warm-up runs; ms; today ${settings.today}.`,
      'parses = full + incremental block parses; lines ×doc = lines markdown-it read / body lines (includes add to it).',
      '',
      ...profiles.map(table),
    ];
    process.stdout.write(lines.join('\n'));
  } finally {
    for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) main(process.argv.slice(2));
