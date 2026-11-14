import { agentView, estimateTokens, outline, type AgentViewOptions, type AgentViewResult, type ResolvedSection } from './agentView';
import { peopleOnly } from './applicability';
import { parseFrontMatter } from './frontmatter';
import {
  DocumentGraph, edgeTypes, followEdges, mandatoryClosure, MANDATORY_EDGES, nodeKey, normalizePath, resolvePath,
  type DocumentRead, type EdgeDirection, type GraphDocument, type GraphEdge, type GraphNode,
} from './graph';
import { graphLines, type MatchGraph } from './graphQuery';
import { parseSmd } from './parse';
import { outlineProvenance, type Dependency, type Omission, type Provenance, type SourceSpan } from './provenance';
import { sectionsOf } from './sections';
import { sha256Hex } from './sha256';

/**
 * `smd read`, the MCP `read` tool and the library's `readSmd`: one call that gives an agent what it should read first.
 * A document whose agent view fits the budget comes back whole; a longer one comes back as its outline (sections with
 * line ranges and token costs), so the agent asks for the sections it needs next.
 *
 * With `follow` (filtering G3 to G5), the edges of the content read are followed as `smd query --follow` follows them
 * from a match: neighbors as one-line pointers with their cost, the targets of mandatory edges (`include`,
 * `applies-to`, `depends-on`) in full with what they need in turn, and what could not be satisfied. They come after
 * the view, leave out what the view already shows, and count toward the budget. An outline follows no edges.
 */

/** Tokens below which the whole agent view is returned (the reader skill's "≲ 2,000 tokens: read it once"). */
export const READ_BUDGET = 2000;

export const READ_MODES = ['auto', 'outline', 'full'] as const;
export type ReadMode = (typeof READ_MODES)[number];

export interface ReadOptions
  extends Pick<AgentViewOptions, 'readFile' | 'today' | 'tokenizer' | 'file' | 'lineRefs' | 'exactSections' | 'constraints' | 'provenance'> {
  /** auto (default): whole view within the budget, else the outline. */
  mode?: ReadMode;
  /**
   * The threshold for `auto`, in tokens (default {@link READ_BUDGET}): the whole view at or under it, else the outline.
   * It does not cap what `full`, `outline` or `sections` return. Counted with `tokenizer` when one is given. With
   * `follow`, what following edges adds counts too.
   */
  maxTokens?: number;
  brief?: boolean;
  /** Only these sections (heading text or id); overrides the mode. */
  sections?: string[];
  /** Edge types or kinds to follow from the content read, or `*` (see edgeTypes). Throws an EdgeTypeError for an unknown one. */
  follow?: string | readonly string[];
  /** Which edges to follow: written in the content (`out`, default), pointing at it (`in`), or both. */
  direction?: EdgeDirection | 'both';
  /** Hops for pointers, 1 to 3 (default 1). Mandatory edges are followed to their closure (up to 5 hops). */
  depth?: number;
  /**
   * Reads a file the edges or the view's dependencies name, by its normalized path (see DocumentGraph), with or
   * without `follow`. Without it, following denies other files and the view reads them through `readFile`.
   */
  readDocument?: (path: string) => DocumentRead;
  /**
   * Other documents whose edges count, so that `in` finds what points at the content from them. The view and
   * following read a dependency in one of them from here first, with or without `follow`.
   */
  documents?: readonly GraphDocument[];
}

/** What following edges from the content read found (see ReadOptions.follow). */
export interface ReadFollow extends MatchGraph {
  /** The edge types followed, the direction and the depth. */
  types: string[];
  direction: EdgeDirection | 'both';
  depth: number;
  /** False when a mandatory dependency is unsatisfied, along the followed edges or in the view itself. */
  complete: boolean;
  /**
   * ≈ tokens of the text following added after the view (`shown`, counted with the tokenizer when one is given), of
   * the dependencies in it, and left out as pointers.
   */
  tokens: { shown: number; dependencies: number; pointers: number };
}

