import { estimateTokens } from './agentView';
import {
  DocumentGraph, edgeTypes, followEdges, mandatoryClosure, MANDATORY_EDGES, nodeKey, normalizePath, CLOSURE_LIMITS,
  type ClosureBlock, type DocumentRead, type EdgeDirection, type GraphDocument, type GraphEdge, type GraphNode, type Neighbor, type Unsatisfied,
} from './graph';
import { documentBlocks, parseSelector, querySmd, type QueryMatch, type QueryOptions, type Selector } from './query';

/**
 * `smd query` over several documents, with the options tree and graph filtering add (filtering S1, G3 to G5, S4):
 * the document's agent blocks and document-wide constraints, and the neighbors along edges, as pointers or, for
 * mandatory edges, in full. Without them the matches are those of querySmd, in file order, then document order.
 */

export interface QueryDocumentsOptions extends QueryOptions {
  /** Add each document's `:::agent` blocks and document-scoped `:::constraint` blocks to the result (S1). */
  constraints?: boolean;
  /** Edge types or kinds to follow from each match, or `*` (see edgeTypes). */
  follow?: string | readonly string[];
  /** Which edges to follow: written in the match (`out`, default), pointing at it (`in`), or both. */
  direction?: EdgeDirection | 'both';
  /** Hops for pointers, 1 to 3 (default 1). Mandatory edges are followed to their closure (up to 5 hops). */
  depth?: number;
  /** Reads a file outside the documents given (see DocumentGraph). Without it such files are denied. */
  readDocument?: (path: string) => DocumentRead;
}

export interface FileMatch extends QueryMatch {
  /** The document's path, as given. */
  file: string;
}

/** A `:::agent` block or document-scoped `:::constraint` of a document with matches. */
export interface ConstraintBlock {
  type: string;
  line: number;
  endLine: number;
  title: string;
  section: string | null;
  text: string;
}

export interface DocumentConstraints {
  file: string;
  /** Those the matches don't already show. */
  blocks: ConstraintBlock[];
  /** Whether they are in the result (the `constraints` option). */
  included: boolean;
}

/** What following edges found for one match. */
export interface MatchGraph {
  neighbors: Neighbor[];
  dependencies: ClosureBlock[];
  unsatisfied: Unsatisfied[];
  /** Neighbors left out over the limit. */
  cut: number;
}

export interface QueryDocumentsResult {
  matches: FileMatch[];
  /** Documents with matches that have agent blocks or document constraints the matches don't show, in file order. */
  constraints: DocumentConstraints[];
  /** With `follow`: one per match, in the same order. */
  graph?: MatchGraph[];
  /** False when a mandatory dependency is unsatisfied. */
  complete: boolean;
  /** ≈ tokens shown (matches, constraints, dependencies), left out as pointers, and of the dependencies alone. */
  tokens: { shown: number; pointers: number; dependencies: number };
  /** The options the result was made with, for formatting. */
  options: { constraints: boolean; follow: string[] | null; direction: EdgeDirection | 'both'; depth: number };
}

/** The blocks of `documents` that match `selector`, with what the options add. Throws SelectorError or EdgeTypeError. */
export function queryDocuments(documents: readonly GraphDocument[], selector: string | Selector[], options: QueryDocumentsOptions = {}): QueryDocumentsResult {
  const selectors = typeof selector === 'string' ? parseSelector(selector) : selector;
  const follow = options.follow === undefined ? null : edgeTypes(options.follow);
  const direction = options.direction ?? 'out';
  const depth = Math.min(3, Math.max(1, Math.trunc(options.depth ?? 1)));
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const docs = documents.map((d) => ({ path: d.path, text: d.text }));
  const viewOptions = { brief: options.brief, lineRefs: options.lineRefs, today };

  const matches: FileMatch[] = [];
  const constraints: DocumentConstraints[] = [];
  for (const doc of docs) {
    const found = querySmd(doc.text, selectors, viewOptions).map((m) => ({ file: doc.path, ...m }));
    if (!found.length) continue;
    matches.push(...found);
    const blocks = documentConstraints(doc.text, found, viewOptions);
    if (blocks.length) constraints.push({ file: doc.path, blocks, included: !!options.constraints });
  }

  let graph: MatchGraph[] | undefined;
  if (follow) {
    const g = new DocumentGraph(docs, { readDocument: options.readDocument, today });
    const shown = new Set(matches.map((m) => `${normalizePath(m.file)}:${m.line}`));
    if (options.constraints) for (const c of constraints) for (const b of c.blocks) shown.add(`${normalizePath(c.file)}:${b.line}`);
    const mandatory = follow.filter((t) => MANDATORY_EDGES.includes(t));
    graph = matches.map((m) => {
      const node = g.nodeAt(normalizePath(m.file), m.line)!;
      const closure = mandatory.length ? mandatoryClosure(g, [node], { types: mandatory, shown }) : { blocks: [], unsatisfied: [] };
      for (const b of closure.blocks) shown.add(nodeKey(b.node));
      const { neighbors, cut } = followEdges(g, node, { types: follow, direction, depth, shown });
      return { neighbors, dependencies: closure.blocks, unsatisfied: closure.unsatisfied, cut };
    });
  }

  const constraintTokens = constraints.filter((c) => c.included).flatMap((c) => c.blocks).reduce((n, b) => n + estimateTokens(b.text), 0);
  const dependencies = (graph ?? []).flatMap((g) => g.dependencies).reduce((n, b) => n + b.tokens, 0);
  return {
    matches,
    constraints,
    ...(graph ? { graph } : {}),
    complete: !(graph ?? []).some((g) => g.unsatisfied.length),
    tokens: {
      shown: matches.reduce((n, m) => n + estimateTokens(m.text), 0) + constraintTokens + dependencies,
      pointers: (graph ?? []).flatMap((g) => g.neighbors).reduce((n, p) => n + p.tokens, 0),
      dependencies,
    },
    options: { constraints: !!options.constraints, follow, direction, depth },
  };
}

