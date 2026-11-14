import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { agentView, queryView } from '../../src/core';
import { readerFor } from '../../src/workspace';
import { blockAt, hidden, LAYOUT_CONTAINERS, scan, type Range, type ScannedBlock, type ScannedFile, type ScannedSection } from './scan';

/**
 * The read-contract oracle (improvement roadmap t-64). Each case under `cases/` is a folder of fixture files and a
 * `case.json` written by hand from the view laws (docs/rfcs/view-laws.smd), never from the renderer's output. The
 * oracle runs each request through a driver, then decides from the view's manifest alone:
 *
 * - which blocks appear: a block appears when a `source` span of the manifest's source map, in the block's file,
 *   overlaps the block's own lines (its lines without the containers nested in it), and the output lines that span
 *   maps hold the block's text: one of its own content lines, or the title of a container without a body, after
 *   both are normalised (line references, emphasis marks and spacing dropped). Since 4.1.0, so a manifest that maps
 *   a block to lines that do not show it fails.
 * - recall: the required blocks (`mustAppear`, from L1, L2 and L3) that appear, over the required blocks.
 * - precision: the typed blocks that appear and are required or inside the requested scope, over all typed blocks
 *   that appear. The rest is extra context (permitted, reported apart, never counted as coverage).
 * - the frontier (`mandatory.unsatisfied`) as an exact set of kinds and targets, completeness, the budget verdict and
 *   the omissions the manifest must record (L5, L6).
 *
 * Drivers: `library` calls agentView with the options and the file reader `smd agent` uses (src/cli.ts printAgentView),
 * so it runs without a build. `cli` spawns the built CLI (`dist/cli.js agent … --provenance`) and reads its stdout and
 * manifest. Both are judged by the same expectations. A route with `query` is a contract-aware query (`smd query
 * --contract`): the library driver calls queryView, the CLI driver runs `smd query <selector> <doc> --contract
 * --provenance`, which writes an array of manifests, one per document with matches.
 */

export const CASES_DIR = join(__dirname, 'cases');
export const CLI = join(__dirname, '..', '..', 'dist', 'cli.js');

export interface Route {
  sections?: string[];
  /**
   * A selector, for a contract-aware query of the document. The oracle does not evaluate selectors, so the blocks it
   * matches are listed by hand in `mustAppear` (Shown(r) of the laws).
   */
  query?: string;
  brief?: boolean;
  maxTokens?: number;
}

/** A known gap: the task that closes it and what the code does today. */
export interface ExpectedFailure {
  task: string;
  note: string;
}

/**
 * A block reference: `C1` (an id in the request's document or a file it includes), `other.smd#R7` (an id in another
 * fixture file), `## Heading` (a heading line of the document), `~MARKER` or `inc.smd~MARKER` (the innermost typed
 * block holding the line with MARKER, else the paragraph around it). `B{1..60}` stands for B1 to B60.
 */
export type Ref = string;
export type RefItem = Ref | { ref: Ref; expectedFailure?: ExpectedFailure };

export interface UnsatisfiedExpectation {
  /** One kind, or the kinds the laws allow here. */
  kind: string | string[];
  /** What the edge names. Left out: any target of that kind (at least one). */
  target?: string;
}

export interface OmissionExpectation {
  kind: string | string[];
  /** Default: the request's document. */
  file?: string;
  /** The omission's lines must contain these (with `absent`: no matching omission may overlap them). */
  lines?: Range;
  /** A heading the omission names; null: it names none. */
  heading?: string | null;
  /** The retrieve command starts with this. */
  retrieve?: string;
  /** A regular expression the reason matches (case-insensitive). */
  reason?: string;
  /** True: no omission matching the rest may be recorded. */
  absent?: boolean;
  /** Source lines the omission must list as carried into the view (t-61), each with the output lines they map to. */
  carried?: Range[];
  expectedFailure?: ExpectedFailure;
}

export interface Completeness {
  coverage: boolean;
  resolution: boolean;
  budget: boolean;
}

export type ScalarCheck = 'unsatisfied' | 'complete' | 'completeness' | 'budgetFits' | 'hiddenTargets';