export interface ReadResult {
  /** What was returned. */
  shown: 'full' | 'outline' | 'sections';
  text: string;
  /** Estimated tokens of the whole agent view, and of the file. */
  fullTokens: number;
  fileTokens: number;
  missingSections: string[];
  /** What `auto` compared with `maxTokens`: the tokenizer's name, or `estimate` (≈ characters / 4). */
  tokenBasis: string;
  /** The same sizes counted with the tokenizer, when one is given. */
  counted?: AgentViewResult['counted'];
  /** With `sections`: the headings each query selected. */
  resolvedSections?: ResolvedSection[];
  /** With `constraints` and `sections`: the constraints outside the sections (see agentView). */
  constraints?: AgentViewResult['constraints'];
  /** For a document with constraints or dependencies: what the view carries and could not satisfy (see agentView). */
  mandatory?: AgentViewResult['mandatory'];
  /** With `provenance`: the manifest of what was returned (the outline's when the outline is shown). */
  provenance?: Provenance;
  /** With `follow`, when content is shown (not the outline): what following edges added. */
  follow?: ReadFollow;
}

export function readSmd(text: string, options: ReadOptions = {}): ReadResult {
  const { mode = 'auto', maxTokens = READ_BUDGET, brief, sections, exactSections, constraints, follow: followSpec, direction, depth, readDocument, documents, ...rest } = options;
  const view: typeof rest & Pick<AgentViewOptions, 'readDocument'> = { ...rest };
  const tokenBasis = view.tokenizer?.name ?? 'estimate';
  const types = followSpec === undefined ? null : edgeTypes(followSpec);
  const graphOptions = types ? { types, direction: direction ?? 'out', depth: Math.min(3, Math.max(1, Math.trunc(depth ?? 1))), readDocument, documents } : undefined;
  // The view reads the files its dependencies name as following does: from the documents given, then through
  // readDocument, with or without follow, so the two never disagree on what can be read. What neither has falls back
  // to readFile as before. The view's paths are relative to the document; these are normalized from where it was given.
  if (readDocument || documents?.length) {
    const here = normalizePath(view.file ?? '<file>');
    const given = new Map((documents ?? []).map((d) => [normalizePath(d.path), d.text]));
    const readFile = view.readFile;
    view.readDocument = (relative): DocumentRead => {
      const path = resolvePath(here, relative);
      const text = given.get(path);
      if (text !== undefined) return { text };
      if (readDocument) return readDocument(path);
      const read = readFile?.(relative);
      return read === undefined ? { status: 'denied' } : { text: read };
    };
  }
  if (sections?.length) {
    const result = agentView(text, { ...view, brief, sections, exactSections, constraints });
    const followed = graphOptions && followView(text, result, 'sections', { ...view, ...graphOptions });
    return withFollow({
      shown: 'sections', text: result.text, fullTokens: result.tokens, fileTokens: result.originalTokens, missingSections: result.missingSections,
      tokenBasis, ...counted(result), resolvedSections: result.resolvedSections,
      ...(result.constraints ? { constraints: result.constraints } : {}), ...(result.provenance ? { provenance: result.provenance } : {}),
      ...(result.mandatory ? { mandatory: result.mandatory } : {}),
    }, followed);
  }
  const full = agentView(text, { ...view, brief });
  const sizes = { fullTokens: full.tokens, fileTokens: full.originalTokens, missingSections: [], tokenBasis, ...counted(full) };
  const followed = graphOptions && mode !== 'outline' ? followView(text, full, 'full', { ...view, ...graphOptions }) : undefined;
  // Route on the tokenizer's count when there is one, so an exact budget means exact routing.
  const size = (full.counted?.tokens ?? full.tokens) + (followed?.report.tokens.shown ?? 0);
  if (mode === 'full' || (mode === 'auto' && size <= maxTokens)) {
    return withFollow({
      shown: 'full', text: full.text, ...sizes, ...(full.provenance ? { provenance: full.provenance } : {}), ...(full.mandatory ? { mandatory: full.mandatory } : {}),
    }, followed);
  }
  const unit = full.counted ? `${full.counted.tokenizer} tokens` : 'tokens';
  const approx = full.counted ? '' : '≈';
  const what = followed ? 'The agent view and what its followed edges add' : 'The agent view';
  const why = mode === 'auto' ? `${what} (${approx}${size} ${unit}) ${followed ? 'are' : 'is'} over the ${maxTokens}-token budget, so this is the outline. ` : '';
  const next = `${why}Read only the sections you need next.\n`;
  // The compact outline (4.1.0): the same rows and notes, without column padding.
  const outlineText = `${outline(text, { ...view, provenance: false, compactOutline: true }).trimEnd()}\n\n${next}`;
  const provenance = full.provenance && outlineProvenance(full.provenance, outlineText, view.tokenizer?.count(outlineText) ?? estimateTokens(outlineText));
  return { shown: 'outline', text: outlineText, ...sizes, ...(provenance ? { provenance } : {}) };
}

