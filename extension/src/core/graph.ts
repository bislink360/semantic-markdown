import { agentViewRanges, estimateTokens } from './agentView';
import { parseFrontMatter } from './frontmatter';
import { refDirective } from './figures';
import { splitIdRef } from './idTarget';
import { resolveId } from './ids';
import { includeRequest } from './include';
import { findLinks, splitTarget } from './links';
import { parseSmd } from './parse';
import { documentBlocks, type DocumentBlock } from './query';
import { findSection, sectionsOf } from './sections';
import { EDGE_KINDS, ID_ATTRIBUTES, idList } from './spec';
import { specVersion, type SpecVersion } from './specVersion';
import { suggest } from './util';

/**
 * The reference graph of .smd documents (filtering G1 to G5, research contract "Edge semantics"). Edges are derived
 * from the source on every call and never stored: links to anchors and .smd files, `:ref[id]`, `related:`, `:::include`,
 * every id attribute (ID_ATTRIBUTES) and a task's `:depends[id]`. Each edge has a type from EDGE_KINDS and a direction,
 * from the block it is written in to what it names. Ids resolve with resolveId, so a duplicate id resolves to nothing,
 * and an id written `other.smd#R1` resolves in that document (semantic tags R19).
 *
 * A DocumentGraph only remembers what it read during one call. Files outside the documents it is given are read
 * through `readDocument`, which says when a file is missing or outside what the host allows (denied).
 */

export type EdgeKind = 'navigation' | 'mandatory' | 'evidence' | 'lifecycle' | 'review';
export type EdgeDirection = 'out' | 'in';

export interface GraphDocument {
  /** The document's path, with `/` between folders. Relative links resolve against its folder. */
  path: string;
  text: string;
}

/** What a host returns for a file the graph was not given. */
export type DocumentRead = { text: string } | { status: 'missing' | 'denied' };

/** A block (heading, container, task), an anchor with no block of its own, or a whole document. */
export interface GraphNode {
  file: string;
  /** `document`, `anchor`, `heading`, `task` or a container name. */
  type: string;
  title: string;
  /** Zero-based first and last line; none for a document. */
  line?: number;
  endLine?: number;
  id?: string;
  /** The nearest heading above it. */
  section: string | null;
}

export type TargetStatus = 'resolved' | 'missing' | 'ambiguous' | 'denied';

export interface GraphEdge {
  /** A key of EDGE_KINDS: `link`, `ref`, `related`, `include`, `depends-on`, `applies-to`, `verifies`… */
  type: string;
  kind: EdgeKind;
  /** The block the edge is written in. */
  from: GraphNode;
  /** Zero-based line where it is written. */
  line: number;
  /** What it names as written: an id, `#anchor`, `file.smd#anchor`, or an include's `file § section`. */
  target: string;
  /** The file the target is in. */
  file: string;
  status: TargetStatus;
  /** The target, when resolved. */
  to?: GraphNode;
  /** With `ambiguous`: the zero-based lines of the blocks that give the id. */
  lines?: number[];
}

export interface GraphOptions {
  /** Reads a file the graph was not given, by its normalized path. Without it such files are denied. */
  readDocument?: (path: string) => DocumentRead;
  today?: string;
}

/** Edge types that expand automatically: their targets are part of what the source needs (research contract). */
export const MANDATORY_EDGES: readonly string[] = Object.keys(EDGE_KINDS).filter((t) => EDGE_KINDS[t] === 'mandatory');

/** A thrown error for an unknown edge type or kind in a follow list. */
export class EdgeTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdgeTypeError';
  }
}

/**
 * Edge types named by a follow list: edge types (`supersedes`), kinds (`evidence`) or `*` for all, comma-separated
 * or as a list. Throws an EdgeTypeError naming the unknown entry.
 */