/**
 * A document's agent blocks and document-scoped constraints (`scope=document`, or written above the first heading)
 * that `matches` don't already show. Left out as everywhere: sections marked {agent=skip}, `:::human` blocks, and
 * blocks inside an agent block (shown with it).
 */
export function documentConstraints(text: string, matches: readonly QueryMatch[], options: QueryOptions = {}): ConstraintBlock[] {
  const skipped = documentBlocks(text, options.today).filter((b) => b.type === 'heading' && b.attrs.agent === 'skip');
  const within = (outer: { line: number; endLine: number }, line: number) => line >= outer.line && line <= outer.endLine;
  return querySmd(text, 'agent, constraint', options)
    .filter((b) => b.type === 'agent' || b.attrs.scope === 'document' || !b.ancestors.some((a) => a.type === 'heading'))
    .filter((b) => !b.ancestors.some((a) => a.type === 'agent' || a.type === 'human'))
    .filter((b) => !skipped.some((s) => within(s, b.line)))
    .filter((b) => !matches.some((m) => within(m, b.line)))
    .map((b) => ({ type: b.type, line: b.line, endLine: b.endLine, title: b.title, section: b.section, text: b.text }));
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** One line per match instead of its content (`--titles`). */
  titles?: boolean;
  /** How to ask for the constraints a result leaves out (default: the CLI option). */
  constraintsHint?: string;
}

/**
 * The result as `smd query` prints it. Without the new options and without agent blocks or constraints this is
 * exactly the released output. The note on left-out constraints ends each document's part when it has some.
 */
export function formatQueryResult(result: QueryDocumentsResult, options: FormatOptions = {}): string {
  if (!result.matches.length) return '';
  const hint = options.constraintsHint ?? 'Add --constraints to include them.';
  const parts: string[] = [];
  result.matches.forEach((m, i) => {
    const extra = result.graph ? graphLines(result.graph[i], m.file) : [];
    if (options.titles) parts.push([titleLine(m), ...extra].join('\n'));
    else parts.push(`${location(m)}\n${m.text}\n${extra.length ? `${extra.join('\n')}\n` : ''}`);
    const last = result.matches[i + 1]?.file !== m.file;
    const c = last ? result.constraints.find((x) => x.file === m.file) : undefined;
    if (c && !c.included) parts.push(options.titles ? constraintNote(c, hint) : `${constraintNote(c, hint)}\n`);
    if (c && c.included) {
      const head = `Agent blocks and document-wide constraints of ${m.file}, which apply to every match in it:`;
      if (options.titles) parts.push([head, ...c.blocks.map((b) => titleLine({ ...b, file: m.file, attrs: {} }))].join('\n'));
      else parts.push(`${head}\n\n${c.blocks.map((b) => `${location({ ...b, file: m.file })}\n${b.text ? `${b.text}\n` : ''}`).join('\n')}`);
    }
  });
  return parts.join('\n').trimEnd() + '\n';
}

/** `[smd] docs/plan.smd: 1 agent block and 2 document-wide constraints not included. Add --constraints to include them.` */
export function constraintNote(c: DocumentConstraints, hint = 'Add --constraints to include them.'): string {
  return `[smd] ${c.file}: ${constraintCount(c.blocks)} not included. ${hint}`;
}

