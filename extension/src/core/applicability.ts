import {
  contains, cycleKey, cyclesAmong, DocumentGraph, mandatoryClosure, nodeKey, CLOSURE_LIMITS,
  type ClosureBlock, type DocumentRead, type GraphNode, type SharedId, type UnsatisfiedKind,
} from './graph';
import { documentIdIndex, resolveDocumentId } from './includedIds';
import { includeLabel, includeProblemText, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope } from './include';
import { includeSource } from './includeText';
import { idOwners, parseSmd } from './parse';
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
 *
 * Constraints and dependencies bring each other in. A constraint whose `applies-to` names a dependency the view adds
 * applies too, and what that constraint depends on is a dependency in turn, so the two are worked out in rounds until
 * a round adds no constraint. A constraint the view carries counts as shown, so its own dependencies start at step 1;
 * the closure's limits (CLOSURE_LIMITS) bound what the rounds add and report what they cut.
 *
 * A dependency the view adds is content of the view, so the rule above applies to it as to a selected section: it
 * brings the `scope=section` constraints of the section it sits in (an included one counts where its include is), and
 * the constraints whose `applies-to` names it or a heading above it. A dependency read from another document (not
 * included) brings that document's constraints by the same rule, with its `scope=document` constraints too, and a
 * constraint of this document that names it (`applies-to=other.smd#R2`) applies as well. A constraint is never a
 * reason for itself, and a dependency hidden from agents brings nothing.
 *
 * An accepted decision with `applies-to` is a rule too (4.1.0): it applies by what its `applies-to` names, as a
 * constraint does, and never by scope, so a decision without `applies-to` is never carried. The view lists the
 * decisions it carries apart from the constraints (`decisions` in the mandatory context).
 *
 * A constraint whose `applies-to` names no block the reader can find (a typo, a deleted id, a file that cannot be
 * read) is `unplaced`. It applies to every view, a budget never omits it, and every view lists the unknown target
 * under "Not satisfied" and is incomplete until an author fixes it (research contract, 2026-11-10).
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
  /**
   * Why it applies: its scope, what its `applies-to` names, or `unplaced` when an `applies-to` target names no block
   * the reader can find, so the constraint is shown in every read until an author fixes it.
   */
  applies: 'document' | 'section' | 'applies-to' | 'unplaced';
  /** The `applies-to` targets that are hidden from agents ({agent=skip} or :::human), so the view shows the rule without them (t-66). */
  hiddenTargets?: string[];
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

/** `unresolved-target`: a constraint's `applies-to` names no block the reader can find (research contract, 2026-11-10). */
export type MandatoryProblem = UnsatisfiedKind | 'hidden' | 'include' | 'unresolved-target';

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
 * adds, and what it could not satisfy. `complete` is the three parts of `completeness` together.
 */
export interface MandatoryContext {
  constraints: AppliedConstraint[];
  /** Accepted decisions with `applies-to` that the view carries, by the same rule (4.1.0). Absent when there are none. */
  decisions?: AppliedConstraint[];
  dependencies: IncludedDependency[];
  unsatisfied: UnsatisfiedDependency[];
  complete: boolean;
  /** Which part of completeness failed, if any (t-63). */
  completeness: Completeness;
}

/**
 * The three ways a view can fall short of what it must carry (research contract, view laws L3 and L5; t-63). A
 * problem belongs to one part, by its kind (see PART_OF).
 */
export interface Completeness {
  /** Every applicable rule and every dependency the view needs was carried: none hidden from agents or cut at a limit. */
  coverage: boolean;
  /** Every rule target, dependency and include resolved: none missing, ambiguous, denied, unread or in a cycle. */
  resolution: boolean;
  /** What the view must carry fit its token budget; true without a budget. */
  budget: boolean;
}

/** The part of completeness each kind of problem breaks. */
export const PART_OF: Readonly<Record<MandatoryProblem, 'coverage' | 'resolution'>> = {
  hidden: 'coverage', depth: 'coverage', limit: 'coverage',
  missing: 'resolution', ambiguous: 'resolution', denied: 'resolution', cycle: 'resolution', include: 'resolution', 'unresolved-target': 'resolution',
};

