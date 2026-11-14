import type { AgentViewResult, ResolvedSection } from './agentView';
import type { MandatoryContext } from './applicability';
import type { FollowManifest } from './read';
import type { ConstraintView } from './constraints';
import type { Section } from './sections';
import { accountBlocks, type BlockAccount } from './accounting';
import { htmlCommentLines } from './parse';
import { sha256Hex } from './sha256';
import type { TaskViewReport } from './taskViews';
import type { QueryViewBlock } from './queryView';

/**
 * Projection provenance (`agentView(text, { provenance: true })`, `smd agent --provenance <file>`): an optional,
 * machine-readable account of what a view shows and what it left out, next to the text and without changing it.
 *
 * Units: every line number here is one-based and inclusive, for people and for editors. `output` lines count lines
 * of the view's text; `source` and `lines` count lines of `file`. The document's own path is the one the caller
 * gave (`options.file`); an included or embedded file's path is relative to the document's folder, as written in
 * its `:::include` or `file="…"`.
 *
 * A hash identifies content. It doesn't prove who wrote it or that it can be trusted. Omissions say where hidden
 * content is and why it was left out, never what it says.
 */

export const PROVENANCE_SCHEMA = 'smd-projection/1';

export type OmissionKind =
  | 'skipped-section' | 'not-selected' | 'budget' | 'human' | 'details' | 'diagram' | 'code' | 'completed-tasks'
  | 'comment' | 'include' | 'embed' | 'outline' | 'deprecated' | 'dependency';

export interface Omission {
  kind: OmissionKind;
  /** The file the lines are in (see the module comment for paths). */
  file: string;
  /** One-based first and last line, inclusive. */
  lines: [number, number];
  /** Why it was left out or condensed. */
  reason: string;
  /** A section's heading text. */
  heading?: string;
  /** How many items (completed tasks). */
  count?: number;
  /** Tokens it would have cost (budget omissions). */
  tokens?: number;
  /** A command that shows it. */
  retrieve?: string;
  /** Why no command shows it, when `retrieve` is absent (t-65). */
  noRetrieve?: string;
  /**
   * Lines of the range that the view shows anyway, carried into its head (a danger, an agent block, a rule or a
   * dependency, or a danger kept out of a condensed block), and the output lines where they appear (t-61). Only on
   * `not-selected`, `budget`, `details` and `deprecated` ranges of the document that hold such blocks.
   */
  carried?: CarriedLines[];
}

/** Lines of an omitted range that the view shows elsewhere, and where (see Omission's `carried`). */
export interface CarriedLines {
  /** One-based first and last source line, in the omission's file or in `file`. */
  lines: [number, number];
  /** One-based first and last line of the view's text. */
  output: [number, number];
  /** The included file the lines are in, when an `:::include` inside the range brought them. */
  file?: string;
}

/** One emitted line and where it came from. Internal: what agentView records while it makes a view again. */
export interface TraceEntry {
  file: string;
  /** Zero-based line in `file`, and the last line it stands for (a fence's lines are all emitted at its first line). */
  line: number;
  end: number;
  /** Zero-based line of the document that the entry hangs from: its own line, or the line of the outermost include. */
  root: number;
  text: string;
  /** Whether the line is in the view's head (what it carries from elsewhere, and footnotes) or its body. */
  part?: 'head' | 'body';
}

/** Internal: where agentView records emitted lines and omissions. */
export interface Trace {
  file: string;
  /** Inside an include: the document's line of the outermost `:::include`. */
  root?: number;
  entries: TraceEntry[];
  omissions?: Omission[];
}

export interface SourceSpan {
  /** One-based first and last line of the view's text. */
  output: [number, number];
  /**
   * `source`: the lines come from `file`'s lines `source`, with styling removed. `header`: made from the front matter
   * (`source` is its lines). `synthesized`: written by the tool, e.g. labels, pointers, `<included>` wrappers.
   */
  kind: 'source' | 'header' | 'synthesized';
  file?: string;
  source?: [number, number];
}

export interface Dependency {
  /** Relative to the document's folder, as the document asks for it. */
  path: string;
  /** SHA-256 of its text, or null when it could not be read. */
  sha256: string | null;
  status: 'read' | 'unavailable';
}