const counted = (result: AgentViewResult) => (result.counted ? { counted: result.counted } : {});

// Following edges from the content read

interface FollowInput extends Pick<AgentViewOptions, 'file' | 'today' | 'readFile' | 'tokenizer'> {
  types: string[];
  direction: EdgeDirection | 'both';
  depth: number;
  readDocument?: (path: string) => DocumentRead;
  documents?: readonly GraphDocument[];
}

interface Followed {
  report: ReadFollow;
  /** The lines added after the view, and which of them are a dependency's text (zero-based in `lines`). */
  lines: string[];
  spans: Array<{ from: number; to: number; node: GraphNode }>;
  /** For provenance: what the followed content is, one-based. */
  manifest: FollowManifest;
}

/** The provenance of what `follow` added to a read (`Provenance.follow`). Lines are one-based. */
export interface FollowManifest {
  types: string[];
  direction: EdgeDirection | 'both';
  depth: number;
  neighbors: Array<{
    direction: EdgeDirection; depth: number; edge: string; from: { file: string; line: number }; target: string; status: GraphEdge['status'];
    node: FollowNodeRef | null; shown: boolean; tokens: number;
  }>;
  dependencies: Array<{ edge: string; from: { file: string; line: number }; node: FollowNodeRef; depth: number; tokens: number }>;
  unsatisfied: Array<{ kind: string; edge: string; from: { file: string; line: number }; target: string }>;
  /** Neighbors left out over the limit. */
  cut: number;
  complete: boolean;
  /** Files other than the document that the dependencies shown come from. */
  files: Dependency[];
  tokens: ReadFollow['tokens'];
}

export interface FollowNodeRef { file: string; type: string; title: string; id?: string; lines?: [number, number] }

const nodeRef = (n: GraphNode, file = n.file): FollowNodeRef => ({
  file, type: n.type, title: n.title, ...(n.id ? { id: n.id } : {}), ...(n.line === undefined ? {} : { lines: [n.line + 1, (n.endLine ?? n.line) + 1] as [number, number] }),
});

/**
 * Follow the edges of what a view shows: the whole document, or the selected sections. The view's own content
 * (selected sections, agent blocks, the constraints and dependencies it adds, includes it shows in place) is never
 * repeated, edges written in content the view hides ({agent=skip} sections it doesn't select, :::human blocks) are
 * left alone, and a dependency the view already reports as unsatisfied is not reported again.
 */