/** `2 agent blocks and 1 document-wide constraint` */
function constraintCount(blocks: readonly ConstraintBlock[]): string {
  const agents = blocks.filter((b) => b.type === 'agent').length;
  const others = blocks.length - agents;
  const bits = [
    agents ? `${agents} agent block${agents === 1 ? '' : 's'}` : '',
    others ? `${others} document-wide constraint${others === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return bits.join(' and ');
}

/** How graphLines labels its parts: `smd query`'s by default. */
export interface GraphLineLabels {
  /** The line above the dependencies included in full. */
  dependencies: string;
  /** The last line when something is unsatisfied, given how many. */
  incomplete: (count: number) => string;
}

const QUERY_LABELS: GraphLineLabels = {
  dependencies: 'Dependencies (mandatory edges, included in full):',
  incomplete: () => 'This match is shown without all it depends on: the result is incomplete.',
};

/**
 * What following edges found, as lines: pointers (each one's own neighbors indented under it), then the dependencies
 * in full, then what is unsatisfied. `file` is the document the edges start in; other files are named.
 */
export function graphLines(g: MatchGraph, file: string, labels: GraphLineLabels = QUERY_LABELS): string[] {
  const out = treeOrder(g.neighbors).map((n) => pointerLine(n, file));
  if (g.cut) out.push(`  … ${g.cut} more neighbor${g.cut === 1 ? '' : 's'} not listed`);
  if (g.dependencies.length) {
    out.push(labels.dependencies);
    for (const d of g.dependencies) {
      const where = d.node.line === undefined ? d.node.file : `${d.node.file}:${d.node.line + 1}${(d.node.endLine ?? d.node.line) > d.node.line ? `-${(d.node.endLine ?? d.node.line) + 1}` : ''}`;
      const section = d.node.section ? `  — ${d.node.section}` : '';
      out.push(`${where}${section}  (${d.edge.type} from ${edgePlace(d.edge, file)})`, d.text || '(empty)');
    }
  }
  for (const u of g.unsatisfied) out.push(`Unsatisfied dependency: ${u.edge.type} "${u.edge.target}" from ${edgePlace(u.edge, file)} ${unsatisfiedReason(u)}`);
  if (g.unsatisfied.length) out.push(labels.incomplete(g.unsatisfied.length));
  return out;
}

/** Neighbors with each one's own neighbors right after it, so an indented pointer is reached from the line above. */
function treeOrder(neighbors: readonly Neighbor[]): Neighbor[] {
  const children = new Map<string, Neighbor[]>();
  for (const n of neighbors) if (n.depth > 1) children.set(nodeKey(n.via), [...(children.get(nodeKey(n.via)) ?? []), n]);
  const out: Neighbor[] = [];
  const placed = new Set<Neighbor>();
  const add = (n: Neighbor) => {
    out.push(n);
    placed.add(n);
    for (const c of (n.node ? children.get(nodeKey(n.node)) : undefined) ?? []) if (c.depth === n.depth + 1 && !placed.has(c)) add(c);
  };
  neighbors.filter((n) => n.depth === 1).forEach(add);
  return [...out, ...neighbors.filter((n) => !placed.has(n))];
}

const edgePlace =(e: GraphEdge, file: string) => `${e.from.file === normalizePath(file) ? '' : `${e.from.file} `}L${e.line + 1}`;

function unsatisfiedReason(u: Unsatisfied): string {
  switch (u.kind) {
    case 'missing': return 'names nothing that exists (missing).';
    case 'denied': return `is in ${u.edge.file}, outside the paths this command may read (denied).`;
    case 'ambiguous': return `is the id of ${u.edge.lines?.length ?? 2} blocks (lines ${(u.edge.lines ?? []).map((l) => l + 1).join(', ')}), so it names none of them (ambiguous).`;
    case 'cycle': return `closes a cycle: ${(u.path ?? []).map(nodeName).join(' → ')}.`;
    case 'depth': return `is more than ${CLOSURE_LIMITS.depth} hops from the match (depth limit).`;
    default: return `was left out: at most ${CLOSURE_LIMITS.blocks} dependencies are included (limit).`;
  }
}

const nodeName = (n: GraphNode) => n.id ?? (n.title || n.type);

/** `  -> supersedes  decision  Title  [L44]  §Section  ≈60 tokens` */
export function pointerLine(n: Neighbor, file: string): string {
  const indent = '  '.repeat(n.depth);
  const arrow = n.direction === 'out' ? '->' : '<-';
  const head = `${indent}${arrow} ${n.edge.type.padEnd(10)}`;
  if (!n.node) {
    const why = n.edge.status === 'denied' ? 'outside the paths this command may read'
      : n.edge.status === 'ambiguous' ? `the id of blocks on lines ${(n.edge.lines ?? []).map((l) => l + 1).join(', ')}` : 'not found';
    return `${head}  ${n.edge.status}  ${n.edge.target}  (${why})`;
  }
  const node = n.node;
  const where = [node.file === normalizePath(file) ? '' : node.file, node.line === undefined ? '' : `[L${node.line + 1}]`].filter(Boolean).join(' ');
  const bits = [node.type, node.title || node.id || '', where, node.section ? `§${node.section}` : '', n.shown ? '(shown in this result)' : `≈${n.tokens} tokens`];
  return `${head}  ${bits.filter(Boolean).join('  ')}`;
}

/** `[smd]`'s summary, without the prefix: the released one, then what follow and constraints added. */
export function queryResultSummary(result: QueryDocumentsResult, fileCount: number): string {
  const files = new Set(result.matches.map((m) => m.file)).size;
  const parts = [`${result.matches.length} match(es) in ${files} of ${fileCount} file(s).`];
  if (result.options.constraints) {
    const n = result.constraints.reduce((k, c) => k + c.blocks.length, 0);
    parts.push(`${n} agent block(s) and document constraint(s) included.`);
  }
  if (result.graph) {
    const pointers = result.graph.reduce((k, g) => k + g.neighbors.length, 0);
    const deps = result.graph.reduce((k, g) => k + g.dependencies.length, 0);
    const unsatisfied = result.graph.reduce((k, g) => k + g.unsatisfied.length, 0);
    parts.push(`${pointers} neighbor(s) as pointers (≈${result.tokens.pointers} tokens not read).`);
    if (deps) parts.push(`${deps} dependenc${deps === 1 ? 'y' : 'ies'} included (≈${result.tokens.dependencies} tokens).`);
    parts.push(`≈${result.tokens.shown} tokens shown.`);
    if (unsatisfied) parts.push(`Incomplete: ${unsatisfied} unsatisfied dependenc${unsatisfied === 1 ? 'y' : 'ies'}.`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const nodeJson = (n: GraphNode) => ({ file: n.file, type: n.type, title: n.title, ...(n.line === undefined ? {} : { line: n.line, endLine: n.endLine }), ...(n.id ? { id: n.id } : {}), section: n.section });

/** An edge for JSON output. Lines are zero-based, as in matches. */
export function edgeJson(e: GraphEdge) {
  return {
    type: e.type, kind: e.kind, from: nodeJson(e.from), line: e.line, target: e.target, file: e.file, status: e.status,
    ...(e.to ? { to: nodeJson(e.to) } : {}), ...(e.lines ? { lines: e.lines } : {}),
  };
}

/** The result as `smd query --json` prints it when a new option is given: matches with ancestors, then what the options added. */
export function queryResultJson(result: QueryDocumentsResult) {
  const edges = new Map<string, ReturnType<typeof edgeJson>>();
  const keep = (e: GraphEdge) => { edges.set(`${e.from.file}:${e.line}|${e.type}|${e.target}`, edgeJson(e)); };
  const graph = result.graph?.map((g) => {
    g.neighbors.forEach((n) => keep(n.edge));
    g.dependencies.forEach((d) => keep(d.edge));
    g.unsatisfied.forEach((u) => keep(u.edge));
    return {
      neighbors: g.neighbors.map((n) => ({ direction: n.direction, depth: n.depth, edge: edgeJson(n.edge), via: nodeJson(n.via), node: n.node ? nodeJson(n.node) : null, shown: n.shown, tokens: n.tokens })),
      dependencies: g.dependencies.map((d) => ({ depth: d.depth, edge: edgeJson(d.edge), via: nodeJson(d.via), node: nodeJson(d.node), tokens: d.tokens, text: d.text })),
      unsatisfied: g.unsatisfied.map((u) => ({ kind: u.kind, depth: u.depth, edge: edgeJson(u.edge), via: nodeJson(u.via), ...(u.path ? { path: u.path.map(nodeJson) } : {}) })),
      cut: g.cut,
    };
  });
  return {
    matches: result.matches.map((m, i) => ({ ...m, ...(graph ? graph[i] : {}) })),
    constraints: result.constraints,
    ...(graph ? { edges: [...edges.values()] } : {}),
    complete: result.complete,
    tokens: result.tokens,
  };
}

/** location and titleLine as `smd query` prints them (workspace.ts has the released copies). */
function location(r: { file: string; line: number; endLine: number; section: string | null }): string {
  const end = r.endLine > r.line ? `-${r.endLine + 1}` : '';
  return `${r.file}:${r.line + 1}${end}${r.section ? `  — ${r.section}` : ''}`;
}

function titleLine(r: { file: string; line: number; endLine: number; type: string; title: string; attrs: Record<string, string | string[]>; section: string | null }): string {
  const end = r.endLine > r.line ? `-${r.endLine + 1}` : '';
  const attrs = Object.entries(r.attrs).map(([k, v]) => `${k}=${[v].flat().join(',')}`).join(' ');
  const parts = [`${r.file}:${r.line + 1}${end}`, r.type, r.title, attrs && `{${attrs}}`, r.section && `— ${r.section}`];
  return parts.filter(Boolean).join('  ');
}