export interface ProvenanceSettings {
  /** The tool and its version, e.g. `smd 3.1.0`, when the caller knows it. */
  tool?: string;
  /** The document's spec version (front matter `smd:`). */
  specVersion: number;
  sections: string[] | null;
  exactSections: boolean;
  brief: boolean;
  includeHuman: boolean;
  includes: boolean;
  embed: boolean;
  lineRefs: boolean;
  /** `fixed` when a date was given for overdue tasks, else `clock` (the date the view was made). */
  datePolicy: 'fixed' | 'clock';
  today: string | null;
  /** The tokenizer's name, or `estimate` (≈ characters / 4). */
  tokenizer: string;
  maxTokens: number | null;
  constraints: boolean;
}

export interface Provenance {
  schema: typeof PROVENANCE_SCHEMA;
  projection: 'agent-view' | 'outline';
  source: {
    file: string;
    sha256: string;
    /** The first 12 hex digits of `sha256`: the revision the MCP write tools take. */
    revision: string;
    lines: number;
    /** Included and embedded files that were read, in path order. */
    dependencies: Dependency[];
  };
  settings: ProvenanceSettings;
  /**
   * The date overdue marks, due states and lifecycle checks used, YYYY-MM-DD: `settings.today` when the caller fixed it,
   * else the UTC date the view was made on (t-68).
   */
  effectiveDate: string;
  /**
   * SHA-256 of the settings as recorded here (keys sorted, without the `tool` a CLI adds) and of the view's text, so two
   * manifests show at a glance whether they describe the same request and the same output (t-68).
   */
  digests: { settings: string; output: string };
  /** With sections: each query, the headings it selected (one-based lines), and the queries that matched none or several. */
  selection: {
    queries: string[];
    resolved: Array<{ query: string; headings: Array<{ id: string; text: string; line: number }> }>;
    missing: string[];
    ambiguous: string[];
  } | null;
  sourceMap: SourceSpan[];
  /** Everything hidden, condensed or unresolved, with a reason: the document first, then included files. */
  omissions: Omission[];
  /** Each block of the document with its one outcome in this view and where it appears (see accounting.ts, t-67). */
  blocks: BlockAccount[];
  budget: { requested: number; tokens: number; tokenizer: string; fits: boolean; condensed: boolean } | null;
  /** The view's size and the file's, counted with `tokenizer`. */
  size: { tokens: number; originalTokens: number; tokenizer: string };
  constraints: ConstraintView | null;
  /** An author task view (`--view`): the author's policy and the agent's choices apart, the paths followed, and what is unsatisfied. */
  view?: TaskViewReport;
  /** A contract-aware query (`smd query --contract`): the selector and the blocks it matched, with one-based lines. */
  query?: { selector: string; matches: QueryViewBlock[] };
  /** Only for a document with constraints or dependencies: what the view must carry and what it could not (see applicability.ts). */
  mandatory?: MandatoryContext;
  /** A read with `follow` (`smd read --follow`): the edges followed, the pointers and dependencies added, and what is unsatisfied. */
  follow?: FollowManifest;
}

/** JSON with object keys sorted at every level, so equal values give equal text and equal digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
}

/** Add an omission; HTML comments on neighbouring lines become one. */
export function addOmission(omissions: Omission[], o: Omission): void {
  const last = omissions.at(-1);
  if (o.kind === 'comment' && last?.kind === 'comment' && last.file === o.file && o.lines[0] <= last.lines[1] + 1) {
    last.lines = [last.lines[0], Math.max(last.lines[1], o.lines[1])];
    return;
  }
  omissions.push(o);
}

export interface ManifestInput {
  text: string;
  file: string;
  result: AgentViewResult;
  omissions: Omission[];
  dependencies: ReadonlyMap<string, string | undefined>;
  /** The traced lines in the order the view shows them. */
  entries: TraceEntry[];
  /** How many lines the header has at the top of the view, and how many front matter lines it is made from. */
  headerLines: number;
  frontMatterLines: number;
  sections: Section[];
  selected: Section[] | null;
  skipped: Section[];
  resolved: ResolvedSection[] | null;
  missing: string[];
  settings: Omit<ProvenanceSettings, 'datePolicy'>;
}

