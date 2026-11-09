import { DocumentGraph, mandatoryClosure, nodeKey, CLOSURE_LIMITS, type DocumentRead, type GraphNode, type UnsatisfiedKind } from './graph';
import { resolveId } from './ids';
import { includeLabel, includeProblemText, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope } from './include';
import { includeSource } from './includeText';
import { parseSmd } from './parse';
import { sectionsOf, type Section } from './sections';
import { listed, tagBlocks, type TagBlock } from './semanticTags';

/**
 * Which constraints and dependencies a view must carry (semantic tags RFC "Constraint", feedback loop RFC
 * "Dependencies", research contract "Scope and applicability"). Worked out from the source on every call.
 *
 * A constraint applies to a view when it is `scope=document`, when it is `scope=section` and the view shows its section
 * or a subsection of it, when its `applies-to` names a block the view shows or a heading whose section the view shows,
 * or when it is `scope=section` above the first heading. A constraint in an included file counts as written at the
 * include's position. Constraints in `{agent=skip}` sections, `:::human` blocks, `:::agent` blocks and danger blocks are
 * left out: the first two never reach an agent, the others are shown with their block.
 *
 * The dependencies of what a view shows are the `depends-on` and `:depends` closure (mandatoryClosure), at most 5 steps.
 * What it cannot include (cycles, depth cuts, missing or ambiguous targets) and includes that were not read make the
 * view incomplete.
 */

/** The root document's key in picks; an included file's key is its path. */
export const ROOT_DOC = '';
const GRAPH_ROOT = '\u0000document.smd';

/** Lines of the document and of included files that a head block shows, and the opening lines that get a `[L12]`. */
export interface Picks {
  ranges: Map<string, Array<[number, number]>>;
  opens: Map<string, Set<number>>;
}

export interface AppliedConstraint {
  id?: string;
  title: string;
  /** The file it is written in: the document's path, or an included file's. */
  file: string;
  /** One-based line in `file`. */
  line: number;
  /** Why it applies: its scope, or what its `applies-to` names. */
  applies: 'document' | 'section' | 'applies-to';
}

export interface IncludedDependency {
  id?: string;
  type: string;
  title: string;
  file: string;
  /** One-based line in `file`. */
  line: number;
  /** The block that depends on it (its id, else its title). */
  via: string;
  depth: number;
}

export type MandatoryProblem = UnsatisfiedKind | 'hidden' | 'include';

export interface UnsatisfiedDependency {
  kind: MandatoryProblem;
  /** What the edge names: an id, or an include's file. */
  target: string;
  /** The file and one-based line where the edge is written. */
  file: string;
  line: number;
  via?: string;
  reason: string;
}

/**
 * The mandatory context of a view: the constraints from outside the selected sections it shows, the dependencies it
 * adds, and what it could not satisfy. `complete` is false when anything is unsatisfied.
 */
export interface MandatoryContext {
  constraints: AppliedConstraint[];
  dependencies: IncludedDependency[];
  unsatisfied: UnsatisfiedDependency[];
  complete: boolean;
}

/** Omitting the section that holds `holder` needs every line of `needs` omitted too; `always` never allows it. */
export interface Tie { holder: number; needs: number[]; always?: boolean }

/** What agentView needs to show the mandatory context (see agentView's applyingHead and dependencyHead). */
export interface MandatoryPlan {
  context: MandatoryContext;
  applying: Picks;
  dependencies: Picks;
  /** Dependencies in included text that no include of the document reaches: file and agent view. */
  extra: Array<{ file: string; text: string }>;
  unsatisfied: string[];
  /** Budget rules (see Tie), lines of the document. */
  ties: Tie[];
  /** Where each constraint sits in the document (an include's line for an included one). */
  constraintAt: number[];
  /** Lines of the document's own constraints that apply to the view, shown in place or in the head. */
  applyingLines: Set<number>;
  /** The document or a file it includes has a `:::constraint` block. */
  hasConstraints: boolean;
}