function followView(text: string, result: AgentViewResult, shown: 'full' | 'sections', input: FollowInput): Followed {
  const display = input.file ?? '<file>';
  const path = normalizePath(display);
  const lines = text.split(/\r?\n/);
  const today = input.today;
  const graph = new DocumentGraph([{ path, text }, ...(input.documents ?? [])], { readDocument: input.readDocument, today });
  const loaded = graph.document(path);
  const blocks = 'blocks' in loaded ? loaded.blocks : [];
  const sections = sectionsOf(parseSmd(text).headings, lines.length);
  const within = (line: number, ranges: ReadonlyArray<readonly [number, number]>) => ranges.some(([a, b]) => line >= a && line <= b);

  // What the view selects, and what it hides.
  const selected: Array<[number, number]> = shown === 'full'
    ? [[parseFrontMatter(text).bodyStartLine, lines.length - 1]]
    : (result.resolvedSections ?? []).flatMap((r) => r.headings).map((h) => sections.find((s) => s.start === h.line)).filter((s) => !!s).map((s) => [s!.start, s!.end]);
  const chosen = new Set((result.resolvedSections ?? []).flatMap((r) => r.headings.map((h) => h.line)));
  const hidden: Array<[number, number]> = [
    ...sections.filter((s) => s.heading.agent === 'skip' && !chosen.has(s.start)).map((s) => [s.start, s.end] as [number, number]),
    ...blocks.filter((b) => b.type === 'human').map((b) => [b.line, b.endLine] as [number, number]),
  ];
  // Other files keep their own {agent=skip} sections and :::human blocks for people.
  const hiddenElsewhere = new Map<string, Array<[number, number]>>();
  const hiddenOf = (file: string) => {
    if (file === path) return hidden;
    if (!hiddenElsewhere.has(file)) {
      const doc = graph.document(file);
      hiddenElsewhere.set(file, 'text' in doc ? peopleOnly(doc.text) : []);
    }
    return hiddenElsewhere.get(file)!;
  };
  const hiddenAt = (file: string, line: number | undefined) => line !== undefined && within(line, hiddenOf(file));
  const written = (e: GraphEdge) => hiddenAt(e.from.file, e.line);
  const toHidden = (e: GraphEdge) => e.type !== 'applies-to' && !!e.to && hiddenAt(e.to.file, e.to.line);

  // The view's content: the selection, then what it shows from elsewhere.
  const shownRanges: Array<[number, number]> = [...selected];
  if (shown === 'sections') for (const b of blocks) if ((b.type === 'agent' || b.type === 'danger') && !within(b.line, hidden)) shownRanges.push([b.line, b.endLine]);
  const shownKeys = new Set<string>();
  const context = [...(result.mandatory?.dependencies ?? []), ...(result.mandatory?.constraints ?? [])];
  for (const c of context) {
    const file = c.file === display ? path : resolvePath(path, c.file);
    const node = graph.nodeAt(file, c.line - 1);
    if (!node) continue;
    shownKeys.add(nodeKey(node));
    if (file === path) shownRanges.push([node.line!, node.endLine ?? node.line!]);
  }
  for (const b of blocks) if (within(b.line, shownRanges) && !within(b.line, hidden)) shownKeys.add(`${path}:${b.line}`);

  const starts: GraphNode[] = [];
  if (shown === 'full' && 'node' in loaded) starts.push(loaded.node);
  for (const b of blocks) if (within(b.line, selected) && !within(b.line, hidden)) starts.push(graph.nodeAt(path, b.line)!);
  if (shown === 'full' && 'node' in loaded) shownKeys.add(nodeKey(loaded.node));
  // Includes the view shows in place: their targets are shown.
  if (input.readFile) {
    for (const e of graph.edgesOf(path)) if (e.type === 'include' && e.to && within(e.line, selected) && !written(e)) shownKeys.add(nodeKey(e.to));
  }

  const mandatory = input.types.filter((t) => MANDATORY_EDGES.includes(t));
  const closure = mandatory.length && starts.length
    ? mandatoryClosure(graph, starts, { types: mandatory, shown: shownKeys, ignore: (e) => written(e) || toHidden(e) })
    : { blocks: [], unsatisfied: [] };
  for (const b of closure.blocks) shownKeys.add(nodeKey(b.node));
  const { neighbors, cut } = starts.length
    ? followEdges(graph, starts, { types: input.types, direction: input.direction, depth: input.depth, shown: shownKeys, ignore: written })
    : { neighbors: [], cut: 0 };
  // The view reports its own unsatisfied dependencies; each is reported once.
  const reported = result.mandatory?.unsatisfied ?? [];
  const unsatisfied = closure.unsatisfied.filter((u) => !reported.some((v) => {
    const file = v.file === display ? path : resolvePath(path, v.file);
    return file === u.edge.from.file && v.line === u.edge.line + 1 && (v.target === u.edge.target || (v.kind === 'include' && u.edge.type === 'include'));
  }));
  const g: MatchGraph = { neighbors, dependencies: closure.blocks, unsatisfied, cut };

  // The text: a heading line, then pointers, dependencies and what is unsatisfied, as `smd query` prints them.
  const spec = input.types.length === edgeTypes('*').length ? '*' : input.types.join(',');
  const head = `Edges followed from this content (${spec}; ${input.direction}; depth ${input.depth}):`;
  const body = graphLines(g, display === '<file>' ? path : display, {
    dependencies: 'Dependencies along these edges (included in full):',
    incomplete: (n) => `[incomplete: ${n} mandatory dependenc${n === 1 ? 'y is' : 'ies are'} not satisfied along the followed edges]`,
  });
  const parts = body.length ? [head, ...body] : [`${head} none.`];
  // Where each dependency's text is, for the source map: graphLines gives a dependency's header, then its text.
  const offsets: number[] = [];
  let count = 0;
  for (const p of parts) { offsets.push(count); count += p.split('\n').length; }
  const at = parts.indexOf('Dependencies along these edges (included in full):');
  const spans: Followed['spans'] = at < 0 ? [] : g.dependencies.map((d, k) => {
    const i = at + 2 + 2 * k;
    return { from: offsets[i], to: offsets[i] + parts[i].split('\n').length - 1, node: d.node };
  });
  const out = parts.join('\n').split('\n');
  const appended = `${out.join('\n')}\n`;
  const tokens = {
    shown: input.tokenizer?.count(`\n${appended}`) ?? estimateTokens(`\n${appended}`),
    dependencies: g.dependencies.reduce((n, b) => n + b.tokens, 0),
    pointers: g.neighbors.reduce((n, p) => n + p.tokens, 0),
  };
  // Complete only when nothing is missing: along the followed edges, or in the view itself, which lists its own.
  const complete = !unsatisfied.length && !reported.length;
  const report: ReadFollow = { ...g, types: input.types, direction: input.direction, depth: input.depth, complete, tokens };

  const files = [...new Set(g.dependencies.map((d) => d.node.file).filter((f) => f !== path))].sort((a, b) => (a < b ? -1 : Number(a > b)));
  const from = (e: GraphEdge) => ({ file: e.from.file === path ? display : e.from.file, line: e.line + 1 });
  const manifest: FollowManifest = {
    types: input.types, direction: input.direction, depth: input.depth,
    neighbors: g.neighbors.map((n) => ({
      direction: n.direction, depth: n.depth, edge: n.edge.type, from: from(n.edge), target: n.edge.target, status: n.edge.status,
      node: n.node ? nodeRef(n.node, n.node.file === path ? display : n.node.file) : null, shown: n.shown, tokens: n.tokens,
    })),
    dependencies: g.dependencies.map((d) => ({ edge: d.edge.type, from: from(d.edge), node: nodeRef(d.node, d.node.file === path ? display : d.node.file), depth: d.depth, tokens: d.tokens })),
    unsatisfied: unsatisfied.map((u) => ({ kind: u.kind, edge: u.edge.type, from: from(u.edge), target: u.edge.target })),
    cut, complete: report.complete,
    files: files.map((f) => {
      const doc = graph.document(f);
      return 'text' in doc ? { path: f, sha256: sha256Hex(doc.text), status: 'read' as const } : { path: f, sha256: null, status: 'unavailable' as const };
    }),
    tokens,
  };
  return { report, lines: out, spans, manifest };
}