/** The manifest of a view (see agentView's provenanceOf for how its inputs are gathered). */
export function provenanceManifest(input: ManifestInput): Provenance {
  const { text, file, result } = input;
  const sha256 = sha256Hex(text);
  const sourceLines = text.split(/\r?\n/);
  const contents = new Map<string, string[]>([[file, sourceLines]]);
  for (const [path, content] of input.dependencies) if (content !== undefined) contents.set(path, content.split(/\r?\n/));
  const matched = matchLines(result.text, input.entries, input.headerLines);
  const own = [...input.omissions, ...sectionOmissions(input, matched)];
  addCarried(own, file, matched);
  addRecovery(own, input);
  const omissions = own.sort((a, b) =>
    Number(a.file !== file) - Number(b.file !== file) || a.file.localeCompare(b.file) || a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1]);
  const tokenizer = result.counted?.tokenizer ?? 'estimate';
  const settings: ProvenanceSettings = { ...input.settings, datePolicy: input.settings.today ? 'fixed' : 'clock' };
  return {
    schema: PROVENANCE_SCHEMA,
    projection: 'agent-view',
    source: {
      file, sha256, revision: sha256.slice(0, 12), lines: sourceLines.length,
      dependencies: [...input.dependencies].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => (
        content === undefined ? { path, sha256: null, status: 'unavailable' } : { path, sha256: sha256Hex(content), status: 'read' })),
    },
    settings,
    effectiveDate: input.settings.today ?? new Date().toISOString().slice(0, 10),
    digests: { settings: sha256Hex(canonicalJson(settings)), output: sha256Hex(result.text) },
    selection: input.resolved && {
      queries: input.resolved.map((r) => r.query),
      resolved: input.resolved.map((r) => ({ query: r.query, headings: r.headings.map((h) => ({ ...h, line: h.line + 1 })) })),
      missing: input.missing,
      ambiguous: input.resolved.filter((r) => r.headings.length > 1).map((r) => r.query),
    },
    sourceMap: sourceMap(matched, input.frontMatterLines, (f, from, to) => blankBetween(contents.get(f), from, to)),
    omissions,
    blocks: accountBlocks({ text, file, bodyStart: input.frontMatterLines, matched, omissions }),
    budget: result.budget ? {
      requested: result.budget.maxTokens, tokens: result.budget.tokens, tokenizer, fits: result.budget.fits, condensed: result.budget.condensed,
    } : null,
    size: { tokens: result.counted?.tokens ?? result.tokens, originalTokens: result.counted?.originalTokens ?? result.originalTokens, tokenizer },
    constraints: result.constraints ?? null,
    ...(result.mandatory ? { mandatory: result.mandatory } : {}),
  };
}

/** The manifest of an outline returned instead of a view (`smd read` over its budget): the view's, with the outline as text. */
export function outlineProvenance(provenance: Provenance, outlineText: string, tokens: number): Provenance {
  const { mandatory: _mandatory, ...view } = provenance;
  const lines = outlineText.replace(/\n$/, '').split('\n').length;
  const command = `smd agent ${view.source.file} --section "<heading>"`;
  return {
    ...view,
    projection: 'outline',
    digests: { ...view.digests, output: sha256Hex(outlineText) },
    sourceMap: [{ output: [1, lines], kind: 'synthesized' }],
    omissions: [{
      kind: 'outline', file: view.source.file, lines: [1, view.source.lines], retrieve: command,
      reason: 'over the read budget: the outline lists the sections, their lines and costs instead of their text',
    }],
    budget: null,
    size: { ...view.size, tokens },
    constraints: null,
  };
}

/**
 * Sections left out: marked {agent=skip}, outside the requested sections, or omitted for the budget. A range the view
 * still shows part of says which lines and where (t-61). Text above the first heading that a section read leaves out
 * is a range of its own (t-60).
 */