export interface ScopeInput {
  text: string;
  lines: string[];
  bodyStart: number;
  sections: Section[];
  selected: Section[] | null;
  skipped: Section[];
  inScope: (line: number) => boolean;
  includeHuman: boolean;
  includes: boolean;
  readFile?: (relativePath: string) => string | undefined;
  /** Reads a document a dependency names in another file, relative to this one (R19). Without it they are denied. */
  readDocument?: (relativePath: string) => DocumentRead;
  /** The document's path for line references, `<file>` by default. */
  file: string;
}

interface FoundConstraint {
  doc: string;
  block: TagBlock;
  /** The document line it counts at: its own, or the outermost include's. */
  pos: number;
  /** Shown where it is written. */
  inPlace: boolean;
}

interface FoundInclude {
  doc: string;
  line: number;
  path: string;
  label: string;
  pos: number;
  shown: boolean;
  start: number;
  end: number;
  ok: boolean;
  reason?: string;
}

interface ScannedDoc { path: string; text: string; hidden: Array<[number, number]> }

const MAY_HOLD = /:{3,}\s*constraint(?![\w-])|depends-on|:depends\[/i;
const HIDING = new Set(['agent', 'danger']);

const within = (line: number, ranges: ReadonlyArray<readonly [number, number]>) => ranges.some(([a, b]) => line >= a && line <= b);

function addPick(picks: Picks, doc: string, start: number, end: number): void {
  picks.ranges.set(doc, [...(picks.ranges.get(doc) ?? []), [start, end]]);
  picks.opens.set(doc, (picks.opens.get(doc) ?? new Set()).add(start));
}

const emptyPicks = (): Picks => ({ ranges: new Map(), opens: new Map() });

/** The lines of a document that are for people only: its `{agent=skip}` sections, and its `:::human` blocks unless they are shown. */
export function peopleOnly(text: string, includeHuman = false): Array<[number, number]> {
  const lines = text.split(/\r?\n/);
  const hidden: Array<[number, number]> = sectionsOf(parseSmd(text).headings, lines.length)
    .filter((s) => s.heading.agent === 'skip').map((s) => [s.start, s.end]);
  if (!includeHuman) hidden.push(...tagBlocks(text).filter((b) => b.name === 'human').map((b) => [b.line, b.endLine] as [number, number]));
  return hidden;
}

/** Whether a block sits in a `:::human` block (unless they are shown), an include's fallback body, or a block shown elsewhere. */
function parentHides(block: TagBlock, includeHuman: boolean): boolean {
  for (let p = block.parent; p; p = p.parent) {
    if (p.name === 'include' || HIDING.has(p.name) || (p.name === 'human' && !includeHuman)) return true;
  }
  return false;
}

/** The plan for one view, or undefined when the document holds no constraint and no dependency. */
export function mandatoryPlan(input: ScopeInput): MandatoryPlan | undefined {
  const { text, sections, selected, inScope } = input;
  const hasInclude = /:{3,}\s*include\b/i.test(text);
  if (!MAY_HOLD.test(text) && !hasInclude) return undefined;

  const constraints: FoundConstraint[] = [];
  const includes: FoundInclude[] = [];
  const docs: ScannedDoc[] = [];
  const source = includeSource(input.readFile);

  // The document's own hidden parts: skipped sections that are not selected, and :::human blocks.
  const rootBlocks = tagBlocks(text);
  const humans = input.includeHuman ? [] : rootBlocks.filter((b) => b.name === 'human').map((b) => [b.line, b.endLine] as [number, number]);
  const skippedHidden = input.skipped.filter((s) => !selected?.some((sel) => sel.heading === s.heading)).map((s) => [s.start, s.end] as [number, number]);
  const rootHidden = [...skippedHidden, ...humans];
  docs.push({ path: GRAPH_ROOT, text, hidden: rootHidden });

  const scan = (doc: string, blocks: TagBlock[], range: [number, number], hidden: Array<[number, number]>, scope: IncludeScope, at?: { pos: number; shown: boolean }) => {
    for (const b of blocks) {
      if (b.line < range[0] || b.line > range[1] || within(b.line, hidden) || parentHides(b, input.includeHuman)) continue;
      const pos = at?.pos ?? b.line;
      const shown = at ? at.shown : inScope(b.line);
      if (b.name === 'constraint') constraints.push({ doc, block: b, pos, inPlace: shown });
      if (b.name !== 'include') continue;
      const request = includeRequest({ ...b.values });
      if (!request) continue;
      const found: FoundInclude = { doc, line: b.line, path: request.file, label: request.file, pos, shown, start: 0, end: -1, ok: false };
      includes.push(found);
      if (!input.includes) { found.reason = 'includes are off'; continue; }
      const result = loadInclude(request, scope, source);
      found.path = result.ok ? result.include.path : result.path;
      found.label = includeLabel(found.path, request.section);
      if (!result.ok) {
        const problem = includeProblemText(result);
        found.reason = result.problem === 'unavailable' ? 'no reader for included files' : problem[0].toLowerCase() + problem.slice(1);
        continue;
      }
      const inc = result.include;
      Object.assign(found, { ok: true, start: inc.start, end: inc.end });
      const incText = inc.lines.join('\n');
      const incHidden: Array<[number, number]> = sectionsOf(parseSmd(incText).headings, inc.lines.length)
        .filter((s) => s.heading.agent === 'skip').map((s) => [s.start, s.end]);
      const incBlocks = tagBlocks(incText);
      if (!input.includeHuman) incHidden.push(...incBlocks.filter((x) => x.name === 'human').map((x) => [x.line, x.endLine] as [number, number]));
      if (!docs.some((d) => d.path === inc.path)) docs.push({ path: inc.path, text: incText, hidden: incHidden });
      scan(inc.path, incBlocks, [inc.start, inc.end], incHidden, innerScope(scope, inc), { pos, shown });
    }
  };
  scan(ROOT_DOC, rootBlocks, [input.bodyStart, input.lines.length - 1], rootHidden, rootScope(text));

  const hasConstraints = constraints.length > 0;
  if (!hasConstraints && !docs.some((d) => /depends-on|:depends\[/i.test(d.text))) return undefined;
  // Other files a dependency names are read through the host, relative to the document (the root's folder is '').
  const graph = new DocumentGraph(docs.map((d) => ({ path: d.path, text: d.text })), { readDocument: input.readDocument });
  // A word in prose or code is not a dependency: only an edge is.
  if (!hasConstraints && !docs.some((d) => graph.edgesOf(d.path).some((e) => e.type === 'depends-on'))) return undefined;

  const fileName = (doc: string) => (doc === ROOT_DOC || doc === GRAPH_ROOT ? input.file : doc);
  const docOf = (path: string) => (path === GRAPH_ROOT ? ROOT_DOC : path);
  const readHidden = new Map<string, Array<[number, number]>>();
  const hiddenIn = (path: string): Array<[number, number]> => {
    const known = docs.find((d) => d.path === path);
    if (known) return known.hidden;
    // A document read for a dependency: its {agent=skip} sections and :::human blocks are for people.
    if (!readHidden.has(path)) {
      const read = graph.document(path);
      readHidden.set(path, 'text' in read ? peopleOnly(read.text, input.includeHuman) : []);
    }
    return readHidden.get(path)!;
  };

  /** Whether the view's body shows line `line` of a document (the root's key or an included path). */
  const shownAt = (doc: string, line: number): boolean => {
    if (doc === ROOT_DOC) return inScope(line) && !within(line, humans);
    if (within(line, hiddenIn(doc))) return false;
    return includes.some((r) => r.ok && r.path === doc && r.shown && line >= r.start && line <= r.end);
  };
  const sectionAt = (line: number) => sections.filter((s) => line >= s.start && line <= s.end).at(-1);
  const overlapsView = (s: Section) => !selected || selected.some((sel) => sel.start <= s.end && s.start <= sel.end);

  /** Whether `id` (as the document resolves it) is shown by the view, or by the dependencies added so far. */
  const targetShown = (id: string, extra: ReadonlyArray<readonly [number, number]>): number | undefined => {
    const found = resolveId(text, id);
    if (found.status !== 'resolved' || found.line === undefined) return undefined;
    const heading = sections.find((s) => s.start === found.line);
    if (heading) return overlapsView(heading) || within(found.line, extra) ? found.line : undefined;
    return shownAt(ROOT_DOC, found.line) || within(found.line, extra) ? found.line : undefined;
  };

  const whyApplies = (c: FoundConstraint, extra: ReadonlyArray<readonly [number, number]>): AppliedConstraint['applies'] | undefined => {
    const scope = (c.block.values.scope ?? 'section').trim().toLowerCase();
    const section = sectionAt(c.pos);
    if (scope === 'document' || !section) return 'document';
    if (!selected || selected.some((s) => s.start >= section.start && s.end <= section.end)) return 'section';
    return listed(c.block, 'applies-to').some((id) => targetShown(id, extra) !== undefined) ? 'applies-to' : undefined;
  };

  const run =(extra: ReadonlyArray<readonly [number, number]>) => {
    const head = constraints.filter((c) => !c.inPlace).map((c) => ({ c, why: whyApplies(c, extra) })).filter((x) => x.why);
    const inHead = (doc: string, line: number) => head.some(({ c }) => c.doc === doc && line >= c.block.line && line <= c.block.endLine);
    const shownNode = (doc: string, line: number) => shownAt(doc, line) || inHead(doc, line);
    const starts: GraphNode[] = [];
    const shown = new Set<string>();
    for (const d of docs) {
      const doc = docOf(d.path);
      const loaded = graph.document(d.path);
      if (!('blocks' in loaded)) continue;
      for (const b of loaded.blocks) if (shownNode(doc, b.line)) shown.add(nodeKey({ file: d.path, type: b.type, title: '', line: b.line, section: null }));
      const seen = new Set<string>();
      for (const e of graph.edgesOf(d.path)) {
        if (e.type !== 'depends-on' || e.from.line === undefined || !shownNode(doc, e.from.line)) continue;
        const key = nodeKey(e.from);
        if (!seen.has(key)) { seen.add(key); starts.push(e.from); }
      }
    }
    return { head, closure: mandatoryClosure(graph, starts, { types: ['depends-on'], shown, maxDepth: CLOSURE_LIMITS.depth }) };
  };
  let round = run([]);
  const rootRanges = (r: typeof round) => r.closure.blocks.filter((b) => b.node.file === GRAPH_ROOT).map((b) => [b.node.line!, b.node.endLine ?? b.node.line!] as [number, number]);
  // One more round: a constraint whose applies-to names a dependency the view adds applies too.
  if (round.closure.blocks.length && hasConstraints) {
    const next = run(rootRanges(round));
    if (next.head.length > round.head.length) round = next;
  }

  const plan: MandatoryPlan = {
    context: { constraints: [], dependencies: [], unsatisfied: [], complete: true },
    applying: emptyPicks(), dependencies: emptyPicks(), extra: [], unsatisfied: [], ties: [],
    constraintAt: constraints.map((c) => c.pos), applyingLines: new Set(), hasConstraints,
  };

  for (const { c, why } of round.head) {
    addPick(plan.applying, c.doc, c.block.line, c.block.endLine);
    plan.context.constraints.push({ ...(c.block.id ? { id: c.block.id } : {}), title: c.block.title, file: fileName(c.doc), line: c.block.line + 1, applies: why! });
    if (c.doc === ROOT_DOC) plan.applyingLines.add(c.block.line);
  }
  for (const c of constraints) if (c.inPlace && c.doc === ROOT_DOC) plan.applyingLines.add(c.block.line);

  const name = (n: GraphNode) => n.id ?? `${n.type} "${n.title}"`;
  const unsatisfied = (u: UnsatisfiedDependency) => {
    plan.context.unsatisfied.push(u);
    const where = u.file === input.file ? '' : ` in ${u.file}`;
    const what = u.kind === 'include' ? `included file ${u.target}` : `${u.via} depends on ${u.target}`;
    plan.unsatisfied.push(`- ${what} [L${u.line}]${where}: ${u.reason}`);
  };

  for (const b of round.closure.blocks) {
    const doc = docOf(b.node.file);
    const line = b.node.line!;
    const end = b.node.endLine ?? line;
    if (within(line, hiddenIn(b.node.file))) {
      unsatisfied({
        kind: 'hidden', target: b.edge.target, file: fileName(b.edge.from.file), line: b.edge.line + 1, via: name(b.via),
        reason: 'the block is for people only ({agent=skip} or :::human)',
      });
      continue;
    }
    plan.context.dependencies.push({
      ...(b.node.id ? { id: b.node.id } : {}), type: b.node.type, title: b.node.title, file: fileName(doc), line: line + 1, via: name(b.via), depth: b.depth,
    });
    if (doc === ROOT_DOC || includes.some((r) => r.ok && r.path === doc && line >= r.start && line <= r.end)) addPick(plan.dependencies, doc, line, end);
    else plan.extra.push({ file: doc, text: b.text });
  }
  const reasons: Record<UnsatisfiedKind, (u: { path?: GraphNode[]; lines?: number[] }) => string> = {
    missing: () => 'no block has this id',
    ambiguous: (u) => `several blocks give this id${u.lines?.length ? ` (${u.lines.map((l) => `L${l + 1}`).join(', ')})` : ''}`,
    denied: () => 'outside what the host allows',
    cycle: (u) => `the chain returns to its start (${(u.path ?? []).map(name).join(' → ')})`,
    depth: () => `more than ${CLOSURE_LIMITS.depth} steps away`,
    limit: () => `more than ${CLOSURE_LIMITS.blocks} dependencies`,
  };
  for (const u of round.closure.unsatisfied) {
    unsatisfied({
      kind: u.kind, target: u.edge.target, file: fileName(u.edge.from.file), line: u.edge.line + 1, via: name(u.via),
      reason: reasons[u.kind]({ path: u.path, lines: u.edge.lines }),
    });
  }
  for (const r of includes) {
    if (r.ok) continue;
    unsatisfied({ kind: 'include', target: r.label, file: fileName(r.doc), line: r.line + 1, reason: `not read (${r.reason})` });
  }
  plan.context.complete = plan.context.unsatisfied.length === 0;

  // Budget rules, on the document's lines: what applies or is depended on keeps its section.
  for (const c of constraints) {
    if (!c.inPlace) continue;
    const scope = (c.block.values.scope ?? 'section').trim().toLowerCase();
    if (scope === 'document' || !sectionAt(c.pos)) { plan.ties.push({ holder: c.pos, needs: [], always: true }); continue; }
    const needs = c.doc === ROOT_DOC ? listed(c.block, 'applies-to').map((id) => targetShown(id, [])).filter((l): l is number => l !== undefined) : [];
    if (needs.length) plan.ties.push({ holder: c.pos, needs });
  }
  for (const e of graph.edgesOf(GRAPH_ROOT)) {
    if (e.type !== 'depends-on' || e.status !== 'resolved' || e.to?.line === undefined || e.from.line === undefined) continue;
    if (e.to.file !== GRAPH_ROOT || !shownAt(ROOT_DOC, e.from.line) || !shownAt(ROOT_DOC, e.to.line)) continue;
    plan.ties.push({ holder: e.to.line, needs: [e.from.line] });
  }
  return plan;
}

/** The picks as the agent view's transform reads them. */
export function pickTest(picks: Picks): { lines: (doc: string, line: number) => boolean; refs: (doc: string, line: number) => boolean } {
  return {
    lines: (doc, line) => within(line, picks.ranges.get(doc) ?? []),
    refs: (doc, line) => picks.opens.get(doc)?.has(line) ?? false,
  };
}

/** Whether omitting `omitted` (sections as line ranges) keeps every tie. */
export function keepsTies(ties: readonly Tie[], omitted: ReadonlyArray<{ start: number; end: number }>): boolean {
  const cut = (line: number) => omitted.some((s) => line >= s.start && line <= s.end);
  return ties.every((t) => !cut(t.holder) || (!t.always && t.needs.every(cut)));
}