/** The result with what following edges added: the text after the view, and the manifest updated. */
function withFollow(result: ReadResult, followed: Followed | undefined): ReadResult {
  if (!followed) return result;
  const text = `${result.text.replace(/\n*$/, '\n')}\n${followed.lines.join('\n')}\n`;
  const out: ReadResult = { ...result, text, follow: followed.report };
  if (result.provenance) out.provenance = followProvenance(result.provenance, result.text, followed);
  return out;
}

function followProvenance(provenance: Provenance, viewText: string, followed: Followed): Provenance {
  // The view's lines, a blank line, then the followed lines.
  const first = viewText.replace(/\n*$/, '').split('\n').length + 2;
  const sourceMap: SourceSpan[] = [...provenance.sourceMap];
  let line = 0;
  for (const s of followed.spans) {
    if (s.from > line) sourceMap.push({ output: [first + line, first + s.from - 1], kind: 'synthesized' });
    const lines = s.node.line === undefined ? undefined : [s.node.line + 1, (s.node.endLine ?? s.node.line) + 1] as [number, number];
    sourceMap.push({ output: [first + s.from, first + s.to], kind: 'source', file: s.node.file, ...(lines ? { source: lines } : {}) });
    line = s.to + 1;
  }
  if (line < followed.lines.length) sourceMap.push({ output: [first + line, first + followed.lines.length - 1], kind: 'synthesized' });
  const omissions: Omission[] = [...provenance.omissions];
  for (const u of followed.manifest.unsatisfied) {
    omissions.push({ kind: 'dependency', file: u.from.file, lines: [u.from.line, u.from.line], reason: `a mandatory dependency along a followed edge is not satisfied: ${u.edge} "${u.target}" (${u.kind})` });
  }
  return {
    ...provenance,
    sourceMap,
    omissions,
    size: { ...provenance.size, tokens: provenance.size.tokens + followed.report.tokens.shown },
    follow: followed.manifest,
  };
}