function sectionOmissions(input: ManifestInput, matched: ReadonlyArray<Mapped | null>): Omission[] {
  const { file, selected, sections } = input;
  const overlaps = (a: Section, b: Section) => a.start <= b.end && b.start <= a.end;
  const within = (inner: Section, outer: Section) => inner.start >= outer.start && inner.end <= outer.end;
  const read = (heading: string) => `smd agent ${file} --section "${heading.replace(/"/g, '')}"`;
  const out: Omission[] = [];
  // A section marked {agent=skip} is recorded as skipped whether or not a selection names other sections, unless it is
  // selected itself or holds a selected section (4.1.0: before, one outside the selection was only "not selected").
  const skipped = input.skipped.filter((s) => !selected?.some((sel) => sel.heading === s.heading || (overlaps(s, sel) && !within(s, sel))));
  for (const s of skipped) {
    if (skipped.some((o) => o !== s && within(s, o))) continue;
    out.push({
      kind: 'skipped-section', file, lines: [s.start + 1, s.end + 1], heading: s.heading.text, retrieve: read(s.heading.text),
      reason: 'marked {agent=skip}: meant for people',
    });
  }
  if (selected) {
    const listed: Section[] = [];
    for (const s of sections) {
      if (selected.some((sel) => overlaps(s, sel)) || listed.some((l) => within(s, l)) || skipped.some((k) => within(s, k))) continue;
      listed.push(s);
      out.push({ kind: 'not-selected', file, lines: [s.start + 1, s.end + 1], heading: s.heading.text, retrieve: read(s.heading.text), reason: 'outside the requested sections' });
    }
    // A section around a selected one: its heading and its own text outside the selection are left out too (t-67).
    const inSelected = (line: number) => selected.some((sel) => line >= sel.start && line <= sel.end);
    const isListed = (line: number) => out.some((o) => line + 1 >= o.lines[0] && line + 1 <= o.lines[1]);
    const lines = input.text.split(/\r?\n/);
    let l = sections[0]?.start ?? lines.length;
    while (l < lines.length) {
      if (inSelected(l) || isListed(l) || !lines[l].trim()) { l++; continue; }
      const holder = sections.filter((s) => l >= s.start && l <= s.end).at(-1)!;
      let end = l;
      while (end + 1 <= holder.end && !inSelected(end + 1) && !isListed(end + 1)) end++;
      while (end > l && !lines[end].trim()) end--;
      out.push({
        kind: 'not-selected', file, lines: [l + 1, end + 1], heading: holder.heading.text, retrieve: read(holder.heading.text),
        reason: 'outside the requested sections: the heading and text of a section around them',
      });
      l = end + 1;
    }
    const preamble = preambleLeftOut(input, matched);
    if (preamble) {
      out.push({
        kind: 'not-selected', file, lines: preamble, retrieve: `smd agent ${file}`,
        reason: 'text above the first heading, outside the requested sections (a read of the whole document shows it)',
      });
    }
  }
  for (const o of input.result.budget?.omitted ?? []) {
    out.push({
      kind: 'budget', file, lines: [o.line + 1, o.endLine + 1], heading: o.heading, tokens: o.tokens, retrieve: read(o.heading),
      reason: 'left out to fit the token budget',
    });
  }
  return out;
}

/** What brief views and budgets condense: a read without `--brief` and `--max-tokens` shows it. */
const CONDENSED: ReadonlySet<OmissionKind> = new Set(['details', 'diagram', 'code', 'completed-tasks', 'deprecated']);

/** Why no command shows an omission of these kinds. */
const NO_RETRIEVE: Partial<Record<OmissionKind, string>> = {
  comment: 'HTML comments are in no agent view: read the source lines',
  dependency: 'it names something the reader could not show, for the reason given',
};

/**
 * Give each omission without a command the one that shows it: the view's own command with the option that hid it
 * changed (`--include-human` for a :::human block, no `--brief` or `--max-tokens` for what they condense, `--embed`
 * for a code embed, no `--no-includes` for an include). An omission no command can show says why instead (t-65).
 */