export interface RequestSpec {
  name: string;
  /** The document to read, in the case folder. Default `doc.smd`. */
  doc?: string;
  route: Route;
  /** The laws the request exercises. */
  laws?: string[];
  mustAppear?: RefItem[];
  mustNotAppear?: RefItem[];
  /**
   * Blocks that belong to the view's content K(r) without each being required, such as the dependencies a limit lets
   * through when the laws do not say which ones: they count as expected for precision, not for recall.
   */
  context?: Ref[];
  /** The exact frontier: every expected entry is reported and nothing else is. */
  unsatisfied?: UnsatisfiedExpectation[];
  complete?: boolean;
  completeness?: Completeness;
  /**
   * The carried constraints, by id, that name a target hidden from agents, and those targets: exactly these, and no
   * other carried constraint marked (boundary table, t-66).
   */
  hiddenTargets?: Record<string, string[]>;
  /**
   * L4: a block's tag as the view must print it, matched as the start of one of the output lines the source map ties to
   * the block, so the check needs no knowledge of how other kinds render.
   */
  labels?: Array<{ ref: Ref; tag: string }>;
  /** L7: the same request made again gives the same view text and the same manifest, byte for byte. */
  deterministic?: boolean;
  omissions?: OmissionExpectation[];
  budgetFits?: boolean;
  xfail?: Partial<Record<ScalarCheck, ExpectedFailure>>;
}

export interface CaseSpec {
  description: string;
  requests: RequestSpec[];
  /** Expectations recorded for a later task, not checked yet. */
  todos?: ExpectedFailure[];
}

export interface LoadedCase {
  name: string;
  dir: string;
  spec: CaseSpec;
}

/** The parts of an `smd-projection/1` manifest the oracle reads. Declared here so the oracle shares no types with the renderer. */
export interface Manifest {
  sourceMap: Array<{ output: Range; kind: 'source' | 'header' | 'synthesized'; file?: string; source?: Range }>;
  omissions: Array<{
    kind: string; file: string; lines: Range; reason: string; heading?: string; retrieve?: string;
    carried?: Array<{ lines: Range; output: Range }>;
  }>;
  budget: { fits: boolean } | null;
  /** One outcome per block of the document (view laws L6, target form). */
  blocks?: Array<{ kind: string; lines: Range; outcome: string; placement: string }>;
  mandatory?: {
    unsatisfied: Array<{ kind: string; target: string }>;
    constraints?: Array<{ id?: string; hiddenTargets?: string[] }>;
    complete: boolean;
    completeness?: Completeness;
  };
}

export interface Observation {
  text: string;
  manifest: Manifest;
}

export type Driver = 'library' | 'cli';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  expectedFailure?: ExpectedFailure;
}

export type Status = 'pass' | 'xfail' | 'fail' | 'xpass';

export interface RequestResult {
  caseName: string;
  request: string;
  required: number;
  appeared: number;
  recall: number;
  precision: number;
  /** Typed blocks that appear outside the required set and the requested scope. */
  extra: string[];
  checks: CheckResult[];
  status: Status;
}

export function loadCases(dir = CASES_DIR): LoadedCase[] {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, 'case.json')))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, dir: join(dir, name), spec: JSON.parse(readFileSync(join(dir, name, 'case.json'), 'utf8')) as CaseSpec }));
}

/** As `smd agent <doc> [--section …] [--brief] [--max-tokens n] --provenance <file>` (src/cli.ts printAgentView). */
export function runLibrary(dir: string, doc: string, route: Route): Observation {
  const abs = join(dir, doc);
  if (route.query !== undefined) return runLibraryQuery(abs, doc, route.query, route);
  const result = agentView(readFileSync(abs, 'utf8'), {
    sections: route.sections,
    exactSections: false,
    brief: !!route.brief,
    includeHuman: false,
    embed: false,
    includes: true,
    lineRefs: true,
    constraints: false,
    provenance: true,
    readFile: readerFor(abs),
    file: doc,
    maxTokens: route.maxTokens,
  });
  if (!result.provenance) throw new Error('agentView returned no manifest');
  return { text: result.text, manifest: result.provenance as unknown as Manifest };
}

/** As `smd query <selector> <doc> [--brief] --contract --provenance <file>` (src/queryCommand.ts contractQuery). */
function runLibraryQuery(abs: string, doc: string, selector: string, route: Route): Observation {
  const result = queryView(readFileSync(abs, 'utf8'), selector, {
    brief: !!route.brief, lineRefs: true, provenance: true, readFile: readerFor(abs), file: doc,
  });
  if (!result?.provenance) throw new Error(`the query ${selector} matched nothing in ${doc}`);
  return { text: result.text, manifest: result.provenance as unknown as Manifest };
}

