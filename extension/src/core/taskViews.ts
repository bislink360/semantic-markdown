import { agentView, type AgentViewOptions, type AgentViewResult, type PinnedSelection } from './agentView';
import { parseFrontMatter } from './frontmatter';
import {
  DocumentGraph, mandatoryClosure, MANDATORY_EDGES, normalizePath, CLOSURE_LIMITS,
  type ClosureBlock, type DocumentRead, type GraphNode, type Unsatisfied,
} from './graph';
import { resolveId } from './ids';
import { parseSmd } from './parse';
import { querySmd, SelectorError, parseSelector } from './query';
import { matchesExactly, matchesHeading, sectionsOf, type Section } from './sections';
import { idList } from './spec';
import { suggest } from './util';

/**
 * Author task views (feedback loop RFC, "Author task views"; AF14, AF15, AF16, AF23). The front matter `views:` key
 * names views an author declares for a task:
 *
 *   views:
 *     implement-r1:
 *       sections: [Requirements]      # headings (text or id), with their subsections
 *       query: "requirement[id=R1]"   # a selector; the blocks it matches
 *       mandatory: [C1, R3]           # ids shown in full, with what they depend on
 *       optional: [AC1]               # ids shown as one-line pointers
 *       budget: 1500                  # tokens, with the overflow rule of --max-tokens
 *       evidence: full                # full | pointers (default)
 *       description: Implement R1
 *
 * The view is an agent view: the header, the document's agent instructions and dangers, the selected sections, then
 * the query's blocks and the mandatory blocks in document order under their headings, and at the end the pointers
 * and anything unsatisfied. Mandatory content is never omitted for the budget or condensed. Sections, a budget or
 * brief that the agent asks for on top are recorded as the agent's choice, apart from the author's policy.
 * Lines in a report are one-based, as in provenance.
 */

export const VIEW_KEYS: readonly string[] = ['sections', 'query', 'mandatory', 'optional', 'budget', 'evidence', 'description'];
export const VIEW_EVIDENCE: readonly string[] = ['pointers', 'full'];

/** A task view as the author declared it, read leniently: values of the wrong type are left out (the validator reports them). */
export interface TaskViewSpec {
  name: string;
  description?: string;
  sections: string[];
  query?: string;
  mandatory: string[];
  optional: string[];
  budget?: number;
  evidence?: 'full' | 'pointers';
}

/** A thrown error for a view name the document does not declare. */
export class TaskViewError extends Error {
  constructor(message: string, readonly names: readonly string[]) {
    super(message);
    this.name = 'TaskViewError';
  }
}

export interface TaskViewOptions extends Omit<AgentViewOptions, 'pinned'> {
  /** Reads a file the document's mandatory edges name (see DocumentGraph); by default `readFile`, relative to the document. */
  readDocument?: (path: string) => DocumentRead;
}

/** A block in a report: one-based lines. */
export interface ViewBlock { file: string; type: string; title: string; id?: string; line?: number; endLine?: number; section: string | null }

export interface ViewUnsatisfied {
  /** `query` for a selector that can't be read; a closure kind (missing, ambiguous, denied, cycle, depth, limit) otherwise. */
  kind: 'query' | Unsatisfied['kind'];
  /** What could not be satisfied: the id, the selector, or the target an edge names. */
  target: string;
  /** `mandatory` for an id the view lists, or the edge type followed. */
  via: string;
  /** One-based line the edge is written on. */
  line?: number;
  reason: string;
}