export function edgeTypes(names: string | readonly string[]): string[] {
  const list = (typeof names === 'string' ? names.split(',') : names.flatMap((n) => n.split(','))).map((n) => n.trim().toLowerCase()).filter(Boolean);
  const types = Object.keys(EDGE_KINDS);
  const kinds = [...new Set(Object.values(EDGE_KINDS))];
  const out = new Set<string>();
  for (const name of list) {
    if (name === '*') types.forEach((t) => out.add(t));
    else if (types.includes(name)) out.add(name);
    else if ((kinds as string[]).includes(name)) types.filter((t) => EDGE_KINDS[t] === name).forEach((t) => out.add(t));
    else {
      const hint = suggest(name, [...types, ...kinds]);
      throw new EdgeTypeError(`Unknown edge type "${name}".${hint ? ` Did you mean "${hint}"?` : ''} Types: ${types.join(', ')}; kinds: ${kinds.join(', ')}; or *`);
    }
  }
  if (!out.size) throw new EdgeTypeError('Name the edge types to follow, e.g. "depends-on,supersedes" or "*".');
  return types.filter((t) => out.has(t));
}

/** `a/./b/../c` → `a/c` and backslashes → `/`. Leading `..` and a drive or `/` root stay. */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  const out: string[] = [];
  for (const seg of slashed.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..' && !/^[a-z]:$/i.test(out[out.length - 1])) out.pop();
    else out.push(seg);
  }
  return (slashed.startsWith('/') ? '/' : '') + out.join('/');
}

const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const isAbsolute = (p: string) => /^(?:[a-z]:)?[\\/]/i.test(p);

/** A link or include path written in document `from`, as a normalized path. */
export function resolvePath(from: string, target: string): string {
  if (isAbsolute(target)) return normalizePath(target);
  const dir = folderOf(normalizePath(from));
  return normalizePath(dir ? `${dir}/${target}` : target);
}