export function cliBuilt(): boolean {
  return existsSync(CLI);
}

export function runCli(dir: string, doc: string, route: Route): Observation {
  const tmp = mkdtempSync(join(tmpdir(), 'smd-conformance-'));
  const out = join(tmp, 'view.json');
  try {
    const args = route.query !== undefined
      ? [CLI, 'query', route.query, doc, '--contract']
      : [CLI, 'agent', doc, ...(route.sections ?? []).flatMap((s) => ['--section', s])];
    if (route.brief) args.push('--brief');
    if (route.maxTokens !== undefined) args.push('--max-tokens', String(route.maxTokens));
    args.push('--provenance', out);
    const run = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`smd ${args[1]} exited with ${run.status}: ${run.stderr}`);
    const written = JSON.parse(readFileSync(out, 'utf8')) as Manifest | Manifest[];
    // The query writes one manifest per document with matches; it is given one document.
    const manifest = Array.isArray(written) ? written[0] : written;
    if (!manifest) throw new Error(`smd query wrote no manifest: ${run.stderr}`);
    return { text: run.stdout, manifest };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function observe(driver: Driver, dir: string, doc: string, route: Route): Observation {
  return driver === 'cli' ? runCli(dir, doc, route) : runLibrary(dir, doc, route);
}

interface Fixture {
  dir: string;
  doc: string;
  files: Map<string, ScannedFile>;
}

function fixtureFiles(dir: string, sub = ''): string[] {
  return readdirSync(join(dir, sub)).flatMap((name) => {
    const rel = sub ? `${sub}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) return fixtureFiles(dir, rel);
    return rel.endsWith('.smd') ? [rel] : [];
  });
}

function loadFixture(dir: string, doc: string): Fixture {
  const files = new Map<string, ScannedFile>();
  for (const rel of fixtureFiles(dir)) files.set(rel, scan(rel, readFileSync(join(dir, rel), 'utf8')));
  return { dir, doc, files };
}

const normalize = (file: string) => posix.normalize(file.replace(/\\/g, '/')).replace(/^\.\//, '');

/** The files a document includes, followed through nested includes, with the include that brings each in. */
function includedFiles(fx: Fixture, from: string): Array<{ file: ScannedFile; via: ScannedBlock; viaFile: string }> {
  const out: Array<{ file: ScannedFile; via: ScannedBlock; viaFile: string }> = [];
  const seen = new Set<string>([from]);
  const walk = (name: string) => {
    const f = fx.files.get(name);
    if (!f) return;
    for (const inc of f.includes) {
      const target = normalize(posix.join(posix.dirname(name), inc.target));
      const file = fx.files.get(target);
      if (!file || seen.has(target)) continue;
      seen.add(target);
      out.push({ file, via: inc.block, viaFile: name });
      walk(target);
    }
  };
  walk(from);
  return out;
}

function resolveRef(fx: Fixture, ref: Ref): ScannedBlock {
  const doc = fx.files.get(fx.doc)!;
  const marker = /^(?:(.+?))?~(.+)$/.exec(ref);
  if (marker) {
    const file = fx.files.get(marker[1] ?? fx.doc);
    if (!file) throw new Error(`reference ${ref}: no fixture file ${marker[1]}`);
    const at = file.lines.flatMap((line, i) => (line.includes(marker[2]) ? [i + 1] : []));
    if (at.length !== 1) throw new Error(`reference ${ref}: the marker is on ${at.length} lines of ${file.file}, not one`);
    return blockAt(file, at[0]);
  }
  if (ref.startsWith('#')) {
    const text = ref.replace(/^#+\s*/, '');
    const found = doc.blocks.filter((b) => b.kind === 'heading' && b.text === text);
    if (found.length !== 1) throw new Error(`reference ${ref}: ${found.length} headings with that text in ${fx.doc}`);
    return found[0];
  }
  const qualified = /^(.+\.smd)#(.+)$/.exec(ref);
  const files = qualified ? [fx.files.get(qualified[1])] : [doc, ...includedFiles(fx, fx.doc).map((i) => i.file)];
  const id = qualified ? qualified[2] : ref;
  const found = files.flatMap((f) => f?.blocks.filter((b) => b.id === id && b.kind !== 'heading') ?? []);
  if (found.length !== 1) throw new Error(`reference ${ref}: ${found.length} blocks with that id`);
  return found[0];
}

const overlaps = (a: Range, b: Range) => a[0] <= b[1] && b[0] <= a[1];

/** The output lines that the source map says show some of the block's own lines. */
function mappedLines(obs: Observation, block: ScannedBlock): string[] {
  const out = obs.text.split('\n');
  return obs.manifest.sourceMap.filter((s) => s.kind === 'source' && s.file !== undefined && s.source !== undefined
    && normalize(s.file) === block.file && block.own.some((r) => overlaps(r, s.source!)))
    .flatMap((s) => out.slice(s.output[0] - 1, s.output[1]));
}

/** Text compared without what the projection is known to change: a line reference, emphasis marks, case and spacing. */
const plainText = (s: string) => s.replace(/\s*\[L\d+\]\s*$/, '').replace(/\{[^}]*\}\s*$/, '').replace(/[*_`~]/g, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * What of a block the output must show: its own content lines (not fences, container fences or blank lines), or,
 * for a container with no content of its own, the title after its attributes.
 */
function blockText(fx: Fixture, block: ScannedBlock): string[] {
  const lines = fx.files.get(block.file)?.lines ?? [];
  const own = block.own.flatMap(([a, b]) => lines.slice(a - 1, b));
  // The projection drops a quote's `>` (an alert is shown as a danger block) and rewrites inline directives
  // (`:depends[R6]` becomes `(depends on R6)`), so a line is compared up to its first directive.
  const comparable = (l: string) => l.replace(/^(\s*>\s?)+/, '').replace(/^\s*\[!\w+\]\s*$/, '').split(/\s:[a-z][\w-]*\[/i)[0];
  const content = own.filter((l) => l.trim() && !/^\s*(:{3,}|`{3,}|~{3,})/.test(l)).map(comparable).map(plainText).filter((l) => l.length >= 3);
  if (content.length) return content;
  const title = /^\s*:{3,}\s*[\w-]+(?:\{[^}]*\})?\s*(.*)$/.exec(own[0] ?? '')?.[1];
  return title && plainText(title).length >= 3 ? [plainText(title)] : [];
}

function appears(obs: Observation, fx: Fixture, block: ScannedBlock): boolean {
  const shown = mappedLines(obs, block);
  if (!shown.length) return false;
  const want = blockText(fx, block);
  if (!want.length) return true;
  const text = shown.map(plainText).join('\n');
  return want.some((w) => text.includes(w));
}

/**
 * L6 in its target form: every block of the document has an outcome, a block the laws require is shown or carried,
 * and a block that must stay hidden is omitted, condensed or unavailable. The manifest's blocks are matched to the
 * scanner's by line overlap, so the two need not agree on where one block ends.
 */
function checkAccounting(m: Manifest, required: ScannedBlock[], hidden: ScannedBlock[], doc: string): CheckResult {
  const blocks = m.blocks ?? [];
  const problems: string[] = blocks.filter((b) => b.outcome === 'unaccounted').map((b) => `${b.kind} L${b.lines[0]} has no outcome`);
  const touching = (sb: ScannedBlock) => blocks.filter((b) => sb.own.some((r) => overlaps(r, b.lines)))
    // The innermost manifest blocks around the scanned one decide; containers around them are judged on their own.
    .filter((b, _i, all) => !all.some((o) => o !== b && o.lines[0] >= b.lines[0] && o.lines[1] <= b.lines[1] && sb.own.some((r) => overlaps(r, o.lines))));
  for (const sb of required.filter((b) => b.file === normalize(doc))) {
    for (const b of touching(sb)) if (b.outcome !== 'shown' && b.outcome !== 'carried') problems.push(`${label(sb)} is required but its block is ${b.outcome}`);
  }
  for (const sb of hidden.filter((b) => b.file === normalize(doc))) {
    for (const b of touching(sb)) if (b.outcome === 'shown' || b.outcome === 'carried') problems.push(`${label(sb)} must stay hidden but its block is ${b.outcome}`);
  }
  return { name: 'accounting', ok: !problems.length, detail: problems.join('; ') || `${blocks.length} blocks, each with one outcome` };
}

const label = (b: ScannedBlock) => `${b.file}:${b.lines[0]} ${b.kind}${b.id ? `#${b.id}` : ''}`;
const isTyped = (b: ScannedBlock) => !['heading', 'paragraph'].includes(b.kind) && !LAYOUT_CONTAINERS.has(b.kind);

/** Typed blocks inside the requested scope that no audience mark hides (Shown(r) of the laws, without dependencies). */
function inScope(fx: Fixture, route: Route): ScannedBlock[] {
  // A query's matched blocks are listed in mustAppear, since the oracle does not evaluate selectors.
  if (route.query !== undefined) return [];
  const doc = fx.files.get(fx.doc)!;
  const queries = (route.sections ?? []).map((q) => q.toLowerCase());
  const selected = doc.sections.filter((s) => queries.includes((s.heading.text ?? '').toLowerCase()));
  const named = (s: ScannedSection) => selected.includes(s);
  const within = (line: number) => (queries.length ? selected.some((s) => s.lines[0] <= line && line <= s.lines[1]) : line >= doc.bodyStart);
  const own = doc.blocks.filter((b) => isTyped(b) && within(b.lines[0]) && !hidden(doc, b, named));
  const included = includedFiles(fx, fx.doc)
    .filter((i) => i.viaFile !== fx.doc || (within(i.via.lines[0]) && !hidden(doc, i.via, named)))
    .flatMap((i) => i.file.blocks.filter((b) => isTyped(b) && !hidden(i.file, b, () => false)));
  return [...own, ...included];
}

const kinds = (k: string | string[]) => (Array.isArray(k) ? k : [k]);
/** `B{1..3}` → B1, B2, B3. */
const expand = (ref: Ref): Ref[] => {
  const m = /^(.*)\{(\d+)\.\.(\d+)\}(.*)$/.exec(ref);
  if (!m) return [ref];
  return Array.from({ length: Number(m[3]) - Number(m[2]) + 1 }, (_, i) => `${m[1]}${Number(m[2]) + i}${m[4]}`);
};
const refOf = (item: RefItem) => (typeof item === 'string' ? item : item.ref);
const failureOf = (item: RefItem) => (typeof item === 'string' ? undefined : item.expectedFailure);

function checkUnsatisfied(m: Manifest, expected: UnsatisfiedExpectation[]): CheckResult {
  const actual = [...new Set((m.mandatory?.unsatisfied ?? []).map((u) => `${u.kind} ${u.target}`))];
  const matches = (e: UnsatisfiedExpectation, pair: string) => {
    const [kind, ...rest] = pair.split(' ');
    return kinds(e.kind).includes(kind) && (e.target === undefined || rest.join(' ') === e.target);
  };
  const missing = expected.filter((e) => !actual.some((p) => matches(e, p)));
  const unexpected = actual.filter((p) => !expected.some((e) => matches(e, p)));
  const show = (e: UnsatisfiedExpectation) => `${kinds(e.kind).join('|')} ${e.target ?? '*'}`;
  return {
    name: 'unsatisfied',
    ok: !missing.length && !unexpected.length,
    detail: `expected [${expected.map(show).join(', ')}], reported [${actual.join(', ')}]`
      + (missing.length ? `; not reported: ${missing.map(show).join(', ')}` : '')
      + (unexpected.length ? `; not expected: ${unexpected.join(', ')}` : ''),
  };
}

function checkOmission(fx: Fixture, obs: Observation, e: OmissionExpectation, index: number): CheckResult {
  const file = e.file ?? fx.doc;
  const candidates = obs.manifest.omissions.filter((o) => kinds(e.kind).includes(o.kind)
    && normalize(o.file) === file
    && (e.heading === undefined || (e.heading === null ? o.heading === undefined : o.heading === e.heading))
    // A recorded omission contains the expected lines; an absent one may not even touch them.
    && (!e.lines || (e.absent ? overlaps(o.lines, e.lines) : o.lines[0] <= e.lines[0] && o.lines[1] >= e.lines[1]))
    && (!e.retrieve || (o.retrieve ?? '').startsWith(e.retrieve))
    && (!e.reason || new RegExp(e.reason, 'i').test(o.reason)));
  const what = `${kinds(e.kind).join('|')} ${file}${e.lines ? ` L${e.lines[0]}-${e.lines[1]}` : ''}${e.heading ? ` "${e.heading}"` : ''}${e.heading === null ? ' (no heading)' : ''}`;
  const name = `omission[${index}]`;
  if (e.absent) {
    return { name, ok: candidates.length === 0, detail: `no omission ${what}; recorded ${candidates.length}`, expectedFailure: e.expectedFailure };
  }
  if (!candidates.length) return { name, ok: false, detail: `omission ${what} not recorded`, expectedFailure: e.expectedFailure };
  if (e.carried) {
    const spans = obs.manifest.sourceMap.filter((s) => s.kind === 'source' && s.file && normalize(s.file) === file && s.source);
    const good = candidates.some((o) => e.carried!.every((lines) => (o.carried ?? []).some((c) => c.lines[0] === lines[0] && c.lines[1] === lines[1]
      && spans.some((s) => overlaps(s.source!, lines) && s.output[0] <= c.output[0] && c.output[1] <= s.output[1]))));
    const got = candidates.map((o) => JSON.stringify(o.carried ?? null)).join('; ');
    return { name, ok: good, detail: `omission ${what} lists carried lines ${JSON.stringify(e.carried)} with their output lines; has ${got}`, expectedFailure: e.expectedFailure };
  }
  return { name, ok: true, detail: `omission ${what} recorded`, expectedFailure: e.expectedFailure };
}

/** Well-formed source map: spans in order, inside the view and the files, and every non-blank output line mapped. */
function checkSourceMap(fx: Fixture, obs: Observation): CheckResult {
  const outLines = obs.text.replace(/\n$/, '').split('\n');
  const problems: string[] = [];
  let last = 0;
  for (const s of obs.manifest.sourceMap) {
    if (s.output[0] < 1 || s.output[1] > outLines.length || s.output[0] > s.output[1]) problems.push(`span ${s.output} outside the view's ${outLines.length} lines`);
    if (s.output[0] <= last) problems.push(`span ${s.output} overlaps or precedes the span before`);
    last = Math.max(last, s.output[1]);
    if (s.kind === 'source' && s.file && s.source) {
      const f = fx.files.get(normalize(s.file));
      if (f && (s.source[0] < 1 || s.source[1] > f.lines.length + 1)) problems.push(`span ${s.output} maps to ${s.file}:${s.source}, outside the file`);
    }
  }
  const covered = (n: number) => obs.manifest.sourceMap.some((s) => s.output[0] <= n && n <= s.output[1]);
  const unmapped = outLines.flatMap((line, i) => (line.trim() && !covered(i + 1) ? [i + 1] : []));
  if (unmapped.length) problems.push(`output lines without a span: ${unmapped.slice(0, 8).join(', ')}${unmapped.length > 8 ? ' …' : ''}`);
  return { name: 'sourceMap', ok: !problems.length, detail: problems.join('; ') || 'well-formed, every non-blank output line mapped' };
}

export function evaluate(caseName: string, dir: string, request: RequestSpec, obs: Observation, again?: Observation): RequestResult {
  const fx = loadFixture(dir, request.doc ?? 'doc.smd');
  const m = obs.manifest;
  const checks: CheckResult[] = [checkSourceMap(fx, obs)];
  const xf = request.xfail ?? {};

  const each = (items: RefItem[] = []) => items.flatMap((item) => expand(refOf(item)).map((ref) => ({ ref, block: resolveRef(fx, ref), failure: failureOf(item) })));
  const required = each(request.mustAppear);
  for (const { ref, block, failure } of required) {
    checks.push({ name: `appears ${ref}`, ok: appears(obs, fx, block), detail: `${label(block)} lines ${block.own.map((r) => r.join('-')).join(',')}`, expectedFailure: failure });
  }
  for (const { ref, block, failure } of each(request.mustNotAppear)) {
    checks.push({ name: `hidden ${ref}`, ok: !appears(obs, fx, block), detail: `${label(block)} must not appear`, expectedFailure: failure });
  }
  if (m.blocks) checks.push(checkAccounting(m, required.map((r) => r.block), each(request.mustNotAppear).map((r) => r.block), request.doc ?? 'doc.smd'));
  if (request.unsatisfied) checks.push({ ...checkUnsatisfied(m, request.unsatisfied), expectedFailure: xf.unsatisfied });
  if (request.complete !== undefined) {
    const complete = m.mandatory?.complete ?? true;
    checks.push({ name: 'complete', ok: complete === request.complete, detail: `expected complete=${request.complete}, reported ${complete}`, expectedFailure: xf.complete });
  }
  if (request.completeness) {
    const got = m.mandatory?.completeness;
    const e = request.completeness;
    const ok = !!got && got.coverage === e.coverage && got.resolution === e.resolution && got.budget === e.budget;
    checks.push({ name: 'completeness', ok, detail: `expected ${JSON.stringify(e)}, reported ${JSON.stringify(got ?? null)}`, expectedFailure: xf.completeness });
  }
  if (request.hiddenTargets) {
    const got = Object.fromEntries((m.mandatory?.constraints ?? []).filter((c) => c.hiddenTargets?.length).map((c) => [c.id ?? '?', [...c.hiddenTargets!].sort()]));
    const want = Object.fromEntries(Object.entries(request.hiddenTargets).map(([id, t]) => [id, [...t].sort()]));
    const ok = JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(want).sort());
    checks.push({ name: 'hiddenTargets', ok, detail: `expected ${JSON.stringify(want)}, reported ${JSON.stringify(got)}`, expectedFailure: xf.hiddenTargets });
  }
  for (const { ref, tag } of request.labels ?? []) {
    const block = resolveRef(fx, ref);
    const out = obs.text.split('\n');
    const lines = m.sourceMap.filter((s) => s.kind === 'source' && s.file !== undefined && s.source !== undefined
      && normalize(s.file) === block.file && block.own.some((r) => overlaps(r, s.source!)))
      .flatMap((s) => out.slice(s.output[0] - 1, s.output[1]));
    const ok = lines.some((l) => l.startsWith(tag));
    checks.push({ name: `label ${ref}`, ok, detail: `expected a line of ${label(block)} to start with ${tag}; mapped lines: ${JSON.stringify(lines.slice(0, 3))}` });
  }
  if (request.deterministic) {
    const same = !!again && again.text === obs.text && JSON.stringify(again.manifest) === JSON.stringify(obs.manifest);
    checks.push({ name: 'deterministic', ok: same, detail: 'the same request made twice must give the same text and manifest' });
  }
  if (request.budgetFits !== undefined) {
    const fits = m.budget?.fits;
    checks.push({ name: 'budgetFits', ok: fits === request.budgetFits, detail: `expected budget.fits=${request.budgetFits}, reported ${fits}`, expectedFailure: xf.budgetFits });
  }
  (request.omissions ?? []).forEach((e, i) => checks.push(checkOmission(fx, obs, e, i)));

  // Recall over the required blocks; precision over the typed blocks that appear.
  const requiredBlocks = required.map((r) => r.block);
  const appearedRequired = requiredBlocks.filter((b) => appears(obs, fx, b));
  const context = (request.context ?? []).flatMap(expand).map((ref) => resolveRef(fx, ref));
  const expected = new Set<ScannedBlock>([...requiredBlocks, ...context, ...inScope(fx, request.route)]);
  const typed = [...fx.files.values()].flatMap((f) => f.blocks.filter(isTyped)).filter((b) => appears(obs, fx, b));
  const key = (b: ScannedBlock) => `${b.file}:${b.lines[0]}`;
  const expectedKeys = new Set([...expected].map(key));
  const extra = typed.filter((b) => !expectedKeys.has(key(b)));
  const precision = typed.length ? (typed.length - extra.length) / typed.length : 1;

  const failed = checks.filter((c) => !c.ok && !c.expectedFailure);
  const xpassed = checks.filter((c) => c.ok && c.expectedFailure);
  let status: Status = 'pass';
  if (failed.length) status = 'fail';
  else if (xpassed.length) status = 'xpass';
  else if (checks.some((c) => c.expectedFailure)) status = 'xfail';
  return {
    caseName, request: request.name, required: requiredBlocks.length, appeared: appearedRequired.length,
    recall: requiredBlocks.length ? appearedRequired.length / requiredBlocks.length : 1,
    precision, extra: extra.map(label), checks, status,
  };
}

export function runRequest(c: LoadedCase, request: RequestSpec, driver: Driver = 'library'): RequestResult {
  const obs = observe(driver, c.dir, request.doc ?? 'doc.smd', request.route);
  const again = request.deterministic ? observe(driver, c.dir, request.doc ?? 'doc.smd', request.route) : undefined;
  return evaluate(c.name, c.dir, request, obs, again);
}

export function runAll(driver: Driver = 'library', cases = loadCases()): RequestResult[] {
  return cases.flatMap((c) => c.spec.requests.map((r) => runRequest(c, r, driver)));
}