/** Completeness from the problems a view has, and whether its budget fit. */
export function completenessOf(unsatisfied: readonly UnsatisfiedDependency[], fits = true): Completeness {
  return {
    coverage: !unsatisfied.some((u) => PART_OF[u.kind] === 'coverage'),
    resolution: !unsatisfied.some((u) => PART_OF[u.kind] === 'resolution'),
    budget: fits,
  };
}

/**
 * The line that ends a view's "Not satisfied" list: which part failed and for what, e.g. `[incomplete: resolution
 * failed for 1 rule target and 1 include; coverage failed for 2 dependencies]`. A rule target is not a dependency.
 */
export function incompleteLine(unsatisfied: readonly UnsatisfiedDependency[]): string {
  const parts: string[] = [];
  for (const part of ['resolution', 'coverage'] as const) {
    const mine = unsatisfied.filter((u) => PART_OF[u.kind] === part);
    if (!mine.length) continue;
    const count = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
    const targets = mine.filter((u) => u.kind === 'unresolved-target').length;
    const includes = mine.filter((u) => u.kind === 'include').length;
    const items = [
      ...count(targets, 'rule target', 'rule targets'), ...count(includes, 'include', 'includes'),
      ...count(mine.length - targets - includes, 'dependency', 'dependencies'),
    ];
    parts.push(`${part} failed for ${items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]}`);
  }
  return `[incomplete: ${parts.join('; ')}]`;
}

/** A block a view carries from a file no include of the document reaches, with its zero-based first and last line there. */
export interface ExtraBlock { file: string; text: string; line: number; end: number }

/** Omitting the section that holds `holder` needs every line of `needs` omitted too; `always` never allows it. */
export interface Tie { holder: number; needs: number[]; always?: boolean }

