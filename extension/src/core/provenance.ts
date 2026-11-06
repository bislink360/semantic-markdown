import type { AgentViewResult, ResolvedSection } from './agentView';
import type { ConstraintView } from './constraints';
import type { Section } from './sections';
import { sha256Hex } from './sha256';

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
  | 'comment' | 'include' | 'embed' | 'outline';

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
  budget: { requested: number; tokens: number; tokenizer: string; fits: boolean; condensed: boolean } | null;
  /** The view's size and the file's, counted with `tokenizer`. */
  size: { tokens: number; originalTokens: number; tokenizer: string };
  constraints: ConstraintView | null;
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
  const omissions = [...input.omissions, ...sectionOmissions(input)].sort((a, b) =>
    Number(a.file !== file) - Number(b.file !== file) || a.file.localeCompare(b.file) || a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1]);
  const tokenizer = result.counted?.tokenizer ?? 'estimate';
  return {
    schema: PROVENANCE_SCHEMA,
    projection: 'agent-view',
    source: {
      file, sha256, revision: sha256.slice(0, 12), lines: sourceLines.length,
      dependencies: [...input.dependencies].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => (
        content === undefined ? { path, sha256: null, status: 'unavailable' } : { path, sha256: sha256Hex(content), status: 'read' })),
    },
    settings: { ...input.settings, datePolicy: input.settings.today ? 'fixed' : 'clock' },
    selection: input.resolved && {
      queries: input.resolved.map((r) => r.query),
      resolved: input.resolved.map((r) => ({ query: r.query, headings: r.headings.map((h) => ({ ...h, line: h.line + 1 })) })),
      missing: input.missing,
      ambiguous: input.resolved.filter((r) => r.headings.length > 1).map((r) => r.query),
    },
    sourceMap: sourceMap(result.text, input.entries, input.headerLines, input.frontMatterLines, (f, from, to) => blankBetween(contents.get(f), from, to)),
    omissions,
    budget: result.budget ? {
      requested: result.budget.maxTokens, tokens: result.budget.tokens, tokenizer, fits: result.budget.fits, condensed: result.budget.condensed,
    } : null,
    size: { tokens: result.counted?.tokens ?? result.tokens, originalTokens: result.counted?.originalTokens ?? result.originalTokens, tokenizer },
    constraints: result.constraints ?? null,
  };
}

/** The manifest of an outline returned instead of a view (`smd read` over its budget): the view's, with the outline as text. */
export function outlineProvenance(view: Provenance, outlineText: string, tokens: number): Provenance {
  const lines = outlineText.replace(/\n$/, '').split('\n').length;
  const command = `smd agent ${view.source.file} --section "<heading>"`;
  return {
    ...view,
    projection: 'outline',
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

/** Sections left out: marked {agent=skip}, outside the requested sections, or omitted for the budget. */
function sectionOmissions(input: ManifestInput): Omission[] {
  const { file, selected, sections } = input;
  const overlaps = (a: Section, b: Section) => a.start <= b.end && b.start <= a.end;
  const within = (inner: Section, outer: Section) => inner.start >= outer.start && inner.end <= outer.end;
  const read = (heading: string) => `smd agent ${file} --section "${heading.replace(/"/g, '')}"`;
  const out: Omission[] = [];
  const skipped = input.skipped.filter((s) => !selected?.some((sel) => sel.heading === s.heading) && (!selected || selected.some((sel) => within(s, sel))));
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
      if (selected.some((sel) => overlaps(s, sel)) || listed.some((l) => within(s, l))) continue;
      listed.push(s);
      out.push({ kind: 'not-selected', file, lines: [s.start + 1, s.end + 1], heading: s.heading.text, retrieve: read(s.heading.text), reason: 'outside the requested sections' });
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

interface Mapped { kind: SourceSpan['kind']; file?: string; line?: number; end?: number }

/**
 * Match the view's lines to the traced lines, in order, and join neighbouring lines into spans. Lines of the same file
 * join when only blank source lines lie between them, so a span never claims a line the view left out.
 */
function sourceMap(
  text: string, entries: TraceEntry[], headerLines: number, frontMatterLines: number, blank: (file: string, from: number, to: number) => boolean,
): SourceSpan[] {
  const out = text.replace(/\n$/, '').split('\n');
  const mapped: Array<Mapped | null> = [];
  let next = 0;
  for (let k = 0; k < out.length; k++) {
    if (k < headerLines) { mapped.push({ kind: 'header' }); continue; }
    if (!out[k].trim()) { mapped.push(null); continue; }
    const limit = Math.min(entries.length, next + LOOKAHEAD);
    let q = next;
    while (q < limit && entries[q].text !== out[k]) q++;
    if (q < limit) {
      mapped.push({ kind: 'source', file: entries[q].file, line: entries[q].line, end: entries[q].end });
      next = q + 1;
    } else {
      mapped.push({ kind: 'synthesized' });
    }
  }
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