export interface TaskViewReport {
  name: string;
  description: string | null;
  /** What the author declared. */
  policy: {
    source: 'author'; view: string; sections: string[]; query: string | null; mandatory: string[]; optional: string[];
    budget: number | null; evidence: 'full' | 'pointers';
  };
  /** What the agent asked for on top. */
  agent: { sections: string[]; maxTokens: number | null; brief: boolean; exactSections: boolean; constraints: boolean };
  /** What the view was made with. */
  applied: { sections: string[]; maxTokens: number | null; brief: boolean; evidence: 'full' | 'pointers' };
  query: { selector: string; matches: ViewBlock[]; error?: string } | null;
  mandatory: Array<{ id: string; status: 'resolved' | 'missing' | 'ambiguous'; block?: ViewBlock; lines?: number[]; unstable?: true }>;
  /** Mandatory edges followed from the mandatory blocks, depth first. */
  paths: Array<{ from: ViewBlock; edge: string; line: number; to: ViewBlock; depth: number; shownInPlace: boolean }>;
  optional: Array<{ id: string; status: 'resolved' | 'missing' | 'ambiguous'; block?: ViewBlock; shown: boolean; tokens: number; retrieve?: string }>;
  unsatisfied: ViewUnsatisfied[];
  /** False when anything mandatory is unsatisfied, or the budget can't hold the required content. */
  complete: boolean;
}

export interface TaskViewResult extends AgentViewResult {
  view: TaskViewReport;
}

// ---------------------------------------------------------------------------
// Reading the views
// ---------------------------------------------------------------------------

const isMapping = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A list of headings: one string is one heading (its text may hold commas). */
function headingList(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter(Boolean) : [];
}

/** A list of ids: `C1, R3` or `[C1, R3]`. */
function idValues(v: unknown): string[] {
  if (typeof v === 'string') return idList(v);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').flatMap((x) => idList(String(x))) : [];
}