/** What agentView needs to show the mandatory context (see agentView's applyingHead and dependencyHead). */
export interface MandatoryPlan {
  context: MandatoryContext;
  applying: Picks;
  dependencies: Picks;
  /** Dependencies in included text that no include of the document reaches: file, agent view and lines. */
  extra: ExtraBlock[];
  /** Applying constraints of documents read for a dependency, which no include reaches: file, agent view and lines. */
  applyingExtra: ExtraBlock[];
  unsatisfied: string[];
  /** Budget rules (see Tie), lines of the document. */
  ties: Tie[];
  /** Where each constraint sits in the document (an include's line for an included one). */
  constraintAt: number[];
  /** Lines of the document's own constraints that apply to the view, shown in place or in the head. */
  applyingLines: Set<number>;
  /** The document or a file it includes has a `:::constraint` block. */
  hasConstraints: boolean;
  /** Ids that carried constraints name in `applies-to` and that are hidden from agents (t-66). */
  hiddenTargets: Set<string>;
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

const MAY_HOLD = /:{3,}\s*constraint(?![\w-])|depends-on|:depends\[|applies-to/i;

/**
 * A block that binds what it names or where it sits: every `:::constraint`, and an accepted `:::decision` with
 * `applies-to` (4.1.0). A decision applies only by its `applies-to`, never by scope.
 */
export function isRuleBlock(b: TagBlock): boolean {
  if (b.name === 'constraint') return true;
  return b.name === 'decision' && listed(b, 'applies-to').length > 0 && (b.values.status ?? '').trim().toLowerCase() === 'accepted';
}
const HIDING = new Set(['agent', 'danger']);

const within = (line: number, ranges: ReadonlyArray<readonly [number, number]>) => ranges.some(([a, b]) => line >= a && line <= b);

/** Reasons an include was not read that are a choice of the caller or the host, not a failure to read it. */
const NOT_TRIED: ReadonlySet<string> = new Set(['includes are off', 'no reader for included files']);
/** Whether the reader tried to read an include and could not (a missing file or section, a cycle, a limit). */
const readFailed = (r: FoundInclude) => !r.ok && !NOT_TRIED.has(r.reason ?? '');

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
      if (isRuleBlock(b)) constraints.push({ doc, block: b, pos, inPlace: shown });
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

  const hasConstraints = constraints.some((c) => c.block.name === 'constraint');
  // An include the reader tried and failed to read leaves the view incomplete, rules or not (decided 2026-11-12).
  const failedRead = includes.some(readFailed);
  if (!constraints.length && !failedRead && !docs.some((d) => /depends-on|:depends\[/i.test(d.text))) return undefined;
  // An id names a block of the document or of what its includes show, as rendering has it (t-59): one index for the
  // document and every file it includes, so a rule on an included block resolves, and fallback text never does.
  const ids = documentIdIndex(text, input.includes ? input.readFile : undefined);
  const tree = new Set(docs.map((d) => d.path));
  const sharedId = (path: string, id: string): SharedId | undefined => {
    if (!tree.has(path)) return undefined;
    const found = resolveDocumentId(ids, id);
    if (found.status === 'resolved') return { status: 'resolved', file: found.site.file === ROOT_DOC ? GRAPH_ROOT : found.site.file, line: found.site.line };
    if (found.status === 'ambiguous') return { status: 'ambiguous', lines: found.sites.map((s) => s.line) };
    // Ids rendering makes up (footnotes) have no block: the document's own lookup decides them.
    const own = docs.find((d) => d.path === path)!;
    return idOwners(own.text).has(id) ? { status: 'missing' } : undefined;
  };
  // Other files a dependency names are read through the host, relative to the document (the root's folder is '').
  const graph = new DocumentGraph(docs.map((d) => ({ path: d.path, text: d.text })), { readDocument: input.readDocument, ids: sharedId });
  // A word in prose or code is not a dependency: only an edge is.
  const hasEdges = docs.some((d) => graph.edgesOf(d.path).some((e) => e.type === 'depends-on'));
  if (!constraints.length && !failedRead && !hasEdges) return undefined;
  // Without a rule or a dependency only a failed read matters: includes turned off, or a host with no file reader,
  // leave such a view as it was.
  const quietIncludes = !constraints.length && !hasEdges;

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

  /** Where a dependency the view adds sits in the document: its line, or the line of each include that reaches it. A hidden one sits nowhere. */
  const spotsOf = (p: ClosureBlock): number[] => {
    const line = p.node.line!;
    if (within(line, hiddenIn(p.node.file))) return [];
    if (p.node.file === GRAPH_ROOT) return [line];
    return includes.filter((r) => r.ok && r.path === p.node.file && line >= r.start && line <= r.end).map((r) => r.pos);
  };

  /**
   * Whether the block `id` names (in the document or in what an include shows) is shown by the view or is one of the
   * dependencies added so far: the document's line where it sits (an include's line for an included block), or undefined.
   */
  const targetShown = (id: string, pulled: readonly ClosureBlock[] = []): number | undefined => {
    const found = resolveDocumentId(ids, id);
    if (found.status !== 'resolved') return undefined;
    const { file, line } = found.site;
    const path = file === ROOT_DOC ? GRAPH_ROOT : file;
    const added = pulled.some((p) => p.node.file === path && line >= p.node.line! && line <= (p.node.endLine ?? p.node.line!));
    if (file !== ROOT_DOC) {
      const at = includes.filter((r) => r.ok && r.path === file && line >= r.start && line <= r.end);
      const pos = (at.find((r) => r.shown) ?? at[0])?.pos;
      return pos !== undefined && (shownAt(file, line) || added) ? pos : undefined;
    }
    const heading = sections.find((s) => s.start === line);
    // A heading binds its section, so a dependency the view adds from inside that section brings the constraint.
    if (heading) return overlapsView(heading) || added || pulled.flatMap(spotsOf).some((at) => at >= heading.start && at <= heading.end) ? line : undefined;
    return shownAt(ROOT_DOC, line) || added ? line : undefined;
  };

  // Documents read for a dependency: neither the document nor a file it includes.
  const given = new Set(docs.map((d) => d.path));
  const farOf = (pulled: readonly ClosureBlock[]) => pulled.filter((p) => !given.has(p.node.file));
  /** Whether an `applies-to` edge names a dependency read from another document, or a block inside one. */
  const namesFar = (e: { type: string; status: string; to?: GraphNode }, far: readonly ClosureBlock[]) =>
    e.type === 'applies-to' && e.status === 'resolved' && !!e.to && far.some((p) => contains(p.node, e.to!));

  /** A document read for a dependency: the constraints an agent may see, and its sections. */
  const farDocs = new Map<string, { rules: TagBlock[]; sections: Section[] }>();
  const farDoc = (path: string) => {
    if (!farDocs.has(path)) {
      const read = graph.document(path);
      const hidden = hiddenIn(path);
      farDocs.set(path, 'text' in read
        ? {
          rules: tagBlocks(read.text).filter((b) => isRuleBlock(b) && !within(b.line, hidden) && !parentHides(b, input.includeHuman)),
          sections: sectionsOf(parseSmd(read.text).headings, read.lines.length),
        }
        : { rules: [], sections: [] });
    }
    return farDocs.get(path)!;
  };
  type FarRule = { file: string; block: TagBlock; node: GraphNode; why: AppliedConstraint['applies'] };
  /**
   * The constraints of the documents `pulled` dependencies were read from that bind one of them, by the rule the
   * document's own constraints follow: its `applies-to` names the dependency or the heading of a section that holds
   * it, it is document-scoped, or it is section-scoped and the dependency sits in its section. A constraint that is
   * itself the dependency is not a reason for itself.
   */
  const farApplying = (pulled: readonly ClosureBlock[]): FarRule[] => {
    const far = farOf(pulled);
    const out: FarRule[] = [];
    for (const file of new Set(far.map((p) => p.node.file))) {
      const { rules, sections: farSections } = farDoc(file);
      if (!rules.length) continue;
      const hidden = hiddenIn(file);
      const edges = graph.edgesOf(file).filter((e) => e.type === 'applies-to' && e.status === 'resolved' && e.to);
      const read = far.filter((p) => p.node.file === file && !within(p.node.line!, hidden));
      for (const block of rules) {
        const node = graph.nodeAt(file, block.line);
        if (!node) continue;
        const others = read.filter((p) => !contains(node, p.node));
        const holds = (s: Section | undefined) => !!s && others.some((p) => p.node.line! >= s.start && p.node.line! <= s.end);
        const own = edges.filter((e) => e.from.line === block.line);
        const section = farSections.filter((s) => block.line >= s.start && block.line <= s.end).at(-1);
        let why: FarRule['why'] | undefined;
        if (own.some((e) => namesFar(e, far))) why = 'applies-to';
        else if (!others.length) why = undefined;
        else if (block.name === 'decision') why = own.some((e) => e.to!.file === file && holds(farSections.find((s) => s.start === e.to!.line))) ? 'applies-to' : undefined;
        else if ((block.values.scope ?? 'section').trim().toLowerCase() === 'document' || !section) why = 'document';
        else if (holds(section)) why = 'section';
        else if (own.some((e) => e.to!.file === file && holds(farSections.find((s) => s.start === e.to!.line)))) why = 'applies-to';
        if (why) out.push({ file, block, node, why });
      }
    }
    return out;
  };

  /** The `applies-to` targets of a constraint that resolve to no block: missing, ambiguous, or in a file not read. */
  const unresolvedOf = (c: FoundConstraint) => {
    if (!listed(c.block, 'applies-to').length) return [];
    return graph.edgesOf(c.doc === ROOT_DOC ? GRAPH_ROOT : c.doc)
      .filter((e) => e.type === 'applies-to' && e.from.line === c.block.line && e.status !== 'resolved');
  };

  /**
   * Why a constraint applies to the view, or undefined. One whose `applies-to` names a block nobody can find is
   * `unplaced` and applies to every view, so a mistyped target never switches a rule off without a trace.
   */
  const whyApplies = (c: FoundConstraint, pulled: readonly ClosureBlock[]): AppliedConstraint['applies'] | undefined =>
    whyBound(c, pulled) ?? (unresolvedOf(c).length ? 'unplaced' : undefined);

  const whyBound = (c: FoundConstraint, pulled: readonly ClosureBlock[]): AppliedConstraint['applies'] | undefined => {
    const scope = (c.block.values.scope ?? 'section').trim().toLowerCase();
    const section = sectionAt(c.pos);
    // A decision binds only what its applies-to names (4.1.0).
    const decision = c.block.name === 'decision';
    if (!decision && (scope === 'document' || !section)) return 'document';
    if (!decision && (!selected || selected.some((s) => s.start >= section!.start && s.end <= section!.end))) return 'section';
    if (listed(c.block, 'applies-to').some((id) => targetShown(id, pulled) !== undefined)) return 'applies-to';
    if (!pulled.length) return undefined;
    // Its applies-to names a dependency read from another document (`other.smd#R2`).
    const far = farOf(pulled);
    const path = c.doc === ROOT_DOC ? GRAPH_ROOT : c.doc;
    if (far.length && graph.edgesOf(path).some((e) => e.from.line === c.block.line && namesFar(e, far))) return 'applies-to';
    if (decision || !section) return undefined;
    // A dependency the view adds sits in its section. The constraint itself, added as a dependency, is not a reason.
    const self = (p: ClosureBlock) => docOf(p.node.file) === c.doc && p.node.line! >= c.block.line && p.node.line! <= c.block.endLine;
    return pulled.some((p) => !self(p) && spotsOf(p).some((at) => at >= section.start && at <= section.end)) ? 'section' : undefined;
  };

  const run = (pulled: readonly ClosureBlock[]) => {
    const head = constraints.filter((c) => !c.inPlace).map((c) => ({ c, why: whyApplies(c, pulled) })).filter((x) => x.why);
    const far = farApplying(pulled);
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
    // A carried constraint of another document is shown, and what it depends on is a dependency of the view.
    const started = new Set(starts.map(nodeKey));
    for (const rule of far) {
      shown.add(nodeKey(rule.node));
      for (const e of graph.edgesOf(rule.file)) {
        if (e.type !== 'depends-on' || e.from.line === undefined || !contains(rule.node, e.from)) continue;
        const key = nodeKey(e.from);
        if (!started.has(key)) { started.add(key); starts.push(e.from); }
      }
    }
    return { head, far, starts, closure: mandatoryClosure(graph, starts, { types: ['depends-on'], shown, maxDepth: CLOSURE_LIMITS.depth }) };
  };
  // Rounds, until one adds no constraint: a constraint that binds a dependency the view adds applies too, and what it
  // depends on is a dependency in turn. The dependencies of every round count (one that becomes a carried constraint
  // leaves the closure and is still content of the view), so the constraints only grow. Each round that goes on adds
  // one, and there are finitely many (the closure includes at most CLOSURE_LIMITS.blocks blocks and reports the
  // rest), so this ends.
  let round = run([]);
  const added = new Map<string, ClosureBlock>();
  for (;;) {
    for (const b of round.closure.blocks) added.set(nodeKey(b.node), b);
    if (!added.size) break;
    const next = run([...added.values()]);
    if (next.head.length + next.far.length <= round.head.length + round.far.length) break;
    round = next;
  }

  const plan: MandatoryPlan = {
    context: { constraints: [], dependencies: [], unsatisfied: [], complete: true, completeness: completenessOf([]) },
    applying: emptyPicks(), dependencies: emptyPicks(), extra: [], applyingExtra: [], unsatisfied: [], ties: [],
    constraintAt: constraints.map((c) => c.pos), applyingLines: new Set(), hasConstraints, hiddenTargets: new Set(),
  };

  /** The applies-to targets of a constraint that resolve to blocks hidden from agents, as written. */
  const hiddenTargetsOf = (file: string, line: number): string[] => [...new Set(graph.edgesOf(file)
    .filter((e) => e.type === 'applies-to' && e.from.line === line && e.status === 'resolved' && e.to?.line !== undefined && within(e.to.line, hiddenIn(e.to.file)))
    .map((e) => e.target))];
  /** Where a carried rule is listed: a decision under `decisions`, a constraint under `constraints`. */
  const ruleList = (b: TagBlock): AppliedConstraint[] => (b.name === 'decision' ? (plan.context.decisions ??= []) : plan.context.constraints);
  const hiddenMark = (targets: string[]) => {
    for (const t of targets) plan.hiddenTargets.add(t);
    return targets.length ? { hiddenTargets: targets } : {};
  };
  for (const { c, why } of round.head) {
    addPick(plan.applying, c.doc, c.block.line, c.block.endLine);
    const hidden = hiddenTargetsOf(c.doc === ROOT_DOC ? GRAPH_ROOT : c.doc, c.block.line);
    ruleList(c.block).push({ ...(c.block.id ? { id: c.block.id } : {}), title: c.block.title, file: fileName(c.doc), line: c.block.line + 1, applies: why!, ...hiddenMark(hidden) });
    if (c.doc === ROOT_DOC) plan.applyingLines.add(c.block.line);
  }
  for (const c of constraints) if (c.inPlace && c.doc === ROOT_DOC) plan.applyingLines.add(c.block.line);
  for (const rule of round.far) {
    plan.applyingExtra.push({ file: rule.file, text: graph.content(rule.node), line: rule.block.line, end: rule.block.endLine });
    ruleList(rule.block).push({
      ...(rule.block.id ? { id: rule.block.id } : {}), title: rule.block.title, file: rule.file, line: rule.block.line + 1, applies: rule.why,
      ...hiddenMark(hiddenTargetsOf(rule.file, rule.block.line)),
    });
  }

  const name = (n: GraphNode) => n.id ?? `${n.type} "${n.title}"`;
  const unsatisfied = (u: UnsatisfiedDependency) => {
    plan.context.unsatisfied.push(u);
    const where = u.file === input.file ? '' : ` in ${u.file}`;
    const what = u.kind === 'include' ? `included file ${u.target}`
      : u.kind === 'unresolved-target' ? `${u.via} applies to ${u.target}` : `${u.via} depends on ${u.target}`;
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
    else plan.extra.push({ file: doc, text: b.text, line, end });
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
  // A cycle among blocks the view shows is listed too, so every view that holds part of a cycle says so
  // (decided 2026-11-12). The closure already lists the ones it walked into.
  const walked = new Set(round.closure.unsatisfied.filter((u) => u.kind === 'cycle').map((u) => cycleKey(u.path!)));
  for (const c of cyclesAmong(graph, [...round.starts, ...round.closure.blocks.map((b) => b.node)], ['depends-on'])) {
    if (walked.has(cycleKey(c.path))) continue;
    unsatisfied({
      kind: 'cycle', target: c.edge.target, file: fileName(c.edge.from.file), line: c.edge.line + 1, via: name(c.via),
      reason: reasons.cycle({ path: c.path }),
    });
  }
  for (const r of includes) {
    if (r.ok || (quietIncludes && !readFailed(r))) continue;
    unsatisfied({ kind: 'include', target: r.label, file: fileName(r.doc), line: r.line + 1, reason: `not read (${r.reason})` });
  }
  // A constraint an agent can see whose applies-to names nothing: shown in every read, and the view says why.
  for (const c of constraints) {
    for (const e of unresolvedOf(c)) {
      const status = e.status as Exclude<typeof e.status, 'resolved'>;
      unsatisfied({
        kind: 'unresolved-target', target: e.target, file: fileName(c.doc), line: e.line + 1, via: c.block.id ?? `${c.block.name} "${c.block.title}"`,
        reason: `${reasons[status]({ lines: e.lines })}, so the ${c.block.name} is shown in every read`,
      });
    }
  }
  plan.context.completeness = completenessOf(plan.context.unsatisfied);
  plan.context.complete = plan.context.unsatisfied.length === 0;

  // Budget rules, on the document's lines: what applies or is depended on keeps its section.
  for (const c of constraints) {
    if (!c.inPlace) continue;
    const scope = (c.block.values.scope ?? 'section').trim().toLowerCase();
    if ((c.block.name !== 'decision' && (scope === 'document' || !sectionAt(c.pos))) || unresolvedOf(c).length) { plan.ties.push({ holder: c.pos, needs: [], always: true }); continue; }
    const needs = c.doc === ROOT_DOC ? listed(c.block, 'applies-to').map((id) => targetShown(id)).filter((l): l is number => l !== undefined) : [];
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