function addRecovery(omissions: Omission[], input: ManifestInput): void {
  const s = input.settings;
  const command = (change: { human?: boolean; condensed?: boolean; embed?: boolean; includes?: boolean }) => [
    `smd agent ${input.file}`,
    ...(s.sections ?? []).map((q) => `--section "${q.replace(/"/g, '')}"`),
    ...(s.exactSections ? ['--exact'] : []),
    ...(s.brief && !change.condensed ? ['--brief'] : []),
    ...(s.includeHuman || change.human ? ['--include-human'] : []),
    ...(s.embed || change.embed ? ['--embed'] : []),
    ...(!s.includes && !change.includes ? ['--no-includes'] : []),
    ...(s.maxTokens !== null && !change.condensed ? [`--max-tokens ${s.maxTokens}`] : []),
    ...(s.constraints ? ['--constraints'] : []),
  ].join(' ');
  for (const o of omissions) {
    if (o.retrieve || o.noRetrieve) continue;
    if (o.kind === 'human') o.retrieve = command({ human: true });
    else if (CONDENSED.has(o.kind)) o.retrieve = command({ condensed: true });
    else if (o.kind === 'embed') o.retrieve = command({ embed: true });
    else if (o.kind === 'include' && !s.includes) o.retrieve = command({ includes: true });
    else if (o.kind === 'include') o.noRetrieve = 'the included file could not be read, so no command shows it';
    else o.noRetrieve = NO_RETRIEVE[o.kind] ?? 'no command shows it';
  }
}

/** Omissions of a range of the document whose blocks a view may still carry (see Omission's `carried`). */
const CARRYING: ReadonlySet<OmissionKind> = new Set(['not-selected', 'budget', 'details', 'deprecated']);

/** Add to each omitted range of the document the lines the view shows anyway, and where (t-61). */
function addCarried(omissions: Omission[], file: string, matched: ReadonlyArray<Mapped | null>): void {
  for (const o of omissions) {
    if (!CARRYING.has(o.kind) || o.file !== file) continue;
    // A condensed block's pointer stands on its opening line: it is the condensed block, not content carried out of it.
    const pointer = o.kind === 'details' || o.kind === 'deprecated' ? o.lines[0] - 1 : undefined;
    const carried = carriedIn(o.lines, file, matched.map((m) => (m && m.file === file && m.line === pointer ? null : m)));
    if (carried.length) o.carried = carried;
  }
}

/** Whether the view shows a zero-based line of the document: as source, or as included content that hangs from it. */
const showsLine = (matched: ReadonlyArray<Mapped | null>, file: string, line: number) =>
  matched.some((m) => m?.kind === 'source' && ((m.file === file && line >= m.line! && line <= m.end!) || m.root === line));

/**
 * The one-based lines of text above the first heading that a section read leaves out, from the first to the last line
 * of it the view doesn't show. Blank lines, HTML comments, fence lines and blocks the view carries are not text left
 * out, so a preamble of only those, or no preamble, gives nothing.
 */
function preambleLeftOut(input: ManifestInput, matched: ReadonlyArray<Mapped | null>): [number, number] | undefined {
  const all = input.text.split(/\r?\n/);
  const end = input.sections[0]?.start ?? all.length;
  // HTML comments are in no view: block-level ones as the parse reads them, and ones inside a line.
  const comments = htmlCommentLines(input.text);
  const inComment = (line: number) => comments.some(([a, b]) => line >= a && line < b);
  const left: number[] = [];
  for (let i = input.frontMatterLines; i < end; i++) {
    const raw = all[i].replace(/<!--.*?-->/g, '').trim();
    if (!raw || inComment(i) || /^:{3,}$/.test(raw) || showsLine(matched, input.file, i)) continue;
    left.push(i);
  }
  return left.length ? [left[0] + 1, left.at(-1)! + 1] : undefined;
}

/**
 * The lines of a one-based range of the document that the view shows anyway, as runs of neighbouring output lines: the
 * document's own lines, or an included file's when an `:::include` in the range brought them.
 */