/** A budget: a whole number above 0, or (spec v2 keeps YAML spelling) a string of digits. */
function budgetValue(v: unknown): number | undefined {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The task views a document declares, in the order written. */
export function taskViews(text: string): TaskViewSpec[] {
  const views = parseFrontMatter(text).data.views;
  if (!isMapping(views)) return [];
  return Object.entries(views).filter(([, v]) => isMapping(v)).map(([name, raw]) => {
    const v = raw as Record<string, unknown>;
    const budget = budgetValue(v.budget);
    const evidence = typeof v.evidence === 'string' && VIEW_EVIDENCE.includes(v.evidence.toLowerCase()) ? v.evidence.toLowerCase() as 'full' | 'pointers' : undefined;
    return {
      name,
      ...(typeof v.description === 'string' && v.description.trim() ? { description: v.description.trim() } : {}),
      sections: headingList(v.sections),
      ...(typeof v.query === 'string' && v.query.trim() ? { query: v.query.trim() } : {}),
      mandatory: idValues(v.mandatory),
      optional: idValues(v.optional),
      ...(budget ? { budget } : {}),
      ...(evidence ? { evidence } : {}),
    };
  });
}

/** The view named `name`. Throws a TaskViewError listing the names when there is none. */
export function findTaskView(text: string, name: string): TaskViewSpec {
  const views = taskViews(text);
  const found = views.find((v) => v.name === name) ?? views.find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  const names = views.map((v) => v.name);
  if (!names.length) throw new TaskViewError(`No task view "${name}": the document declares no views (front matter views:).`, names);
  const hint = suggest(name, names);
  throw new TaskViewError(`No task view "${name}".${hint ? ` Did you mean "${hint}"?` : ''} Views: ${names.join(', ')}.`, names);
}

// ---------------------------------------------------------------------------
// Building a view
// ---------------------------------------------------------------------------

const folderOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

/** The view an author declared, as an agent view (see the module comment). Throws a TaskViewError for an unknown name. */
export function taskView(text: string, name: string, options: TaskViewOptions = {}): TaskViewResult {
  const spec = findTaskView(text, name);
  const file = options.file ?? '<file>';
  const path = normalizePath(file);
  const lines = text.split(/\r?\n/);
  const sections = sectionsOf(parseSmd(text).headings, lines.length);
  const today = options.today;
  const graph = new DocumentGraph([{ path, text }], { readDocument: options.readDocument ?? readerOf(path, options.readFile), today });
  const block = (n: GraphNode): ViewBlock => ({
    file: n.file, type: n.type, title: n.title, ...(n.id ? { id: n.id } : {}),
    ...(n.line === undefined ? {} : { line: n.line + 1, endLine: (n.endLine ?? n.line) + 1 }), section: n.section,
  });

  const agentSections = options.sections ?? [];
  const appliedSections = [...new Set([...spec.sections, ...agentSections])];
  const matches = options.exactSections ? matchesExactly : matchesHeading;
  const selected = sections.filter((s) => appliedSections.some((q) => matches(s.heading, q)));
  const inSelected = (line: number) => selected.some((s) => line >= s.start && line <= s.end);
  const unsatisfied: ViewUnsatisfied[] = [];

  // The query's blocks.
  let query: TaskViewReport['query'] = null;
  const ranges: Array<readonly [number, number]> = [];
  if (spec.query) {
    try {
      const found = querySmd(text, parseSelector(spec.query), { today });
      query = { selector: spec.query, matches: found.map((m) => ({ file: path, type: m.type, title: m.title, ...(typeof m.attrs.id === 'string' ? { id: m.attrs.id } : {}), line: m.line + 1, endLine: m.endLine + 1, section: m.section })) };
      for (const m of found) ranges.push([m.line, m.endLine]);
    } catch (e) {
      if (!(e instanceof SelectorError)) throw e;
      query = { selector: spec.query, matches: [], error: e.message };
      unsatisfied.push({ kind: 'query', target: spec.query, via: 'query', reason: `the query is not a valid selector: ${e.message}` });
    }
  }

  // The mandatory blocks and their closure.
  const mandatory: TaskViewReport['mandatory'] = [];
  const starts: GraphNode[] = [];
  for (const id of spec.mandatory) {
    const found = graph.resolve(path, id);
    const node = found.node;
    if (found.status === 'resolved' && node && node.line !== undefined) {
      starts.push(node);
      const stable = resolveId(text, id);
      mandatory.push({ id, status: 'resolved', block: block(node), ...(stable.status === 'resolved' && !stable.stable ? { unstable: true as const } : {}) });
    } else {
      const status = found.status === 'ambiguous' ? 'ambiguous' : 'missing';
      mandatory.push({ id, status, ...(found.lines ? { lines: found.lines.map((l) => l + 1) } : {}) });
      unsatisfied.push({
        kind: status, target: id, via: 'mandatory',
        reason: status === 'ambiguous' ? `is the id of ${found.lines?.length ?? 2} blocks (lines ${(found.lines ?? []).map((l) => l + 1).join(', ')}), so it names none of them` : 'names no block of this document',
      });
    }
  }
  const closure = starts.length ? mandatoryClosure(graph, starts, { types: MANDATORY_EDGES }) : { blocks: [], unsatisfied: [], complete: true };
  for (const u of closure.unsatisfied) unsatisfied.push(closureProblem(u));
  // An include in a mandatory block is shown in place when includes are on.
  const inPlace = (b: ClosureBlock) => b.node.file === path || (b.edge.type === 'include' && options.includes !== false && b.via.file === path);
  const whole: Array<readonly [number, number]> = [];
  for (const n of [...starts, ...closure.blocks.filter((b) => b.node.file === path).map((b) => b.node)]) {
    if (n.line === undefined) continue;
    const range = [n.line, n.endLine ?? n.line] as const;
    ranges.push(range);
    whole.push(range);
  }
  const paths = closure.blocks.map((b) => ({ from: block(b.via), edge: b.edge.type, line: b.edge.line + 1, to: block(b.node), depth: b.depth, shownInPlace: inPlace(b) }));
  const elsewhere = closure.blocks.filter((b) => !inPlace(b));

  // Headings above each pinned block, so it reads in its place.
  const context = ranges.filter(([a]) => !inSelected(a)).flatMap(([a]) => headingsAbove(sections, a).map((s) => [s.start, s.start] as const));
  // With the blank lines around each block, so blocks stay apart as in the document.
  const blank = (l: number) => l >= 0 && l < lines.length && !lines[l].trim();
  const padded = [...ranges, ...context].map(([a, b]) => [blank(a - 1) ? a - 1 : a, blank(b + 1) ? b + 1 : b] as const);
  const pinnedRanges = merged(padded);
  const shownAt = (line: number) => inSelected(line) || pinnedRanges.some(([a, b]) => line >= a && line <= b);

  const optional: TaskViewReport['optional'] = spec.optional.map((id) => {
    const found = graph.resolve(path, id);
    if (found.status !== 'resolved' || !found.node) return { id, status: found.status === 'ambiguous' ? 'ambiguous' as const : 'missing' as const, shown: false, tokens: 0 };
    const node = found.node;
    const shown = node.line !== undefined && shownAt(node.line);
    const retrieve = node.type === 'heading' ? `smd agent ${quoteArg(file)} --section "${id}"` : `smd query "*[id=${id}]" ${quoteArg(file)}`;
    return { id, status: 'resolved' as const, block: block(node), shown, tokens: shown ? 0 : graph.tokens(node), retrieve };
  });

  const evidence = options.evidence ?? spec.evidence ?? 'pointers';
  const maxTokens = options.maxTokens ?? spec.budget;
  const lineRefs = options.lineRefs ?? true;
  const pinned: PinnedSelection = {
    ranges: pinnedRanges,
    whole: merged(whole),
    selects: appliedSections.length > 0 || !!spec.query || spec.mandatory.length > 0,
    label: viewLabel(spec, agentSections),
    appendix: appendix(optional, elsewhere, unsatisfied, file, lineRefs),
  };
  const { readDocument: _, ...viewOptions } = options;
  const result = agentView(text, { ...viewOptions, sections: appliedSections.length ? appliedSections : undefined, maxTokens, evidence, pinned });

  const report: TaskViewReport = {
    name: spec.name,
    description: spec.description ?? null,
    policy: {
      source: 'author', view: spec.name, sections: spec.sections, query: spec.query ?? null, mandatory: spec.mandatory, optional: spec.optional,
      budget: spec.budget ?? null, evidence: spec.evidence ?? 'pointers',
    },
    agent: { sections: agentSections, maxTokens: options.maxTokens ?? null, brief: !!options.brief, exactSections: !!options.exactSections, constraints: !!options.constraints },
    applied: { sections: appliedSections, maxTokens: maxTokens ?? null, brief: !!options.brief || !!result.budget?.condensed, evidence },
    query,
    mandatory,
    paths,
    optional,
    unsatisfied,
    complete: unsatisfied.length === 0 && result.budget?.fits !== false,
  };
  if (result.provenance) result.provenance.view = report;
  return { ...result, view: report };
}

/** What `readFile` (relative to the document) reads, as a graph reader of normalized paths. */
function readerOf(path: string, readFile: AgentViewOptions['readFile']): ((p: string) => DocumentRead) | undefined {
  if (!readFile) return undefined;
  const dir = folderOf(path);
  return (p) => {
    const rel = dir && p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p;
    const content = readFile(rel);
    return content === undefined ? { status: 'missing' } : { text: content };
  };
}

function closureProblem(u: Unsatisfied): ViewUnsatisfied {
  const reasons: Record<Unsatisfied['kind'], string> = {
    missing: 'names nothing that exists',
    ambiguous: `is the id of blocks on lines ${(u.edge.lines ?? []).map((l) => l + 1).join(', ')}, so it names none of them`,
    denied: `is in ${u.edge.file}, which this view may not read`,
    cycle: `closes a cycle: ${(u.path ?? []).map((n) => n.id ?? n.title).join(' → ')}`,
    depth: `is more than ${CLOSURE_LIMITS.depth} hops from the mandatory blocks`,
    limit: `was left out: at most ${CLOSURE_LIMITS.blocks} dependencies are included`,
  };
  return { kind: u.kind, target: u.edge.target, via: u.edge.type, line: u.edge.line + 1, reason: reasons[u.kind] };
}

/** The headings whose sections hold `line`, outermost first, without the one that starts on it. */
function headingsAbove(sections: readonly Section[], line: number): Section[] {
  return sections.filter((s) => s.start < line && line <= s.end).sort((a, b) => a.start - b.start);
}

/** Ranges sorted, with overlapping and touching ones joined. */
function merged(ranges: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `(task view "implement-r1" — sections: Requirements; query: requirement[id=R1]; mandatory: C1, R3; the agent added sections: API)` */
function viewLabel(spec: TaskViewSpec, agentSections: readonly string[]): string {
  const parts = [
    spec.sections.length ? `sections: ${spec.sections.join(', ')}` : '',
    spec.query ? `query: ${spec.query}` : '',
    spec.mandatory.length ? `mandatory: ${spec.mandatory.join(', ')}` : '',
  ].filter(Boolean);
  const added = agentSections.filter((s) => !spec.sections.includes(s));
  if (added.length) parts.push(`the agent added sections: ${added.join(', ')}`);
  return `(task view "${spec.name}"${parts.length ? ` — ${parts.join('; ')}` : ''})`;
}

function appendix(
  optional: TaskViewReport['optional'], elsewhere: readonly ClosureBlock[], unsatisfied: readonly ViewUnsatisfied[], file: string, lineRefs: boolean,
): string {
  const out: string[] = [];
  if (elsewhere.length) {
    out.push('Dependencies in other files (mandatory, in full):');
    for (const b of elsewhere) {
      const at = b.node.line === undefined ? b.node.file : `${b.node.file}:${b.node.line + 1}`;
      out.push(`${at}  (${b.edge.type} from L${b.edge.line + 1})`, b.text.trim() || '(empty)');
    }
  }
  if (optional.length) {
    if (out.length) out.push('');
    out.push('Optional context (pointers, not read):');
    for (const o of optional) out.push(optionalLine(o, lineRefs));
  }
  if (unsatisfied.length) {
    if (out.length) out.push('');
    out.push('Unsatisfied requirements of this view:');
    for (const u of unsatisfied) out.push(`- ${u.via === 'mandatory' ? 'mandatory' : u.via} "${u.target}"${u.line ? ` (L${u.line})` : ''} ${u.reason}`);
    out.push(`This view is incomplete: ${unsatisfied.length} requirement${unsatisfied.length === 1 ? ' is' : 's are'} unsatisfied.`);
  }
  return out.join('\n');
}

/** `-> AC1  acceptance  Checkout succeeds  [L50]  §Acceptance  ≈60 tokens — smd query "*[id=AC1]" plan.smd` */
function optionalLine(o: TaskViewReport['optional'][number], lineRefs: boolean): string {
  if (o.status !== 'resolved' || !o.block) return `-> ${o.id}  ${o.status}: ${o.status === 'missing' ? 'no block has this id' : 'two or more blocks have this id'}`;
  const b = o.block;
  const where = lineRefs && b.line !== undefined ? `[L${b.line}]` : '';
  const bits = [b.type, b.title, where, b.section ? `§${b.section}` : '', o.shown ? '(shown in this view)' : `≈${o.tokens} tokens — ${o.retrieve}`];
  return `-> ${o.id}  ${bits.filter(Boolean).join('  ')}`;
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

// ---------------------------------------------------------------------------
// For people: --inspect and --views
// ---------------------------------------------------------------------------

const lineSpan = (b: ViewBlock) => (b.line === undefined ? '' : b.endLine && b.endLine > b.line ? `L${b.line}-L${b.endLine}` : `L${b.line}`);
const blockName = (b: ViewBlock) => [b.id ?? '', b.type, b.title ? `"${b.title}"` : '', lineSpan(b)].filter(Boolean).join(' ');

/** A plain account of a task view for people: what the author selected, what the agent added, and what came of it. */
export function formatTaskViewInspection(result: TaskViewResult, file = '<file>'): string {
  const v = result.view;
  const out: string[] = [`Task view "${v.name}" of ${file}${v.description ? ` — ${v.description}` : ''}`, ''];
  const resolved = new Map((result.resolvedSections ?? []).map((r) => [r.query, r.headings]));
  const sectionText = (q: string) => {
    const hs = resolved.get(q) ?? [];
    return hs.length ? `${q} (${hs.map((h) => `L${h.line + 1}`).join(', ')})` : `${q} (no heading matches)`;
  };

  out.push('The author selected:');
  out.push(`  sections: ${v.policy.sections.length ? v.policy.sections.map(sectionText).join(', ') : 'none'}`);
  if (v.query) {
    out.push(v.query.error ? `  query: ${v.query.selector} — not a valid selector` : `  query: ${v.query.selector} — ${v.query.matches.length} block(s)${v.query.matches.length ? `: ${v.query.matches.map(blockName).join(', ')}` : ''}`);
  } else {
    out.push('  query: none');
  }
  out.push(`  mandatory: ${v.mandatory.length ? v.mandatory.map((m) => (m.block ? `${blockName(m.block)}${m.unstable ? ' (heading slug, unstable)' : ''}` : `${m.id} (${m.status})`)).join(', ') : 'none'}`);
  out.push(`  optional: ${v.optional.length ? v.optional.map((o) => o.id).join(', ') : 'none'}`);
  out.push(`  budget: ${v.policy.budget ?? 'none'} · evidence: ${v.policy.evidence}`);
  out.push('');
  const a = v.agent;
  const added = [
    a.sections.length ? `sections: ${a.sections.map(sectionText).join(', ')}` : '',
    a.maxTokens !== null ? `max tokens: ${a.maxTokens}` : '',
    a.brief ? 'brief' : '',
    a.exactSections ? 'exact section matching' : '',
    a.constraints ? 'constraints' : '',
  ].filter(Boolean);
  out.push(`The agent added: ${added.length ? added.join(' · ') : 'nothing'}`);
  out.push('');

  out.push('Mandatory closure:');
  if (!v.paths.length) out.push('  no dependencies to follow');
  for (const p of v.paths) {
    // An applies-to edge is written in the constraint and points at the block it binds.
    const arrow = p.edge === 'applies-to' ? `<-${p.edge} (L${p.line})--` : `--${p.edge} (L${p.line})->`;
    const where = p.shownInPlace ? '' : ` in ${p.to.file}, in full at the end of the view`;
    out.push(`  ${'  '.repeat(p.depth - 1)}${p.from.id ?? p.from.type} ${arrow} ${blockName(p.to)}${where}`);
  }
  out.push('');

  out.push('Pointers (not read):');
  if (!v.optional.length) out.push('  none');
  for (const o of v.optional) {
    if (!o.block) out.push(`  ${o.id}: ${o.status}`);
    else out.push(`  ${blockName(o.block)} — ${o.shown ? 'already shown in this view' : `≈${o.tokens} tokens, ${o.retrieve}`}`);
  }
  out.push('');

  out.push('Left out:');
  const left = [
    ...result.missingSections.map((s) => `  section "${s}": no heading matches`),
    ...(result.budget?.omitted ?? []).map((o) => `  ${'#'.repeat(o.level)} ${o.heading} (L${o.line + 1}-L${o.endLine + 1}, ≈${o.tokens} tokens): for the budget`),
    ...result.skippedSections.map((s) => `  ${s}: marked {agent=skip}`),
  ];
  out.push(...(left.length ? left : ['  nothing beyond the sections not selected']));
  out.push('');

  const b = result.budget;
  const unit = result.counted ? `${result.counted.tokenizer} tokens` : 'tokens';
  if (b) out.push(`Budget: ${b.maxTokens} ${unit} (${a.maxTokens !== null ? 'the agent\'s' : 'the author\'s'}); the view is ${result.counted ? '' : '≈'}${b.tokens}, ${b.fits ? 'it fits' : 'required content does not fit'}${b.condensed ? ', condensed as brief' : ''}.`);
  else out.push(`Budget: none; the view is ≈${result.tokens} tokens.`);
  if (v.complete) out.push('Complete: yes.');
  else {
    out.push('Complete: no.');
    for (const u of v.unsatisfied) out.push(`  ${u.via} "${u.target}"${u.line ? ` (L${u.line})` : ''} ${u.reason}`);
    if (b && !b.fits) out.push('  the required content is over the budget');
  }
  return out.join('\n') + '\n';
}

/** The views a document declares, one line each, for `smd agent <file> --views`. */
export function formatTaskViewList(text: string, file = '<file>'): string {
  const views = taskViews(text);
  if (!views.length) return `${file} declares no task views (front matter views:).\n`;
  const width = Math.max(...views.map((v) => v.name.length));
  const out = [`Task views of ${file}:`];
  for (const v of views) {
    const facts = [
      v.sections.length ? `sections: ${v.sections.join(', ')}` : '',
      v.query ? `query: ${v.query}` : '',
      v.mandatory.length ? `${v.mandatory.length} mandatory` : '',
      v.optional.length ? `${v.optional.length} optional` : '',
      v.budget ? `budget ${v.budget}` : '',
      v.evidence === 'full' ? 'evidence in full' : '',
    ].filter(Boolean).join(' · ');
    out.push(`  ${v.name.padEnd(width)}  ${v.description ? `${v.description} — ` : ''}${facts || 'the whole document'}`);
  }
  out.push('', `Read one: smd agent ${quoteArg(file)} --view <name>   (--inspect explains what it selects)`);
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export interface TaskViewProblem {
  /** Zero-based line and columns in the front matter. */
  line: number;
  column: number;
  endColumn: number;
  severity: 'warning';
  code: 'views/key' | 'views/section' | 'views/query' | 'views/value' | 'ref/unknown' | 'ref/ambiguous';
  message: string;
}

/**
 * Problems in the front matter `views:` key: a view or value of the wrong shape, an unknown key in a view, a section
 * that names no heading, a query that is not a selector, and mandatory or optional ids that name nothing or two blocks.
 */
export function taskViewProblems(text: string): TaskViewProblem[] {
  const fm = parseFrontMatter(text);
  const views = fm.data.views;
  if (views === undefined || views === null) return [];
  const lines = text.split(/\r?\n/);
  const where = frontMatterPlaces(lines, fm.bodyStartLine);
  const problems: TaskViewProblem[] = [];
  const add = (at: [number, number, number], code: TaskViewProblem['code'], message: string) =>
    problems.push({ line: at[0], column: at[1], endColumn: at[2], severity: 'warning', code, message });
  if (!isMapping(views)) {
    add(where(), 'views/value', '"views" should be a mapping of view names to views, e.g. views: { implement: { sections: [Goals] } }.');
    return problems;
  }
  const sections = sectionsOf(parseSmd(text).headings, lines.length);
  for (const [name, view] of Object.entries(views)) {
    if (!isMapping(view)) {
      add(where(name), 'views/value', `The view "${name}" should be a mapping with sections, query, mandatory, optional, budget, evidence or description.`);
      continue;
    }
    for (const [key, value] of Object.entries(view)) {
      const at = (entry?: string) => where(name, key, entry);
      if (!VIEW_KEYS.includes(key)) {
        const hint = suggest(key, [...VIEW_KEYS]);
        add(at(), 'views/key', `"${key}" is not a key of a task view${hint ? ` — did you mean "${hint}"?` : '.'} Keys: ${VIEW_KEYS.join(', ')}.`);
        continue;
      }
      if (value === null || value === undefined) continue;
      if (key === 'sections') {
        if (!isList(value)) { add(at(), 'views/value', `"sections" in the view "${name}" should be a list of headings.`); continue; }
        for (const q of headingList(value)) {
          if (!sections.some((s) => matchesHeading(s.heading, q))) add(at(q), 'views/section', `No heading matches "${q}", so the view "${name}" selects nothing for it.`);
        }
      } else if (key === 'query') {
        if (typeof value !== 'string') { add(at(), 'views/value', `"query" in the view "${name}" should be a selector, e.g. "requirement[id=R1]".`); continue; }
        try { parseSelector(value); } catch (e) {
          if (!(e instanceof SelectorError)) throw e;
          add(at(), 'views/query', `The query of the view "${name}" is not a valid selector: ${e.message}`);
        }
      } else if (key === 'mandatory' || key === 'optional') {
        if (!isList(value)) { add(at(), 'views/value', `"${key}" in the view "${name}" should be a list of block ids.`); continue; }
        for (const id of idValues(value)) {
          const found = resolveId(text, id);
          if (found.status === 'missing') add(at(id), 'ref/unknown', `No block with id "${id}" in this document, so ${key} in the view "${name}" names nothing.`);
          else if (found.status === 'ambiguous') {
            add(at(id), 'ref/ambiguous', `"${id}" in ${key} of the view "${name}" is the id of ${found.lines.length} blocks (lines ${found.lines.map((l) => l + 1).join(', ')}), so it names none of them.`);
          }
        }
      } else if (key === 'budget') {
        if (budgetValue(value) === undefined) add(at(), 'views/value', `"budget" in the view "${name}" should be a whole number of tokens, e.g. budget: 1500.`);
      } else if (key === 'evidence') {
        if (typeof value !== 'string' || !VIEW_EVIDENCE.includes(value.toLowerCase())) add(at(), 'views/value', `"evidence" in the view "${name}" should be pointers or full.`);
      } else if (typeof value !== 'string') {
        add(at(), 'views/value', `"description" in the view "${name}" should be text.`);
      }
    }
  }
  return problems;
}

const isList = (v: unknown) => typeof v === 'string' || Array.isArray(v);

/**
 * Where a view, a key of a view, or an entry of its list is written in the front matter: [line, column, end]. Falls
 * back to the closest place found (the view, then the `views:` line, then the opening `---`).
 */
function frontMatterPlaces(lines: string[], end: number): (view?: string, key?: string, entry?: string) => [number, number, number] {
  const top = lines.findIndex((l, i) => i > 0 && i < end && /^views\s*:/.test(l));
  const whole = (i: number): [number, number, number] => [i, lines[i].length - lines[i].trimStart().length, Math.max(1, lines[i].length)];
  // The lines of the views key: until the next line that is not indented.
  let last = top;
  if (top > 0) while (last + 1 < end - 1 && (!lines[last + 1].trim() || /^\s/.test(lines[last + 1]))) last++;
  const indent = (i: number) => lines[i].length - lines[i].trimStart().length;
  const keyLine = (from: number, to: number, key: string) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s+["']?${escaped}["']?\\s*:`);
    for (let i = from; i <= to; i++) if (re.test(lines[i])) return i;
    return -1;
  };
  const blockEnd = (i: number) => {
    let j = i;
    while (j + 1 <= last && (!lines[j + 1].trim() || indent(j + 1) > indent(i))) j++;
    return j;
  };
  return (view, key, entry) => {
    if (top < 1) return [0, 0, 3];
    if (!view) return whole(top);
    const v = keyLine(top + 1, last, view);
    if (v < 0) return whole(top);
    if (!key) return whole(v);
    const k = keyLine(v + 1, blockEnd(v), key);
    if (k < 0) return whole(v);
    if (entry === undefined) return whole(k);
    for (let i = k; i <= blockEnd(k); i++) {
      const at = lines[i].indexOf(entry, i === k ? lines[i].indexOf(':') + 1 : 0);
      if (at >= 0) return [i, at, at + entry.length];
    }
    return whole(k);
  };
}