/** A node's key: its file and line, or its file for a whole document. */
export const nodeKey = (n: GraphNode): string => (n.line === undefined ? `${n.file}#${n.type}${n.id ? `#${n.id}` : ''}` : `${n.file}:${n.line}`);

/** Whether node `inner` lies within `outer`'s lines (or is in a document `outer` stands for). */
export function contains(outer: GraphNode, inner: GraphNode): boolean {
  if (outer.file !== inner.file) return false;
  if (outer.line === undefined) return outer.type === 'document';
  if (inner.line === undefined) return false;
  return inner.line >= outer.line && inner.line <= (outer.endLine ?? outer.line);
}

interface Loaded {
  path: string;
  text: string;
  lines: string[];
  spec: SpecVersion;
  blocks: DocumentBlock[];
  node: GraphNode;
  view?: (start: number, end: number) => string;
  edges?: GraphEdge[];
}

const DEPENDS = /(^|[\s([{>*_~"'-]):depends\[([^\]\n]*)\]/gi;

export class DocumentGraph {
  private readonly given: string[];
  private readonly loaded = new Map<string, Loaded | { status: 'missing' | 'denied' }>();
  private readonly today: string;

  constructor(documents: readonly GraphDocument[], private readonly options: GraphOptions = {}) {
    this.today = options.today ?? new Date().toISOString().slice(0, 10);
    this.given = [];
    for (const d of documents) {
      const path = normalizePath(d.path);
      if (this.loaded.has(path)) continue;
      this.given.push(path);
      this.loaded.set(path, this.load(path, d.text));
    }
  }

  /** The given documents' paths, normalized, in the order given. */
  get paths(): readonly string[] {
    return this.given;
  }

  /** A document by path: given, or read through `readDocument` (once per graph). */
  document(path: string): Loaded | { status: 'missing' | 'denied' } {
    const key = normalizePath(path);
    let found = this.loaded.get(key);
    if (!found) {
      const read = this.options.readDocument?.(key) ?? { status: 'denied' as const };
      found = 'text' in read ? this.load(key, read.text) : { status: read.status };
      this.loaded.set(key, found);
    }
    return found;
  }

  private load(path: string, text: string): Loaded {
    const fm = parseFrontMatter(text);
    const title = typeof fm.data.title === 'string' ? fm.data.title : path.slice(path.lastIndexOf('/') + 1);
    return {
      path, text, lines: text.split(/\r?\n/), spec: specVersion(fm.data), blocks: documentBlocks(text, this.today),
      node: { file: path, type: 'document', title, section: null },
    };
  }

  /** The node of the block that starts on `line` of a loaded document. */
  nodeAt(path: string, line: number): GraphNode | undefined {
    const doc = this.document(path);
    if (!('text' in doc)) return undefined;
    const block = doc.blocks.find((b) => b.line === line);
    return block ? toNode(path, block) : undefined;
  }

  /** The node a document stands for. */
  documentNode(path: string): GraphNode | undefined {
    const doc = this.document(path);
    return 'text' in doc ? doc.node : undefined;
  }

  /** The node an id names in a document, or why there is none. */
  resolve(path: string, id: string): { status: TargetStatus; node?: GraphNode; lines?: number[] } {
    const doc = this.document(path);
    if (!('text' in doc)) return { status: doc.status };
    const found = resolveId(doc.text, id);
    if (found.status === 'ambiguous') return { status: 'ambiguous', lines: found.lines };
    if (found.status === 'missing') return { status: 'missing' };
    if (found.line === undefined) return { status: 'resolved', node: { file: path, type: 'anchor', title: id, id, section: null } };
    const block = doc.blocks.find((b) => b.line === found.line);
    if (block) return { status: 'resolved', node: toNode(path, block) };
    const section = doc.blocks.filter((b) => b.type === 'heading' && b.line < found.line!).at(-1)?.title ?? null;
    return { status: 'resolved', node: { file: path, type: 'anchor', title: id, id, line: found.line, endLine: found.line, section } };
  }

  /** Every edge written in a document, in source order, with targets resolved (other files read as needed). */
  edgesOf(path: string): GraphEdge[] {
    const doc = this.document(path);
    if (!('text' in doc)) return [];
    doc.edges ??= this.derive(doc);
    return doc.edges;
  }

  /** Every edge written in the given documents. */
  allEdges(): GraphEdge[] {
    return this.given.flatMap((p) => this.edgesOf(p));
  }

  /** Edges written in `node` or a block inside it, or for a document node the edges of its front matter. */
  outgoing(node: GraphNode): GraphEdge[] {
    return this.edgesOf(node.file).filter((e) => (node.line === undefined ? e.from.type === 'document' : contains(node, e.from)));
  }

  /** Edges in the given documents whose target is `node`. */
  incoming(node: GraphNode): GraphEdge[] {
    const key = nodeKey(node);
    return this.allEdges().filter((e) => e.to && nodeKey(e.to) === key);
  }

  /** `applies-to` edges whose target is `node` or a heading or container that holds it: the constraints that bind it. */
  appliesTo(node: GraphNode): GraphEdge[] {
    return this.allEdges().filter((e) => e.type === 'applies-to' && e.to && e.to.type !== 'document' && contains(e.to, node));
  }

  /** The agent view of a node: its lines, or a document's body. Empty for a node with no lines. */
  content(node: GraphNode): string {
    const doc = this.document(node.file);
    if (!('text' in doc)) return '';
    doc.view ??= agentViewRanges(doc.text, { today: this.today });
    if (node.line === undefined) return node.type === 'document' ? doc.view(parseFrontMatter(doc.text).bodyStartLine, doc.lines.length - 1) : '';
    return doc.view(node.line, node.endLine ?? node.line);
  }

  /** ≈ tokens of a node's agent view. */
  tokens(node: GraphNode): number {
    return estimateTokens(this.content(node));
  }

  private derive(doc: Loaded): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const sourceAt = (line: number): GraphNode => {
      // The innermost block the line is in, or the document.
      let best: DocumentBlock | undefined;
      for (const b of doc.blocks) if (b.line <= line && line <= b.endLine && (!best || b.line >= best.line)) best = b;
      return best ? toNode(doc.path, best) : doc.node;
    };
    const add = (type: string, from: GraphNode, line: number, target: string, file: string, found: { status: TargetStatus; node?: GraphNode; lines?: number[] }) => {
      edges.push({
        type, kind: EDGE_KINDS[type], from, line, target, file, status: found.status,
        ...(found.node ? { to: found.node } : {}), ...(found.lines ? { lines: found.lines } : {}),
      });
    };
    const inDoc = (id: string) => this.resolve(doc.path, id);
    // An id as an id attribute, `:ref` or `:depends` writes it: in this document, or `other.smd#R1` in another (R19).
    const idEdge = (type: string, from: GraphNode, line: number, written: string) => {
      const target = splitIdRef(written);
      if (!target.path) { add(type, from, line, written, doc.path, inDoc(written)); return; }
      const file = resolvePath(doc.path, target.path);
      add(type, from, line, written, file, this.resolve(file, target.id));
    };

    // Links, related entries and includes (findLinks skips code).
    for (const link of findLinks(doc.text).links) {
      if (link.kind === 'include') continue;
      const parts = splitTarget(link.target);
      if (!parts) continue;
      if (link.kind === 'related') {
        if (!/\.smd$/i.test(parts.path)) continue;
        const file = resolvePath(doc.path, parts.path);
        add('related', doc.node, link.line, link.target, file, this.fileTarget(file));
        continue;
      }
      if (!parts.path) {
        if (parts.anchor) add('link', sourceAt(link.line), link.line, link.target, doc.path, inDoc(parts.anchor));
        continue;
      }
      if (!/\.smd$/i.test(parts.path)) continue;
      const file = resolvePath(doc.path, parts.path);
      add('link', sourceAt(link.line), link.line, link.target, file, parts.anchor ? this.resolve(file, parts.anchor) : this.fileTarget(file));
    }

    const bodyStart = parseFrontMatter(doc.text).bodyStartLine;
    for (const ref of refsIn(doc.lines, bodyStart, doc.spec)) idEdge('ref', sourceAt(ref.line), ref.line, ref.id);

    for (const block of doc.blocks) {
      const from = toNode(doc.path, block);
      if (block.type === 'include') {
        const request = includeRequest(stringAttrs(block.attrs));
        if (!request) continue;
        const file = resolvePath(doc.path, request.file);
        const target = request.section ? `${request.file} § ${request.section}` : request.file;
        add('include', from, block.line, target, file, request.section ? this.sectionTarget(file, request.section) : this.fileTarget(file));
        continue;
      }
      if (block.type === 'task') {
        if (doc.spec < 2) continue;
        const raw = (doc.lines[block.line] ?? '').replace(/(`+)([\s\S]*?)\1/g, (m) => ' '.repeat(m.length));
        for (const m of raw.matchAll(DEPENDS)) for (const id of idList(m[2])) idEdge('depends-on', from, block.line, id);
        continue;
      }
      for (const [key, names] of Object.entries(ID_ATTRIBUTES)) {
        const value = block.attrs[key];
        if (typeof value !== 'string' || !names.includes(block.type)) continue;
        for (const id of idList(value)) idEdge(key, from, block.line, id);
      }
    }
    return edges.sort((a, b) => a.line - b.line);
  }

  private fileTarget(file: string): { status: TargetStatus; node?: GraphNode } {
    const doc = this.document(file);
    return 'text' in doc ? { status: 'resolved', node: doc.node } : { status: doc.status };
  }

  private sectionTarget(file: string, section: string): { status: TargetStatus; node?: GraphNode } {
    const doc = this.document(file);
    if (!('text' in doc)) return { status: doc.status };
    const found = findSection(sectionsOf(parseSmd(doc.text).headings, doc.lines.length), section, doc.spec);
    const node = found && this.nodeAt(file, found.start);
    return node ? { status: 'resolved', node } : { status: 'missing' };
  }
}

function toNode(file: string, b: DocumentBlock): GraphNode {
  const id = typeof b.attrs.id === 'string' ? b.attrs.id : undefined;
  return { file, type: b.type, title: b.title, line: b.line, endLine: b.endLine, ...(id ? { id } : {}), section: b.section };
}

function stringAttrs(attrs: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(attrs).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** `:ref[id]` outside code. */
function refsIn(lines: string[], from: number, spec: SpecVersion): Array<{ id: string; line: number }> {
  const refs: Array<{ id: string; line: number }> = [];
  let fence: string | null = null;
  for (let i = from; i < lines.length; i++) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && lines[i].trim() === mark[1]) fence = null;
      continue;
    }
    if (mark) { fence = mark[1]; continue; }
    const text = lines[i].replace(/(`+)([\s\S]*?)\1/g, (m) => ' '.repeat(m.length));
    for (const m of text.matchAll(refDirective(spec))) if (m[2].trim()) refs.push({ id: m[2].trim(), line: i });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Following edges
// ---------------------------------------------------------------------------

/** Whether following an edge in this direction reaches something the start needs (research contract, "Edge semantics"). */
export function needs(edge: GraphEdge, direction: EdgeDirection): boolean {
  if (edge.kind !== 'mandatory') return false;
  return edge.type === 'applies-to' ? direction === 'in' : direction === 'out';
}

export interface FollowOptions {
  /** Edge types to follow (see edgeTypes). */
  types: readonly string[];
  direction?: EdgeDirection | 'both';
  /** 1 to 3 (default 1). */
  depth?: number;
  /** Nodes already shown in full, such as the other matches. Their pointers say so. */
  shown?: ReadonlySet<string>;
  /** At most this many neighbors (default 100). */
  limit?: number;
}

export interface Neighbor {
  edge: GraphEdge;
  /** `out` when the edge is written in the node it was reached from, `in` when it points at it. */
  direction: EdgeDirection;
  depth: number;
  /** The node it was reached from. */
  via: GraphNode;
  /** The neighbor; undefined when the target is missing, ambiguous or denied. */
  node?: GraphNode;
  /** True when the neighbor is shown in full elsewhere in the result. */
  shown: boolean;
  /** ≈ tokens of its content, not read (0 when shown or unresolved). */
  tokens: number;
}

export const MAX_FOLLOW_DEPTH = 3;

/**
 * The neighbors of `start` along edges of `types`, as pointers, breadth first up to `depth` hops. Edges that reach
 * something the start needs (mandatory edges in their own direction) are left out: mandatoryClosure includes them.
 */
export function followEdges(graph: DocumentGraph, start: GraphNode, options: FollowOptions): { neighbors: Neighbor[]; cut: number } {
  const depth = Math.min(MAX_FOLLOW_DEPTH, Math.max(1, Math.trunc(options.depth ?? 1)));
  const directions: EdgeDirection[] = options.direction === 'both' ? ['out', 'in'] : [options.direction ?? 'out'];
  const types = new Set(options.types);
  const limit = options.limit ?? 100;
  const seen = new Set([nodeKey(start)]);
  const listed = new Set<string>();
  // The depth a node was first listed at: deeper paths to it are not listed again.
  const firstDepth = new Map<string, number>();
  const neighbors: Neighbor[] = [];
  let cut = 0;
  let frontier = [start];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: GraphNode[] = [];
    for (const via of frontier) {
      for (const direction of directions) {
        const edges = direction === 'out' ? graph.outgoing(via) : graph.incoming(via);
        for (const edge of edges) {
          if (!types.has(edge.type) || (d === 1 && needs(edge, direction))) continue;
          const node = direction === 'out' ? edge.to : edge.from;
          // An edge between places inside the node, or back into the start, is not a neighbor.
          if (node && (contains(start, node) || (direction === 'out' && contains(via, node)))) continue;
          // Each neighbor once per relation, however many paths reach it.
          const what = node ? nodeKey(node) : `${edge.status}|${edge.file}|${edge.file === edge.from.file ? edge.target : edge.target.split('#')[1] ?? ''}`;
          const id = `${direction}|${edge.type}|${what}`;
          if (listed.has(id) || d > (firstDepth.get(what) ?? d)) continue;
          listed.add(id);
          if (!firstDepth.has(what)) firstDepth.set(what, d);
          if (neighbors.length >= limit) { cut++; continue; }
          const shown = !!node && (options.shown?.has(nodeKey(node)) ?? false);
          neighbors.push({ edge, direction, depth: d, via, ...(node ? { node } : {}), shown, tokens: node && !shown ? graph.tokens(node) : 0 });
          if (node && !seen.has(nodeKey(node))) {
            seen.add(nodeKey(node));
            next.push(node);
          }
        }
      }
    }
    frontier = next;
  }
  return { neighbors, cut };
}

// ---------------------------------------------------------------------------
// Mandatory closure
// ---------------------------------------------------------------------------

export interface ClosureOptions {
  /** Mandatory edge types to follow (default all: include, applies-to, depends-on). */
  types?: readonly string[];
  /** Hops from a start (default 5). A dependency further away is reported as a depth cut. */
  maxDepth?: number;
  /** At most this many blocks are included (default 50); the rest are reported. */
  maxBlocks?: number;
  /** Nodes already shown in full (by key): not included again and not reported. */
  shown?: ReadonlySet<string>;
}

export interface ClosureBlock {
  node: GraphNode;
  /** The edge that brought it in, and the node it was reached from. */
  edge: GraphEdge;
  via: GraphNode;
  depth: number;
  /** Its agent view. */
  text: string;
  tokens: number;
}

export type UnsatisfiedKind = 'missing' | 'ambiguous' | 'denied' | 'cycle' | 'depth' | 'limit';

/** A dependency the closure could not include (AF15, AF20). */
export interface Unsatisfied {
  kind: UnsatisfiedKind;
  edge: GraphEdge;
  via: GraphNode;
  depth: number;
  /** For a cycle: the nodes from the start back to where it closes. */
  path?: GraphNode[];
}

export interface Closure {
  blocks: ClosureBlock[];
  unsatisfied: Unsatisfied[];
  /** False when anything is unsatisfied. */
  complete: boolean;
}

export const CLOSURE_LIMITS = { depth: 5, blocks: 50 };

/**
 * What the start nodes need, in full: the targets of their `include` and `depends-on` edges and the constraints that
 * apply to them (`applies-to` pointing at them), then what those need in turn, depth first and bounded. Cycles, depth
 * cuts, the block limit, and missing, ambiguous or denied targets are reported as unsatisfied, and make the closure
 * incomplete. Reusable by any view that shows a block with its dependencies.
 *
 * The depth limit counts the fewest steps from a start, not the steps of the path the walk happens to take, so a
 * dependency within the limit is never cut because a longer path reached it first.
 */
export function mandatoryClosure(graph: DocumentGraph, starts: readonly GraphNode[], options: ClosureOptions = {}): Closure {
  const types = new Set((options.types ?? MANDATORY_EDGES).filter((t) => MANDATORY_EDGES.includes(t)));
  const maxDepth = options.maxDepth ?? CLOSURE_LIMITS.depth;
  const maxBlocks = options.maxBlocks ?? CLOSURE_LIMITS.blocks;
  const shown = new Set(options.shown ?? []);
  const done = new Set([...shown, ...starts.map(nodeKey)]);
  const blocks: ClosureBlock[] = [];
  const unsatisfied: Unsatisfied[] = [];
  const reported = new Set<string>();
  const report = (u: Unsatisfied) => {
    const key = `${u.kind}|${u.edge.from.file}:${u.edge.line}|${u.edge.target}`;
    if (!reported.has(key)) { reported.add(key); unsatisfied.push(u); }
  };
  const wantedOf = (node: GraphNode): Array<{ edge: GraphEdge; target?: GraphNode }> => [
    ...graph.outgoing(node).filter((e) => types.has(e.type) && needs(e, 'out')).map((edge) => ({ edge, target: edge.to })),
    ...(types.has('applies-to') ? graph.appliesTo(node).map((edge) => ({ edge, target: edge.from })) : []),
  ];

  // The fewest steps from any start to each node within the limit, breadth first over the same edges the walk follows.
  // Nodes already shown are not expanded, as the walk skips them. A node missing from `distance` is further away.
  const distance = new Map<string, number>(starts.map((s) => [nodeKey(s), 0]));
  let frontier = [...starts];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: GraphNode[] = [];
    for (const node of frontier) {
      for (const { edge, target } of wantedOf(node)) {
        if (edge.status !== 'resolved' || !target || contains(node, target)) continue;
        const key = nodeKey(target);
        if (distance.has(key) || shown.has(key)) continue;
        distance.set(key, d);
        next.push(target);
      }
    }
    frontier = next;
  }

  const visit = (node: GraphNode, path: GraphNode[]): void => {
    const depth = distance.get(nodeKey(node)) ?? maxDepth;
    for (const { edge, target } of wantedOf(node)) {
      if (edge.status !== 'resolved' || !target) {
        report({ kind: edge.status === 'resolved' ? 'missing' : edge.status as UnsatisfiedKind, edge, via: node, depth: depth + 1 });
        continue;
      }
      if (contains(node, target)) continue;
      const key = nodeKey(target);
      const on = path.findIndex((p) => nodeKey(p) === key);
      if (on >= 0) {
        report({ kind: 'cycle', edge, via: node, depth: depth + 1, path: [...path.slice(on), target] });
        continue;
      }
      if (done.has(key)) continue;
      const steps = distance.get(key);
      if (steps === undefined) { report({ kind: 'depth', edge, via: node, depth: maxDepth + 1 }); continue; }
      if (blocks.length >= maxBlocks) { report({ kind: 'limit', edge, via: node, depth: steps }); continue; }
      done.add(key);
      const text = graph.content(target);
      blocks.push({ node: target, edge, via: node, depth: steps, text, tokens: estimateTokens(text) });
      visit(target, [...path, target]);
    }
  };
  for (const start of starts) visit(start, [start]);
  return { blocks, unsatisfied, complete: unsatisfied.length === 0 };
}

// ---------------------------------------------------------------------------
// Validator rules (G7)
// ---------------------------------------------------------------------------

export interface DependencyProblem {
  code: 'depends/cycle' | 'decision/depends-superseded';
  /** Zero-based line of the edge to report on. */
  line: number;
  /** The attribute the edge is written in (`depends-on`, `supersedes`), or `:depends`. */
  key: string;
  /** The id it names. */
  id: string;
  message: string;
}

/**
 * Problems in a document's `depends-on` and `supersedes` edges: a chain that returns to its start (each cycle once,
 * at its first block), and an accepted decision that depends on a superseded one (by status, or named by a
 * `supersedes`). Other documents are not read.
 */
export function dependencyProblems(text: string, today?: string): DependencyProblem[] {
  const graph = new DocumentGraph([{ path: 'doc.smd', text }], { today });
  // Edges into other documents (`other.smd#R1`) are left out: only this document is read.
  const edges = graph.edgesOf('doc.smd').filter((e) => e.status === 'resolved' && e.to?.line !== undefined && !splitIdRef(e.target).path
    && (e.type === 'depends-on' || e.type === 'supersedes'));
  const problems: DependencyProblem[] = [];
  const name = (n: GraphNode) => n.id ?? n.title;
  const keyOf = (e: GraphEdge) => (e.from.type === 'task' ? ':depends' : e.type);

  for (const type of ['depends-on', 'supersedes']) {
    const typed = edges.filter((e) => e.type === type);
    for (const cycle of cycles(typed)) {
      const first = cycle[0];
      const names = [...cycle.map((e) => name(e.from)), name(first.from)].join(' → ');
      problems.push({ code: 'depends/cycle', line: first.line, key: keyOf(first), id: first.target, message: `This ${type} chain returns to its start (${names}), so none of its blocks can come first.` });
    }
  }

  const blocks = documentBlocks(text, today);
  const status = (line: number) => String(blocks.find((b) => b.line === line)?.attrs.status ?? '').toLowerCase();
  const supersededLines = new Set(edges.filter((e) => e.type === 'supersedes').map((e) => e.to!.line!));
  for (const e of edges) {
    if (e.type !== 'depends-on' || e.from.type !== 'decision' || e.to?.type !== 'decision') continue;
    if (status(e.from.line!) !== 'accepted') continue;
    if (status(e.to.line!) === 'superseded' || supersededLines.has(e.to.line!)) {
      problems.push({
        code: 'decision/depends-superseded', line: e.line, key: keyOf(e), id: e.target,
        message: `This accepted decision depends on "${e.target}", which is superseded. Depend on the decision that replaced it, or review this one.`,
      });
    }
  }
  return problems.sort((a, b) => a.line - b.line);
}

/** Each cycle among the edges once, as its edges from the block that comes first in the document. */
function cycles(edges: GraphEdge[]): GraphEdge[][] {
  const out = new Map<number, GraphEdge[]>();
  for (const e of edges) out.set(e.from.line!, [...(out.get(e.from.line!) ?? []), e]);
  const found: GraphEdge[][] = [];
  const seen = new Set<string>();
  const starts = [...out.keys()].sort((a, b) => a - b);
  for (const start of starts) {
    // Depth-first from `start`, only through blocks after it, so each cycle is found from its first block.
    const stack: Array<{ line: number; path: GraphEdge[] }> = [{ line: start, path: [] }];
    const visited = new Set<number>();
    while (stack.length) {
      const { line, path } = stack.pop()!;
      for (const e of out.get(line) ?? []) {
        const to = e.to!.line!;
        if (to === start) {
          const cycle = [...path, e];
          const key = cycle.map((c) => c.from.line!).sort((a, b) => a - b).join(',');
          if (!seen.has(key)) { seen.add(key); found.push(cycle); }
        } else if (to > start && !visited.has(to)) {
          visited.add(to);
          stack.push({ line: to, path: [...path, e] });
        }
      }
    }
  }
  return found;
}