function carriedIn(range: [number, number], file: string, matched: ReadonlyArray<Mapped | null>): CarriedLines[] {
  const runs: CarriedLines[] = [];
  let last: { run: CarriedLines; k: number } | undefined;
  matched.forEach((m, k) => {
    if (m?.kind !== 'source' || m.root === undefined || m.root + 1 < range[0] || m.root + 1 > range[1]) return;
    const from = m.file === file ? undefined : m.file;
    // Neighbouring output lines, a blank line between them at most, from the same file make one run.
    if (last && last.run.file === from && k <= last.k + 2) {
      last.run.output[1] = k + 1;
      last.run.lines = [Math.min(last.run.lines[0], m.line! + 1), Math.max(last.run.lines[1], m.end! + 1)];
      last.k = k;
      return;
    }
    const run: CarriedLines = { lines: [m.line! + 1, m.end! + 1], output: [k + 1, k + 1], ...(from ? { file: from } : {}) };
    runs.push(run);
    last = { run, k };
  });
  return runs;
}

/** A container fence (`:::tabs`, `:::`): layout that the view shows as nothing or as a label. */
const FENCE_LINE = /^\s*:{3,}/;

/**
 * Whether every line strictly between `from` and `to` (zero-based) of a file is blank or a container fence, so a span
 * may run across them; false when the file is unknown and the lines aren't neighbours.
 */
function blankBetween(lines: string[] | undefined, from: number, to: number): boolean {
  if (!lines) return to <= from + 1;
  for (let i = from + 1; i < to; i++) if (lines[i]?.trim() && !FENCE_LINE.test(lines[i])) return false;
  return true;
}

/** How far ahead in the traced lines an output line is looked for. */
const LOOKAHEAD = 200;

/** A line of the view matched to a traced line, with its zero-based `line`, `end` and `root` (see TraceEntry); null when blank. */
interface Mapped { kind: SourceSpan['kind']; file?: string; line?: number; end?: number; root?: number; part?: 'head' | 'body' }

/** Match the view's lines to the traced lines, in order. */
function matchLines(text: string, entries: TraceEntry[], headerLines: number): Array<Mapped | null> {
  const out = text.replace(/\n$/, '').split('\n');
  const mapped: Array<Mapped | null> = [];
  let next = 0;
  for (let k = 0; k < out.length; k++) {
    if (k < headerLines) { mapped.push({ kind: 'header' }); continue; }
    if (!out[k].trim()) { mapped.push(null); continue; }
    const limit = Math.min(entries.length, next + LOOKAHEAD);
    let q = next;
    // The view is trimmed as a whole, so its first line may have lost the indentation it was traced with.
    while (q < limit && entries[q].text !== out[k] && !(k === 0 && entries[q].text.trimStart() === out[k])) q++;
    if (q < limit) {
      mapped.push({ kind: 'source', file: entries[q].file, line: entries[q].line, end: entries[q].end, root: entries[q].root, part: entries[q].part });
      next = q + 1;
    } else {
      mapped.push({ kind: 'synthesized' });
    }
  }
  return mapped;
}

/**
 * Join neighbouring matched lines into spans. Lines of the same file join when only blank source lines lie between
 * them, so a span never claims a line the view left out.
 */
function sourceMap(mapped: ReadonlyArray<Mapped | null>, frontMatterLines: number, blank: (file: string, from: number, to: number) => boolean): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let last: { span: SourceSpan; end: number } | undefined;
  for (let k = 0; k < mapped.length; k++) {
    const m = mapped[k];
    if (!m) continue;
    const joins = last && last.span.kind === m.kind && (m.kind !== 'source'
      || (last.span.file === m.file && m.line! >= last.span.source![0] - 1 && (m.line! <= last.end || blank(m.file!, last.end, m.line!))));
    if (joins && last) {
      last.span.output[1] = k + 1;
      if (m.kind === 'source') {
        last.end = Math.max(last.end, m.end!);
        last.span.source![1] = last.end + 1;
      }
      continue;
    }
    const span: SourceSpan = { output: [k + 1, k + 1], kind: m.kind };
    if (m.kind === 'source') Object.assign(span, { file: m.file, source: [m.line! + 1, m.end! + 1] });
    if (m.kind === 'header' && frontMatterLines) span.source = [1, frontMatterLines];
    spans.push(span);
    last = { span, end: m.end ?? 0 };
  }
  return spans;
}
