import { keepsTies, mandatoryPlan, pickTest, ROOT_DOC, type MandatoryContext, type MandatoryPlan } from './applicability';
import { parseAttrs } from './attrs';
import { changelogEntries, versionLabel, type ChangelogEntry } from './changelog';
import {
  omissionOrder, omissionPointer, omittableSections, withOmitted, type BudgetResult, type BudgetSection, type Tokenizer,
} from './budget';
import { constraintBlock, type ConstraintPointer, type ConstraintView } from './constraints';
import { closedBy, closerColons, CONTAINER_CLOSE, CONTAINER_OPEN, isKnownContainer, parseContainerInfo, type ContainerInfo } from './containers';
import { parseFenceInfo, sliceLines } from './fence';
import { refDirective, type Figure, type FigureNumber } from './figures';
import { findFootnotes, type FootnoteDefinition } from './footnotes';
import { parseFrontMatter, asStringList, unreadFrontMatter } from './frontmatter';
import {
  includeLabel, includePath, includeProblemText, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope,
} from './include';
import {
  expandedFigures, figuresOf, includedAlerts, includedInlineItems, includedInlineMath, includedLines, includedLiteralLines, includedTaskLines, includeKey,
  includeSource, type ExpandedFigures,
} from './includeText';
import {
  alertLines, aroundInlineMath, convertedParts, fenceLines, inlineItemLines, inlineMathLines, lazyLineSet, literalLines, parseSmd, renderedTaskLines, withParses,
  type AlertLines, type InlineItemLines, type InlineMathLines, type InlinePart,
} from './parse';
import {
  addOmission, provenanceManifest, type Omission, type Provenance, type Trace,
} from './provenance';
import { dueState, type Heading } from './render';
import { matchesExactly, matchesHeading, sectionsOf, withoutHeadingAttrs, type Section } from './sections';
import { countsTasks, progressState, progressTag, sectionTaskCounts, type TaskCount } from './progress';
import { evidenceRecords, type EvidenceRecord } from './evidence';
import { documentBlocks, type DocumentBlock } from './query';
import { quoteCite } from './quote';
import { hasReviewBlocks, reviewItems, type ReviewItem } from './review';
import { REVIEW_CONTAINERS } from './revision';
import { CALLOUT_TYPES, idList, INLINE_DIRECTIVES, isKnownDirective } from './spec';
import { hasAnswer, isLifecycleQuestion, questionStatus, tagContext, type TagBlock, type TagContext } from './semanticTags';
import { specVersion, type SpecVersion } from './specVersion';
import { openTaskLines } from './taskLines';
import { own } from './util';
import { documentVariables, shownValues, substituteVariables, type Variables } from './variables';

/**
 * Agent view: a compact, meaning-preserving rendering of an .smd document for LLMs.
 *
 * What it removes (never meaning):  styling syntax, colors, layout wrappers, HTML comments,
 *   image URLs, table padding, :::human blocks, sections marked {agent=skip}, front matter noise.
 * What it keeps verbatim:  headings (with source line refs), prose, lists, tables, code,
 *   :::agent instructions, callouts (as tags), decisions, risks, API endpoints, open tasks.
 * What --brief additionally condenses:  diagrams, long code blocks, :::details, completed tasks.
 */
export interface AgentViewOptions {
  /** Only include these sections (heading text or id, case-insensitive; subsections included). */
  sections?: string[];
  /**
   * Match `sections` exactly: a heading's id, or its whole text in any case (as spec v2's `:::include{section}`). By
   * default a part of the text is enough, so "API" also selects "API details".
   */
  exactSections?: boolean;
  /** Condense diagrams, long code, details blocks and completed tasks. */
  brief?: boolean;
  /** Keep :::human blocks (dropped by default). */
  includeHuman?: boolean;
  /**
   * Keep resolved, accepted, rejected and withdrawn comments and suggestions (left out by default, with one line
   * that counts them). Open ones and answers are always shown.
   */
  includeReview?: boolean;
  /** Append [L12] source line references to headings (default true) so agents can edit precisely. */
  lineRefs?: boolean;
  /** Inline `file="…"` code embeds instead of referencing the path (default false). */
  embed?: boolean;
  /**
   * Show `:::include` blocks as the included text in an `<included file="…">` block (default true; needs
   * `readFile`). False: a one-line pointer to the file instead, to save tokens.
   */
  includes?: boolean;
  /** Reads code embeds and includes, relative to the document. */
  readFile?: (relativePath: string) => string | undefined;
  today?: string;
  /**
   * Shrink the view to at most this many tokens: condense it as `brief` does, then omit whole sections
   * in priority order, each replaced by a one-line pointer (see budget.ts). Counted with `tokenizer` when given.
   */
  maxTokens?: number;
  /** An exact tokenizer: adds `counted` to the result, counts `maxTokens`, and adds counts to outlines. */
  tokenizer?: Tokenizer;
  /** The document's path, used in pointers to omitted sections (default `<file>`). */
  file?: string;
  /**
   * With `sections`: also list the document's constraints outside them (see constraints.ts). `:::danger` blocks are
   * shown in full; warnings, accepted decisions and open questions as pointers. Off by default (experimental).
   */
  constraints?: boolean;
  /**
   * Add a machine-readable `provenance` manifest to the result: source hashes, settings, resolved sections, a source
   * map and every omission with its reason (see provenance.ts). It never changes `text`. Off by default.
   */
  provenance?: boolean;
  /** How evidence records of the blocks shown appear: one-line pointers (default) or in full. */
  evidence?: 'full' | 'pointers';
  /** Lines an author task view adds to the selection (see taskViews.ts). Internal; leave it out otherwise. */
  pinned?: PinnedSelection;
}

/**
 * What an author task view adds to a view: line ranges shown with the selected sections (never omitted for a budget),
 * the ranges kept whole when the view is condensed (mandatory content), the header's excerpt line, and text that ends
 * the view (pointers, unsatisfied requirements), counted in the budget.
 */
export interface PinnedSelection {
  /** Zero-based first and last lines, inclusive. */
  ranges: ReadonlyArray<readonly [number, number]>;
  whole: ReadonlyArray<readonly [number, number]>;
  /** The view selects content (sections, a query or mandatory ids); false shows the whole document. */
  selects: boolean;
  label: string;
  appendix: string;
}

export interface AgentViewResult {
  text: string;
  /** Approximate token counts (≈ characters / 4). */
  originalTokens: number;
  tokens: number;
  /** Sections requested but not found. */
  missingSections: string[];
  /** When `sections` is given: the headings each query selected (more than one when it is ambiguous). */
  resolvedSections?: ResolvedSection[];
  /** Headings omitted because they are marked {agent=skip}. */
  skippedSections: string[];
  /** Counts by `tokenizer`, when one is given. */
  counted?: { tokenizer: string; tokens: number; originalTokens: number };
  /** What was done to fit `maxTokens`, when it is given. */
  budget?: BudgetResult;
  /** With `constraints` and `sections`: the constraints outside the sections and how they were shown. */
  constraints?: ConstraintView;
  /** With `provenance`: where each part of `text` came from and what was left out. */
  provenance?: Provenance;
  /**
   * Only for a document with `:::constraint` blocks or dependencies: the constraints from outside the selected
   * sections, the dependencies the view adds, and what it could not satisfy (see applicability.ts).
   */
  mandatory?: MandatoryContext;
}

/** One `sections` query and the headings it selected, each with its id and zero-based line. */
export interface ResolvedSection {
  query: string;
  headings: Array<{ id: string; text: string; line: number }>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** `:::risk-matrix` in the agent view: a pointer, since every risk it shows is already a `<risk>` block. */
function riskMatrixPointer(title: string): string {
  const label = title ? `risk matrix: ${title}` : 'risk matrix';
  return `[${label} — impact × likelihood of this document's risks except closed ones; each is a <risk> block]`;
}

/** What a container's opening line becomes: a line to emit, and a line that closes it. */
interface ContainerHead { line?: string; close?: string }

interface HeadSource {
  /** The title as plain words. */
  title: string;
  values: Record<string, string>;
  id?: string;
  /** The `:::figure` that opens on this line. */
  figure?: Figure;
  /** The id of the requirement this container sits in (a nested acceptance verifies it). */
  requirement?: string;
  /** What the document's other blocks say about this one: its answer, what supersedes it. */
  tags?: { block?: TagBlock; context: TagContext };
}

const titleAttr = (title: string) => (title ? ` title="${title}"` : '');
const titleAfter = (title: string, sep = ' ') => (title ? `${sep}${title}` : '');
const attrList = (values: Record<string, string>, keys: string[]) => keys.filter((k) => values[k]).map((k) => ` ${k}="${values[k]}"`).join('');

/** `<tag title="…">` … `</tag>` */
const tagged = (tag: string) => ({ title }: HeadSource): ContainerHead => ({ line: `<${tag}${titleAttr(title)}>`, close: `</${tag}>` });

/** ` id="…" key="…"`: the id, then the attributes in `keys` that have a value. */
const tagAttrs = (id: string | undefined, values: Record<string, string>, keys: string[]) => `${id ? ` id="${id}"` : ''}${attrList(values, keys)}`;

/** A semantic tag: `<requirement id="R1" status="accepted">` Title … `</requirement>`. `shown` are defaults the view states. */
const semanticTag = (tag: string, keys: string[], shown: Record<string, string> = {}) => ({ title, values, id }: HeadSource): ContainerHead => ({
  line: `<${tag}${tagAttrs(id, { ...shown, ...values }, keys)}>${titleAfter(title)}`, close: `</${tag}>`,
});

/** An acceptance block lists the requirement it sits in first in `verifies`. */
function acceptanceHead(source: HeadSource): ContainerHead {
  const verifies = [...new Set([...(source.requirement ? [source.requirement] : []), ...idList(source.values.verifies ?? '')])].join(',');
  return semanticTag('acceptance', ['verifies', 'test'])({ ...source, values: { ...source.values, ...(verifies ? { verifies } : {}) } });
}

/**
 * A question: as before, unless it uses the lifecycle. Then its id and state come first, and `answered` or
 * `incorporated` show only when an answer exists (research contract, "Questions", GAP-8).
 */
function questionHead(source: HeadSource): ContainerHead {
  const plain = tagged('question')(source);
  const block = source.tags?.block;
  if (!block || block.name !== 'question') return plain;
  const { blocks, answered } = source.tags!.context;
  const answer = hasAnswer(block, blocks, answered);
  if (!isLifecycleQuestion(block, answer)) return plain;
  const values = { ...source.values, status: questionStatus(block, answer) };
  return { line: `<question${tagAttrs(source.id, values, ['status', 'owner', 'due', 'between', 'reason'])}${titleAttr(source.title)}>`, close: '</question>' };
}

/** A decision, with `superseded-by` when a decision of the document supersedes it. */
function decisionHead({ title, values, id, tags }: HeadSource): ContainerHead {
  const by = id ? tags?.context.supersededBy.get(id) : undefined;
  const shown = by ? { ...values, 'superseded-by': by.join(',') } : values;
  // Its id only with a link, so decisions without one read as before.
  const linked = id && (by || shown.supersedes || shown['depends-on']) ? id : undefined;
  return { line: `<decision${tagAttrs(linked, shown, ['status', 'date', 'owner', 'supersedes', 'superseded-by', 'depends-on'])}>${titleAfter(title)}`, close: '</decision>' };
}

function apiHead({ title, values: v }: HeadSource): ContainerHead {
  return { line: `API ${(v.method ?? 'GET').toUpperCase()} ${v.path ?? ''}${titleAfter(title, ' — ')}${v.auth ? ` (auth: ${v.auth})` : ''}` };
}

/** `<figure id="fig-checkout"> Figure 1: Caption` … `</figure>`, numbered as the rendered document numbers it. */
function figureHead({ title, id, figure }: HeadSource): ContainerHead {
  const label = (figure?.label ?? 'Figure') + titleAfter(title, ': ');
  return { line: `<figure${id ? ` id="${id}"` : ''}> ${label}`, close: '</figure>' };
}

/** `<quote author="…" source="…" cite="…">` … `</quote>`: attribution as plain words, and only a cite URL that renders. */
function quoteHead({ values }: HeadSource): ContainerHead {
  const plainValues = { author: inlineText(values.author ?? '').trim(), source: inlineText(values.source ?? '').trim(), cite: quoteCite(values.cite) ?? '' };
  return { line: `<quote${attrList(plainValues, ['author', 'source', 'cite'])}>`, close: '</quote>' };
}

/** `Title:`, or nothing without a title. */
const titleLine = ({ title }: HeadSource): ContainerHead => (title ? { line: `${title}:` } : {});

/** Containers whose head reads what other blocks say about them (see tagContext). */
const TAG_HEADS: ReadonlySet<string> = new Set(['question', 'decision']);

/**
 * The agent view of each container's opening line. `:::human` (unless included) and `:::details` in brief
 * views are dropped before this. tabs, columns, column, box, steps and timeline: content only. Unknown containers:
 * their title as a `Title:` line, as a card's (see containerHead), then the content.
 */
const CONTAINER_HEADS = new Map<string, (c: HeadSource) => ContainerHead>([
  ['agent', tagged('agent-instructions')],
  ...CALLOUT_TYPES.map((c) => [c, tagged(c)] as const),
  ['question', questionHead],
  ['decision', decisionHead],
  ['risk', ({ title, values, id }) => ({ line: `<risk${tagAttrs(values['depends-on'] ? id : undefined, values, ['impact', 'likelihood', 'owner', 'status', 'depends-on'])}>${titleAfter(title)}`, close: '</risk>' })],
  // A status or level is shown when not written: an agent must know a requirement is only proposed (semantic tags R4).
  ['requirement', semanticTag('requirement', ['priority', 'status', 'owner', 'depends-on'], { status: 'proposed' })],
  ['constraint', semanticTag('constraint', ['scope', 'applies-to', 'level', 'owner', 'depends-on'], { level: 'must' })],
  ['acceptance', acceptanceHead],
  ['assumption', semanticTag('assumption', ['status', 'owner', 'review-by', 'depends-on'], { status: 'unvalidated' })],
  ['evidence', semanticTag('evidence', ['supports', 'contradicts', 'method', 'result', 'commit', 'date', 'by', 'source', 'rev'])],
  ['risk-matrix', ({ title }) => ({ line: riskMatrixPointer(title) })],
  ['api', apiHead],
  ['details', tagged('details')],
  ['human', tagged('human')],
  ['tab', ({ title }) => ({ line: `Tab "${title || 'Tab'}":` })],
  ['card', titleLine],
  ['figure', figureHead],
  // Listed once, as written; uses of the terms in the text are not expanded.
  ['glossary', tagged('glossary')],
  // Its entry headings become `## 1.2.0 (2026-03-01)` lines (see entryHeading).
  ['changelog', tagged('changelog')],
  ['quote', quoteHead],
]);

/** The agent view of a container's opening line: its own (CONTAINER_HEADS), a known one's content only, an unknown one's title. */
function containerHead(name: string, source: HeadSource): ContainerHead {
  const head = CONTAINER_HEADS.get(name);
  if (head) return head(source);
  return isKnownContainer(name) ? {} : titleLine(source);
}

/** What the view reads included files with: nothing when includes are only pointers. */
const viewReader = (options: AgentViewOptions) => (options.includes === false ? undefined : options.readFile);

/** Front matter keys the agent view's header leaves out of its facts. */
export const AGENT_HEADER_HIDDEN: ReadonlySet<string> = new Set(['smd', 'theme', 'accent', 'toc', 'title', 'summary']);

interface ViewScope {
  data: Record<string, unknown>;
  /** The front matter as the document shows it: spelled as written in spec v2 (shownValues). */
  shown: Variables;
  /** The lines of front matter that could not be read, as written (see unreadFrontMatter). */
  unread?: string[];
  bodyStart: number;
  lines: string[];
  sections: Section[];
  /** Requested sections, or null for the whole document. */
  selected: Section[] | null;
  skipped: Section[];
  missingSections: string[];
  resolved: ResolvedSection[];
  inScope: (line: number) => boolean;
  pinned?: PinnedSelection;
  /** The constraints and dependencies the view must carry, when the document has any (see applicability.ts). */
  mandatory?: MandatoryPlan;
}

/** Which lines of the document are in the view. */
function viewScope(text: string, options: AgentViewOptions): ViewScope {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const sections = sectionsOf(parseSmd(text).headings, lines.length);
  const skipped = sections.filter((s) => s.heading.agent === 'skip');
  const chosen = selectSections(sections, options.sections, options.exactSections);
  const { missingSections, resolved } = chosen;
  const pinned = options.pinned;
  // A task view with no sections still selects: only its pinned lines.
  const selected = chosen.selected ?? (pinned?.selects ? [] : null);
  const isPinned = (line: number) => !!pinned?.ranges.some(([a, b]) => line >= a && line <= b);
  const inScope = (line: number) => isPinned(line) || (
    (!selected || selected.some((s) => line >= s.start && line <= s.end)) &&
    !skipped.some((s) => line >= s.start && line <= s.end && !(selected?.some((sel) => sel.heading === s.heading))));
  const shown = shownValues(fm.data, text, specVersion(fm.data));
  return {
    data: fm.data, shown, unread: unreadFrontMatter(text, fm), bodyStart: fm.bodyStartLine, lines, sections, selected, skipped, missingSections, resolved, inScope,
    pinned,
  };
}

function selectSections(
  sections: Section[], queries: string[] | undefined, exact = false,
): { selected: Section[] | null; missingSections: string[]; resolved: ResolvedSection[] } {
  const missingSections: string[] = [];
  const resolved: ResolvedSection[] = [];
  if (!queries?.length) return { selected: null, missingSections, resolved };
  const matches = exact ? matchesExactly : matchesHeading;
  const selected: Section[] = [];
  for (const q of queries) {
    const hit = sections.filter((s) => matches(s.heading, q));
    if (hit.length) selected.push(...hit); else missingSections.push(q);
    resolved.push({ query: q, headings: hit.map((s) => ({ id: s.heading.slug, text: s.heading.text, line: s.start })) });
  }
  return { selected, missingSections, resolved };
}

interface ViewHead {
  header: string;
  external: string;
  /** "Constraints that apply here" and "Dependencies of the selected content" (see applyingHead, dependencyHead). */
  applying?: string;
  dependencies?: string;
  /** The `:::danger` blocks and CAUTION alerts outside the selected sections (see outsideDangers). */
  dangers: string;
  /** With `constraints`: the constraints outside the selected sections (see constraintsOutside). */
  constraints: string;
  constraintView?: ConstraintView;
  footnotes: string;
  /** The line that counts the closed review blocks left out, last in the view (see reviewCountLine). */
  review?: string;
  /** A task view's closing text (see PinnedSelection). */
  appendix: string;
}

/** Where a view's head comes from, for provenance: the traces of its document-wide parts. */
interface HeadTraces { external?: Trace; applying?: Trace; dependencies?: Trace; dangers?: Trace; constraints?: Trace; footnotes?: Trace }

/**
 * The header, plus what applies to the whole document outside the selected sections: its :::agent blocks and its
 * dangers. Then the constraints pass when asked for, and the footnotes the sections reference but that are defined
 * elsewhere.
 */
function viewHead(scope: ViewScope, options: TransformOptions, traces: HeadTraces = {}): ViewHead {
  const { selected, lines, bodyStart, inScope } = scope;
  let external = '';
  let dangers = '';
  let footnotes = '';
  let constraints = '';
  let constraintView: ConstraintView | undefined;
  if (selected) {
    const outside = transform(lines, bodyStart, (l) => !inScope(l), { ...options, onlyAgentBlocks: true, trace: traces.external });
    if (outside.trim()) external = `Document-wide agent instructions:\n${outside.trim()}\n\n`;
    footnotes = outsideFootnotes(scope, { ...options, trace: traces.footnotes });
    // The constraints pass shows the dangers itself, with the pointers that go with them.
    if (options.constraints) ({ text: constraints, view: constraintView } = constraintsOutside(scope, { ...options, trace: traces.constraints }));
    else dangers = outsideDangers(scope, { ...options, trace: traces.dangers });
  }
  const excerpt = options.pinned ? options.pinned.label : selected && `(excerpt — sections: ${selected.map((s) => s.heading.text).join(', ')})`;
  const head = [header(scope.data, scope.shown, excerpt), unreadBlock(scope.unread)].filter(Boolean).join('\n');
  const mandatory = scope.mandatory
    ? { applying: applyingHead(scope, options, traces.applying), dependencies: dependencyHead(scope, options, traces.dependencies) } : {};
  return { header: head, external, ...mandatory, dangers, constraints, constraintView, footnotes, appendix: options.pinned?.appendix ?? '' };
}

/** A head pass that shows only the picked lines, of the document and its includes, in full (see applicability.ts). */
function pickedText(scope: ViewScope, options: TransformOptions, picks: MandatoryPlan['applying'], trace?: Trace): string {
  if (!picks.ranges.size) return '';
  const hidden = (line: number) => scope.skipped.some((s) => line >= s.start && line <= s.end);
  return transform(scope.lines, scope.bodyStart, (l) => !scope.inScope(l) && !hidden(l), {
    ...options, brief: false, onlyConstraints: false, constraintSink: undefined, pick: pickTest(picks), trace,
  }).trim();
}

/**
 * The constraints that apply to a section view from outside its sections, in full, after the agent instructions and
 * before the dangers (semantic tags D6). A whole-document view shows them in place.
 */
function applyingHead(scope: ViewScope, options: TransformOptions, trace?: Trace): string {
  const text = pickedText(scope, options, scope.mandatory!.applying, trace);
  return text ? `Constraints that apply here:\n${text}\n\n` : '';
}

/**
 * The dependencies of what the view shows that it does not show, in full, then what could not be satisfied (feedback
 * loop RFC, "Dependencies"). Empty when there is nothing to add or report.
 */
function dependencyHead(scope: ViewScope, options: TransformOptions, trace?: Trace): string {
  const plan = scope.mandatory!;
  const parts = [pickedText(scope, options, plan.dependencies, trace)];
  for (const extra of plan.extra) parts.push(`<included file="${extra.file}">\n${extra.text.trim()}\n</included>`);
  if (plan.unsatisfied.length) {
    const n = plan.unsatisfied.length;
    parts.push(['Not satisfied:', ...plan.unsatisfied, `[incomplete: ${n} mandatory dependenc${n === 1 ? 'y is' : 'ies are'} not satisfied]`].join('\n'));
  }
  const text = parts.filter(Boolean).join('\n');
  return text ? `Dependencies of the selected content:\n${text}\n\n` : '';
}

/**
 * The dangers outside the selected sections, in full: `:::danger` blocks and CAUTION alerts, from the document and the
 * files it includes. A danger is a hard constraint, so like a :::agent block it applies whichever sections are read
 * (C04, decided 2026-11-06). Left out, as everywhere: sections marked {agent=skip}, `:::human` blocks, and dangers
 * inside :::agent blocks, which are shown with them.
 */
function outsideDangers(scope: ViewScope, options: TransformOptions): string {
  const inSkipped = (line: number) => scope.skipped.some((s) => line >= s.start && line <= s.end);
  const text = transform(scope.lines, scope.bodyStart, (l) => !scope.inScope(l) && !inSkipped(l), { ...options, onlyDangers: true }).trim();
  return text ? `Dangers elsewhere in the document:\n${text}\n\n` : '';
}

/**
 * The constraints outside the selected sections (policy `constraints/1`, or `constraints/2` with constraint blocks, see
 * constraints.ts): `:::danger` blocks in full, then pointers to warnings, accepted decisions, open questions, constraints
 * that apply nowhere in the view, and to includes that were not checked.
 * Sections marked {agent=skip}, `:::human` blocks and what `:::agent` blocks already show are left out.
 */
function constraintsOutside(scope: ViewScope, options: TransformOptions): { text: string; view: ConstraintView } {
  const inSkipped = (line: number) => scope.skipped.some((s) => line >= s.start && line <= s.end);
  const found: ConstraintPointer[] = [];
  // Without brief: a danger block is shown whole, even inside a :::details.
  const dangers = transform(scope.lines, scope.bodyStart, (l) => !scope.inScope(l) && !inSkipped(l), {
    ...options, brief: false, onlyConstraints: true, constraintSink: found,
  }).trim();
  const sectionAt = (line: number) => scope.sections.filter((s) => line >= s.start && line <= s.end).at(-1)?.heading.text ?? null;
  // A constraint that applies is shown in full above; one that applies nowhere in the view is a pointer (constraints/2).
  const applying = scope.mandatory?.applyingLines;
  const pointers = found.filter((p) => p.type !== 'constraint' || !applying?.has(p.line)).map((p) => ({ ...p, section: sectionAt(p.line) }));
  const view: ConstraintView = {
    policy: scope.mandatory?.hasConstraints ? 'constraints/2' : 'constraints/1',
    complete: !pointers.some((p) => p.type === 'include'),
    shown: pointers.filter((p) => p.type === 'danger').length,
    pointers,
  };
  const text = constraintBlock(dangers, view, options.lineRefs ?? true);
  return { text: text ? `${text}\n\n` : '', view };
}

/**
 * Footnotes are kept as written: `[^1]` references in the text and `[^1]: …` definitions where they
 * are. An excerpt lists the definitions its references need once after it, unless a skipped section
 * holds them.
 */
function outsideFootnotes(scope: ViewScope, options: TransformOptions): string {
  const { definitions, references } = findFootnotes(scope.lines.join('\n'));
  const wanted = new Set(references.filter((r) => scope.inScope(r.line)).map((r) => r.label));
  const first = new Map<string, FootnoteDefinition>();
  for (const d of definitions) if (wanted.has(d.label) && !first.has(d.label)) first.set(d.label, d);
  const inSkipped = (line: number) => scope.skipped.some((s) => line >= s.start && line <= s.end);
  const ranges = [...first.values()].filter((d) => !scope.inScope(d.line) && !inSkipped(d.line)).map((d) => [d.line, d.endLine]);
  if (!ranges.length) return '';
  const view = transform(scope.lines, scope.bodyStart, (l) => ranges.some(([a, b]) => l >= a && l <= b), options);
  return view.trim() ? `Footnotes referenced above:\n${view.trim()}` : '';
}

function assemble(head: ViewHead, body: string): string {
  return [head.header, head.external + (head.applying ?? '') + (head.dependencies ?? '') + head.dangers + head.constraints + body, head.footnotes, head.appendix, head.review ?? '']
    .filter((s) => s.trim())
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

export function agentView(text: string, viewOptions: AgentViewOptions = {}): AgentViewResult {
  return oneView(viewOptions, (viewOptions) => {
    // Figures are numbered once, for every pass over the document.
    const options: TransformOptions = { ...viewOptions, figures: expandedFigures(text, viewReader(viewOptions)) };
    const scope = viewScope(text, options);
    scope.mandatory = mandatoryOf(text, scope, options);
    const result = options.maxTokens !== undefined ? budgetedView(text, scope, options) : wholeView(text, scope, options);
    if (options.provenance) result.provenance = provenanceOf(text, scope, options, result);
    return result;
  });
}

/** The constraints and dependencies a view must carry (see applicability.ts); undefined for a document with none. */
function mandatoryOf(text: string, scope: ViewScope, options: AgentViewOptions): MandatoryPlan | undefined {
  return mandatoryPlan({
    text, lines: scope.lines, bodyStart: scope.bodyStart, sections: scope.sections, selected: scope.selected, skipped: scope.skipped,
    inScope: scope.inScope, includeHuman: !!options.includeHuman, includes: options.includes !== false, readFile: options.readFile,
    file: options.file ?? '<file>',
  });
}

/**
 * Make one view (or one outline) with each file read once and each text parsed once (see withParses). Numbering
 * figures and showing the text both load every `:::include`, and an outline makes several views. Nothing is kept
 * after `make` returns.
 */
function oneView<O extends AgentViewOptions, T>(options: O, make: (options: O) => T): T {
  const { readFile } = options;
  if (!readFile) return withParses(() => make(options));
  const read = new Map<string, string | undefined>();
  const readOnce = (relativePath: string) => {
    if (!read.has(relativePath)) read.set(relativePath, readFile(relativePath));
    return read.get(relativePath);
  };
  return withParses(() => make({ ...options, readFile: readOnce }));
}

function wholeView(text: string, scope: ViewScope, options: TransformOptions): AgentViewResult {
  const closed = { count: 0 };
  const body = transform(scope.lines, scope.bodyStart, scope.inScope, { ...options, closedReview: closed });
  const head = viewHead(scope, options);
  head.review = reviewCountLine(closed.count, options.file);
  return viewResult(text, scope, assemble(head, body), options, undefined, head.constraintView);
}

/**
 * The provenance manifest of a view already made: the view is made again with traces (so `text` never depends on
 * whether provenance was asked for), its lines are matched to the traced source lines, and the omissions are added.
 */
function provenanceOf(text: string, scope: ViewScope, options: TransformOptions, result: AgentViewResult): Provenance {
  const file = options.file ?? '<file>';
  const dependencies = new Map<string, string | undefined>();
  const readFile = options.readFile && ((p: string) => {
    const content = options.readFile!(p);
    if (!dependencies.has(p)) dependencies.set(p, content);
    return content;
  });
  const traced = { ...options, readFile, brief: options.brief || result.budget?.condensed };
  const omissions: Omission[] = [];
  const traces: HeadTraces = {
    external: { file, entries: [] }, applying: { file, entries: [] }, dependencies: { file, entries: [] }, dangers: { file, entries: [] },
    constraints: { file, entries: [] }, footnotes: { file, entries: [] },
  };
  const body: Trace = { file, entries: [], omissions };
  const closed = { count: 0 };
  transform(scope.lines, scope.bodyStart, scope.inScope, { ...traced, trace: body, closedReview: closed });
  const head = viewHead(scope, traced, traces);
  head.review = reviewCountLine(closed.count, options.file);
  // Lines of sections the budget omitted are not in the text: leave them out before matching.
  const cut = result.budget?.omitted ?? [];
  const bodyEntries = body.entries.filter((e) => !cut.some((o) => e.root >= o.line && e.root <= o.endLine));
  for (const u of scope.mandatory?.context.unsatisfied ?? []) {
    omissions.push({ kind: 'dependency', file: u.file, lines: [u.line, u.line], reason: `a mandatory dependency is not satisfied: ${u.reason}` });
  }
  return provenanceManifest({
    text, file, result, omissions, dependencies,
    entries: [...traces.external!.entries, ...traces.applying!.entries, ...traces.dependencies!.entries, ...traces.dangers!.entries, ...traces.constraints!.entries, ...bodyEntries, ...traces.footnotes!.entries],
    headerLines: head.header ? head.header.split('\n').length : 0,
    frontMatterLines: scope.bodyStart,
    sections: scope.sections, selected: selectedWithPinned(scope), skipped: scope.skipped, resolved: scope.selected ? scope.resolved : null,
    missing: scope.missingSections,
    settings: {
      specVersion: specVersion(scope.data),
      sections: options.sections?.length ? options.sections : null, exactSections: !!options.exactSections, brief: !!options.brief,
      includeHuman: !!options.includeHuman, includes: options.includes !== false, embed: !!options.embed, lineRefs: options.lineRefs ?? true,
      today: options.today ?? null, tokenizer: options.tokenizer?.name ?? 'estimate', maxTokens: options.maxTokens ?? null,
      constraints: !!options.constraints,
    },
  });
}

/** The selected sections, and a task view's pinned lines as sections of their own, so a section they show part of is not "not selected". */
function selectedWithPinned(scope: ViewScope): Section[] | null {
  if (!scope.pinned || !scope.selected) return scope.selected;
  const holder = (line: number) => scope.sections.filter((s) => line >= s.start && line <= s.end).at(-1);
  const pinned = scope.pinned.ranges.flatMap(([start, end]) => {
    const s = holder(start);
    return s ? [{ ...s, start, end }] : [];
  });
  return [...scope.selected, ...pinned];
}

function viewResult(
  text: string, scope: ViewScope, out: string, options: AgentViewOptions, budget?: BudgetResult, constraints?: ConstraintView,
): AgentViewResult {
  const result: AgentViewResult = {
    text: out,
    originalTokens: estimateTokens(text),
    tokens: estimateTokens(out),
    missingSections: scope.missingSections,
    skippedSections: scope.skipped.map((s) => s.heading.text),
  };
  if (scope.selected) result.resolvedSections = scope.resolved;
  const tokenizer = options.tokenizer;
  if (tokenizer) result.counted = { tokenizer: tokenizer.name, tokens: tokenizer.count(out), originalTokens: tokenizer.count(text) };
  if (budget) result.budget = budget;
  if (constraints) result.constraints = constraints;
  if (scope.mandatory) result.mandatory = scope.mandatory.context;
  return result;
}

// ---------------------------------------------------------------------------
// Token budget (maxTokens): condense, then omit sections in priority order.
// ---------------------------------------------------------------------------

/**
 * A view before assembly: its head and every emitted body line with the source line it came from. Fitting a budget
 * tries one set of omitted sections after another, so what does not depend on the set is worked out once here.
 */
interface Draft {
  head: ViewHead;
  lines: Array<[at: number, line: string]>;
  /** What each line is, for ViewLength (see pieceKind). */
  kinds: Uint8Array;
  /** The indexes of `lines` by source line, then by index, to find a section's lines (see draftSection). */
  byLine: number[];
  /** How many lines the document has. */
  sourceLines: number;
  file?: string;
  count: (text: string) => number;
  /** `count` is estimateTokens, so a view's count follows from its length (see draftCount). */
  estimated: boolean;
  /** Source lines that emitted `:::agent` text, an include's line for its file's blocks (see onAgentLine). */
  agentLines: Set<number>;
  /** Each section's tokens and pointer, worked out once. */
  costs: Map<BudgetSection, number>;
  pointers: Map<BudgetSection, Pointer>;
  /** Where the document's constraints sit, so a pointer says `holds constraint` (see applicability.ts). */
  constraintAt: readonly number[];
}

/** A section's pointer, and the cues its view text holds (see keyCues). */
interface Pointer { text: string; kind: number; cues: string[] }

function draftOf(scope: ViewScope, options: AgentViewOptions): Draft {
  const lines: Array<[number, string]> = [];
  const agentLines = new Set<number>();
  const closed = { count: 0 };
  transform(scope.lines, scope.bodyStart, scope.inScope, { ...options, collect: lines, onAgentLine: (l) => agentLines.add(l), closedReview: closed });
  const byLine = lines.map((_, k) => k).sort((a, b) => lines[a][0] - lines[b][0] || a - b);
  return {
    head: { ...viewHead(scope, options), review: reviewCountLine(closed.count, options.file) }, lines, kinds: Uint8Array.from(lines, ([, line]) => pieceKind(line)), byLine, sourceLines: scope.lines.length,
    file: options.file, count: options.tokenizer?.count ?? estimateTokens, estimated: !options.tokenizer, agentLines, costs: new Map(), pointers: new Map(),
    constraintAt: scope.mandatory?.constraintAt ?? [],
  };
}

const joinLines = (lines: string[]) => lines.join('\n').replace(/\n{3,}/g, '\n\n');

/** The view text of the lines emitted for one section, in the order they were emitted. */
function draftSection(draft: Draft, s: BudgetSection): string {
  const { lines, byLine } = draft;
  const first = (line: number) => {
    let lo = 0;
    let hi = byLine.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[byLine[mid]][0] < line) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const inSection = byLine.slice(first(s.start), first(s.end + 1)).sort((a, b) => a - b);
  return joinLines(inSection.map((k) => lines[k][1]));
}

/** What a section costs in the view. */
function sectionTokens(draft: Draft, s: BudgetSection): number {
  let tokens = draft.costs.get(s);
  if (tokens === undefined) draft.costs.set(s, (tokens = draft.count(draftSection(draft, s))));
  return tokens;
}

function pointerOf(draft: Draft, s: BudgetSection): Pointer {
  let pointer = draft.pointers.get(s);
  if (!pointer) {
    const cues = keyCues(draftSection(draft, s));
    if (draft.constraintAt.some((l) => l >= s.start && l <= s.end)) cues.splice(cues[0] === 'danger' ? 1 : 0, 0, 'constraint');
    const text = omissionPointer(s, sectionTokens(draft, s), draft.file, cues);
    draft.pointers.set(s, (pointer = { text, kind: pieceKind(text), cues }));
  }
  return pointer;
}

/**
 * The body of the view with the omitted sections (in document order) replaced by pointers, piece by piece: each line
 * or pointer, and the blank line that goes with a pointer, with its kind (see pieceKind).
 */
function draftBody(draft: Draft, omitted: BudgetSection[], piece: (text: string, kind: number) => void): void {
  const cut = new Uint8Array(draft.sourceLines);
  for (const s of omitted) cut.fill(1, s.start, s.end + 1);
  let next = 0;
  draft.lines.forEach(([at, line], k) => {
    while (next < omitted.length && at > omitted[next].end) {
      const pointer = pointerOf(draft, omitted[next++]);
      piece(pointer.text, pointer.kind);
      piece('', 0);
    }
    if (!cut[at]) piece(line, draft.kinds[k]);
  });
  for (const s of omitted.slice(next)) {
    const pointer = pointerOf(draft, s);
    piece('', 0);
    piece(pointer.text, pointer.kind);
  }
}

/** The assembled view with the omitted sections replaced by pointers. */
function draftText(draft: Draft, omitted: BudgetSection[]): string {
  const body: string[] = [];
  draftBody(draft, omitted, (text) => body.push(text));
  return assemble(draft.head, joinLines(body));
}

/**
 * The tokens of `draftText(draft, omitted)`. With the estimate they follow from its length, which ViewLength works
 * out without building the text; a tokenizer counts the text.
 */
function draftCount(draft: Draft, omitted: BudgetSection[]): number {
  if (draft.estimated) {
    const length = new ViewLength();
    draftBody(draft, omitted, (text, kind) => length.add(text, kind));
    const total = length.of(draft.head);
    if (total !== undefined) return Math.ceil(total / 4); // estimateTokens
  }
  return draft.count(draftText(draft, omitted));
}

/** Kinds of body piece, as bits: not empty, with a character that isn't whitespace, with a line break. */
const NOT_EMPTY = 1;
const PRINTED = 2;
const BREAK = 4;

function pieceKind(text: string): number {
  return (text ? NOT_EMPTY : 0) | (/\S/.test(text) ? PRINTED : 0) | (text.includes('\n') ? BREAK : 0);
}

/**
 * The length of `assemble(head, joinLines(pieces))`, from the pieces one at a time. Joined with line breaks, a run of
 * n empty pieces between two others makes n + 1 breaks, which joinLines cuts to at most 2. assemble only changes the
 * body where it meets the head and the footnotes, so the body's whitespace at both ends is all it needs: the rest of
 * the body (from its first character that isn't whitespace to its last) goes through unchanged.
 */
class ViewLength {
  /** Pieces so far, and whether one was not empty. */
  private pieces = 0;
  private seen = false;
  /** Empty pieces before the first piece that isn't, and after the last. */
  private lead = 0;
  private trail = 0;
  /** The joined length from the first piece that isn't empty to the last. */
  private inner = 0;
  /** The pieces up to the first with a character that isn't whitespace, and from the last such piece on. */
  private start: string[] = [];
  private end: string[] = [];
  private printed = false;
  /** A piece holds a line break, which this does not count: the caller builds the text instead. */
  private broken = false;

  add(text: string, kind: number): void {
    this.pieces++;
    if (kind & BREAK) this.broken = true;
    if (!(kind & NOT_EMPTY)) {
      if (this.seen) this.trail++; else this.lead++;
    } else {
      this.inner += this.seen ? Math.min(this.trail + 1, 2) + text.length : text.length;
      this.seen = true;
      this.trail = 0;
    }
    if (!this.printed) this.start.push(text);
    if (kind & PRINTED) {
      this.printed = true;
      this.end = [text];
    } else if (this.printed) {
      this.end.push(text);
    }
  }

  /** The assembled view's length, or undefined when the body has a line break in a piece or nothing but whitespace. */
  of(head: ViewHead): number | undefined {
    if (this.broken || !this.printed) return undefined;
    const body = Math.min(this.lead, 2) + this.inner + Math.min(this.trail, 2);
    const before = /^\s*/.exec(joinLines(this.start))![0];
    const after = /\s*$/.exec(joinLines(this.end))![0];
    // A one-character stand-in for the middle of the body, which assemble leaves as it is.
    return assemble(head, `${before}x${after}`).length - 1 + (body - before.length - after.length);
  }
}

function budgetedView(text: string, scope: ViewScope, options: AgentViewOptions): AgentViewResult {
  const maxTokens = options.maxTokens ?? Infinity;
  let draft = draftOf(scope, options);
  const condensed = !options.brief && draftCount(draft, []) > maxTokens;
  if (condensed) draft = draftOf(scope, { ...options, brief: true });
  const omitted = omitToFit(draft, scope, maxTokens);
  const { text: out, tokens } = withOverflowLine(draftText(draft, omitted), maxTokens, draft.count, options.tokenizer?.name);
  const omittedSections = omitted.map((s) => ({
    heading: s.heading.text, level: s.heading.level, line: s.start, endLine: s.end, tokens: sectionTokens(draft, s),
  }));
  return viewResult(text, scope, out, options, { maxTokens, tokens, fits: tokens <= maxTokens, condensed, omitted: omittedSections }, draft.head.constraintView);
}

/**
 * A view over its budget ends with one line that says so, `[budget: ≈437 of 300 tokens, required content does not
 * fit]`, so an agent that never sees stderr or the manifest still knows (research contract, "Overflow is reported in
 * the view"). The count includes the line itself. A view that fits is returned as it is.
 */
function withOverflowLine(view: string, maxTokens: number, count: (text: string) => number, tokenizer?: string): { text: string; tokens: number } {
  let tokens = count(view);
  if (tokens <= maxTokens) return { text: view, tokens };
  const unit = tokenizer ? `${tokenizer} tokens` : 'tokens';
  const withLine = (n: number) => `${view}\n[budget: ${tokenizer ? '' : '≈'}${n} of ${maxTokens} ${unit}, required content does not fit]\n`;
  // The line's own tokens change the count; a few passes settle it (the number's digits are all that can change).
  for (let pass = 0; pass < 4; pass++) {
    const counted = count(withLine(tokens));
    if (counted === tokens) break;
    tokens = counted;
  }
  const text = withLine(tokens);
  return { text, tokens: count(text) };
}

/**
 * The cues a section's view text holds that its pointer names, so a hidden danger or question is never silent. A
 * question the lifecycle settled (answered, incorporated, withdrawn) is ordinary content.
 */
function keyCues(view: string): string[] {
  const cues: string[] = [];
  for (const cue of ['danger', 'warning']) if (new RegExp(`^<${cue}[ >]`, 'm').test(view)) cues.push(cue);
  if (/^<question[ >]/m.test(view)) {
    const open = !SETTLED_QUESTION_HEAD.test(view) || view.split('\n').some((l) => /^<question[ >]/.test(l) && !SETTLED_QUESTION_HEAD.test(l));
    if (open) cues.push('question');
  }
  return cues;
}

const SETTLED_QUESTION_HEAD = /^<question(?: id="[^"]*")? status="(?:answered|incorporated|withdrawn)"/m;

/** The lines of the questions the lifecycle settled: ordinary content under a budget, not key content. */
function settledQuestions(text: string): Set<number> {
  const tags = tagContext(text);
  const out = new Set<number>();
  for (const b of tags?.blocks ?? []) {
    if (b.name !== 'question') continue;
    const answer = hasAnswer(b, tags!.blocks, tags!.answered);
    if (isLifecycleQuestion(b, answer) && questionStatus(b, answer) !== 'open') out.add(b.line);
  }
  return out;
}

/** Omit sections, least important first, until the view fits or nothing more may be omitted. */
function omitToFit(draft: Draft, scope: ViewScope, maxTokens: number): BudgetSection[] {
  const cost = (s: BudgetSection) => sectionTokens(draft, s);
  // Omitting a section only helps when its content costs more than its pointer.
  // A section that shows `:::agent` text from an included file is kept, as one with its own `:::agent` block is.
  // A section that shows a danger (its own, a CAUTION alert or one from an include) is mandatory content too
  // (research contract, "Mandatory content is never a budget candidate").
  const holdsAgentText = (s: BudgetSection) => [...draft.agentLines].some((l) => l >= s.start && l <= s.end);
  // A task view's pinned lines are selected content, as requested sections are.
  const holdsPinned = (s: BudgetSection) => !!scope.pinned?.ranges.some(([a, b]) => a <= s.end && s.start <= b);
  const candidates = omittableSections(scope.sections, scope.lines, scope.selected).filter((s) => {
    if (holdsAgentText(s) || holdsPinned(s)) return false;
    const pointer = pointerOf(draft, s);
    return !pointer.cues.includes('danger') && cost(s) > draft.count(pointer.text);
  });
  let omitted: BudgetSection[] = [];
  const order = omissionOrder(candidates, scope.lines, cost, settledQuestions(scope.lines.join('\n')));
  const ties = scope.mandatory?.ties ?? [];
  if (!ties.length) {
    for (const s of order) {
      if (draftCount(draft, omitted) <= maxTokens) break;
      omitted = withOmitted(omitted, s);
    }
    return omitted;
  }
  // What applies or is depended on keeps its section while what needs it is kept (semantic tags R29, AF15). A section
  // refused once may go later, after what needs it went.
  for (let more = true; more;) {
    more = false;
    for (const s of order) {
      if (draftCount(draft, omitted) <= maxTokens) return omitted;
      if (omitted.some((o) => s.start >= o.start && s.end <= o.end)) continue;
      const next = withOmitted(omitted, s);
      if (!keepsTies(ties, next)) continue;
      omitted = next;
      more = true;
    }
  }
  return omitted;
}

/**
 * Front matter that could not be read: a `[front matter could not be read]` line and its lines as written, in a
 * fence longer than any backtick run in them, as the rendered document shows them in an error block.
 */
function unreadBlock(unread: string[] | undefined): string {
  if (!unread) return '';
  const longest = Math.max(2, ...unread.map((l) => Math.max(0, ...[...l.matchAll(/`+/g)].map((m) => m[0].length))));
  const fence = '`'.repeat(longest + 1);
  return ['[front matter could not be read]', `${fence}yaml`, ...unread, fence].join('\n');
}

/** The view's header. `data` decides which facts are shown, `shown` how they are spelled (as written in spec v2). */
function header(data: Record<string, unknown>, shown: Variables, excerpt: string | null): string {
  const out: string[] = [];
  if (typeof data.title === 'string') out.push(`# ${data.title}`);
  const facts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_HEADER_HIDDEN.has(key) || value === null || value === undefined || value === '') continue;
    // Task views: their names, not their policy as JSON.
    const v = key === 'views' && isMapping(value) ? Object.keys(value).join(', ') : factText(Object.hasOwn(shown, key) ? shown[key] : value);
    if (v) facts.push(`${key}: ${v}`);
  }
  if (facts.length) out.push(facts.join(' · '));
  if (typeof data.summary === 'string') out.push(`summary: ${data.summary}`);
  if (excerpt) out.push(excerpt);
  return out.join('\n');
}

const isMapping = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A front matter value as one header fact: a list joined with ", ", a mapping as JSON. */
function factText(value: unknown): string {
  if (Array.isArray(value)) return asStringList(value).join(', ');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

interface TransformOptions extends AgentViewOptions {
  onlyAgentBlocks?: boolean;
  /** Only the lines inside `:::danger` blocks and CAUTION alerts, not inside `:::agent` (see outsideDangers). */
  onlyDangers?: boolean;
  /** Only what every view keeps: `:::agent` and danger lines (an include hidden by condensing or a head pass). */
  onlyMandatory?: boolean;
  /** The figures of the document and of what it includes, numbered together; found from `lines` when left out. */
  figures?: ExpandedFigures;
  /** Which document of `figures` the lines are: an included one's key (see includeKey), `''` for the root document. */
  figureKey?: string;
  /** The document's changelog entry headings by line, when `lines` are not the whole document. */
  changelogs?: ReadonlyMap<number, ChangelogEntry>;
  /** The document's front matter, for `{{name}}`; read from `lines` when left out. */
  variables?: Variables;
  /** The lines of `lines` that are code or display math, kept as written; found in `lines` when left out. */
  literalLines?: ReadonlySet<number>;
  /** The inline math of the lines of `lines` whose inline text runs over several lines (see inlineMathLines); found in `lines` when left out. */
  inlineMath?: InlineMathLines;
  /** The GitHub alerts of `lines` (see alertLines); found in `lines` when left out. */
  alerts?: readonly AlertLines[];
  /** The inline items of `lines` that run over several lines (see inlineItemLines); found in `lines` when left out. */
  inlineItems?: InlineItemLines;
  /** The lines of `lines` where rendering shows a task's checkbox (see renderedTaskLines); found in `lines` when left out. */
  taskLines?: ReadonlySet<number>;
  /** Receives every emitted line with the source line it came from. */
  collect?: Array<[at: number, line: string]>;
  /** Inside an included document: where its own includes resolve. */
  includeScope?: IncludeScope;
  /** Only the lines inside `:::danger` blocks (and not inside `:::agent`), for the constraints pass. */
  onlyConstraints?: boolean;
  /** Receives the constraints the lines in scope hold (see constraintsOutside). */
  constraintSink?: ConstraintPointer[];
  /** Receives every emitted line with the file and line it came from, and what was left out (see provenance.ts). */
  trace?: Trace;
  /** Called with the line of every emitted line of an `:::agent` block; inside an include, with the include's line. */
  onAgentLine?: (line: number) => void;
  /** The review blocks of the whole document by opening line; found from `lines` when left out. */
  review?: ReadonlyMap<number, ReviewItem>;
  /** Counts the closed review blocks in scope that are left out. */
  closedReview?: { count: number };
  /** Which document `lines` are: an included file's path, the root's when left out (see applicability.ts). */
  docPath?: string;
  /** Only the picked lines of each document, with `[L12]` on the picked opening lines (see pickedText). */
  pick?: { lines: (doc: string, line: number) => boolean; refs: (doc: string, line: number) => boolean };
}

/** The review blocks of a document by opening line, found once per array of lines. */
const reviewCache = new WeakMap<string[], ReadonlyMap<number, ReviewItem>>();
const NO_REVIEW: ReadonlyMap<number, ReviewItem> = new Map();

function reviewOf(lines: string[]): ReadonlyMap<number, ReviewItem> {
  let found = reviewCache.get(lines);
  if (!found) {
    const text = lines.join('\n');
    found = hasReviewBlocks(text) ? new Map(reviewItems(text).map((r) => [r.line, r])) : NO_REVIEW;
    reviewCache.set(lines, found);
  }
  return found;
}

/**
 * A review block's opening line in the view (feedback loop RFC): `<comment for="R1" author="@maya" kind="remark">`
 * or `<suggestion for="R1" author="@agent">` with its title, and `stale="true"` with the target's current revision
 * when its target changed. Null for a closed one (resolved, accepted, rejected, withdrawn), which the view leaves out
 * unless `includeReview`; an answer is shown whatever its status.
 */
function reviewHead(name: string, item: ReviewItem | undefined, values: Record<string, string>, title: string, includeClosed: boolean): ContainerHead | null {
  const open = item?.open ?? true;
  if (!open && !item?.answer && !includeClosed) return null;
  const shown: Record<string, string> = {
    for: values.for ?? '', author: values.author ?? '', kind: name === 'comment' ? (item?.kind ?? values.kind ?? 'remark') : '',
    status: open ? '' : item?.status ?? '', by: open ? '' : values.by ?? '', on: open ? '' : values.on ?? '',
    stale: open && item?.stale ? 'true' : '', 'current-rev': open && item?.stale ? item.currentRev ?? '' : '',
  };
  return { line: `<${name}${attrList(shown, Object.keys(shown))}>${titleAfter(title)}`, close: `</${name}>` };
}

/** One line for the closed review blocks a view leaves out, pointing at the query that lists them; empty for none. */
function reviewCountLine(count: number, file = '<file>'): string {
  if (!count) return '';
  const items = count === 1 ? '1 closed review item' : `${count} closed review items`;
  return `[${items} (resolved, accepted, rejected or withdrawn) left out: smd query "comment[status=resolved], suggestion[status!=open]" ${file} lists them]`;
}

/**
 * A closing fence closes the open containers from index `at` on (see closedBy), innermost first: `close` sees each
 * while it is still open, then it is taken off.
 */
function popFrames<T>(stack: T[], at: number, close: (frame: T) => unknown): void {
  while (stack.length > Math.max(at, 0)) {
    close(stack.at(-1)!);
    stack.pop();
  }
}

function transform(lines: string[], from: number, inScope: (line: number) => boolean, options: TransformOptions): string {
  const out: string[] = [];
  const lineRefs = options.lineRefs ?? true;
  const { figures, ownFigures, literal, inlineMath, alerts, inlineItems, taskLines } = documentContext(lines, options);
  const variables = options.variables ?? documentVariables(lines);
  // The document's spec version, from its front matter: an included document's is the including one's, as in rendering.
  const spec = specVersion(variables);
  // Condensed as brief, except a task view's mandatory lines, which are kept whole (AF15).
  const briefAt = (at: number) => !!options.brief && !options.pinned?.whole.some(([a, b]) => at >= a && at <= b);
  // The line being read, and the tasks of each line's section (for `:progress{basis=tasks}`), counted on the first ask.
  let current = from;
  let sectionCounts: ((line: number) => TaskCount) | undefined;
  const counts = () => (sectionCounts ??= sectionTaskCounts(lines.join('\n'), from, spec))(current);
  const text = (s: string, openTask = false, math?: ReadonlyArray<[number, number]>, parts?: ReadonlyArray<InlinePart>) => {
    const read: TextContext = { today: options.today, openTask, figures: figures.byId, blocks: figures.blocks, variables, spec, counts };
    // An item that runs over several lines is read whole, as rendering reads it; each line shows its part.
    return styledText(s, read, math, convertedParts(parts, (whole) => styledText(whole, read)));
  };
  const changelogs = options.changelogs ?? changelogEntries(lines, 0, spec);
  // `condensed`: a :::details in a brief view. Its content is left out, except :::agent blocks inside it, which every view keeps.
  // `visible`: its opening line was in the view (for provenance).
  interface Frame {
    name: string; colons: number; close?: string; drop: boolean; condensed?: 'details' | 'deprecated'; start: number; visible?: boolean; id?: string;
  }
  const stack: Frame[] = [];
  // What the document's blocks say about each other (answers, supersedes), read on the first question or decision.
  let tags: TagContext | undefined | null = null;
  const tagsHere = () => (tags === null ? (tags = tagContext(lines.join('\n'))) : tags);
  const inAgent = () => stack.some((f) => f.name === 'agent');
  // Inside a danger block or a GitHub alert shown as one (the constraints pass).
  const inDanger = () => stack.some((f) => f.name === 'danger') || alertView.callout() === 'danger';
  // A danger is a hard constraint: like :::agent, it is kept whole inside a condensed :::details.
  const condensedHere = () => {
    if (alertView.callout() === 'danger') return false;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].name === 'agent' || stack[k].name === 'danger') return false;
      if (stack[k].condensed) return true;
    }
    return false;
  };
  const dropping = () => stack.some((f) => f.drop) || condensedHere();
  /** Whether a line at `at` would be in the output now. */
  const visibleAt = (at: number) => inScope(at) && !dropping()
    && (!options.onlyAgentBlocks || inAgent())
    && (!options.onlyDangers || (inDanger() && !inAgent()))
    && (!options.onlyMandatory || inAgent() || inDanger())
    && (!options.onlyConstraints || (inDanger() && !inAgent()))
    && (!options.pick || options.pick.lines(options.docPath ?? ROOT_DOC, at));
  const trace = options.trace;
  const referenced = new Set<number>();
  // `end`: the last source line the emitted line stands for, when it is more than `at` (a fence's lines).
  const emit = (shownLine: string, at: number, traced = true, end = at) => {
    if (!visibleAt(at)) return;
    let line = shownLine;
    // A picked block's opening line says where it is, as a heading does.
    if (options.pick && lineRefs && !referenced.has(at) && options.pick.refs(options.docPath ?? ROOT_DOC, at)) {
      referenced.add(at);
      if (!/\[L\d+\]$/.test(line)) line = `${line} [L${at + 1}]`;
    }
    out.push(line);
    options.collect?.push([at, line]);
    if (inAgent()) options.onAgentLine?.(at);
    if (traced) trace?.entries.push({ file: trace.file, line: at, end, root: trace.root ?? at, text: line });
  };
  /** Record lines [start, end] (zero-based) as left out of the view, when provenance is asked for. */
  const omit = (o: Omit<Omission, 'file' | 'lines'>, start: number, end: number) => {
    if (trace?.omissions) addOmission(trace.omissions, { ...o, file: trace.file, lines: [start + 1, end + 1] });
  };
  const evidenceAfter = options.evidence === 'full' ? evidenceFollower(lines, options) : undefined;
  const closeFrame = (frame: Frame, at: number) => {
    if (frame.close) emit(frame.close, at);
    if (evidenceAfter && frame.visible) for (const l of evidenceAfter(frame.name, frame.start, at)) emit(l, at, false);
    if (!frame.visible) return;
    if (frame.drop && frame.name === 'human') omit({ kind: 'human', reason: 'a :::human block is for people (include-human shows it)' }, frame.start, at);
    if (frame.condensed === 'details') omit({ kind: 'details', reason: 'a :::details block is condensed in brief views' }, frame.start, at);
    if (frame.condensed === 'deprecated') omit({ kind: 'deprecated', reason: 'a deprecated requirement is condensed in brief views' }, frame.start, at);
  };

  let fence: { marker: string; start: number; body: string[]; info: string } | null = null;
  let inComment = false;
  let commentStart = 0;
  let doneTasks = 0;
  let doneFrom = 0;
  let doneTo = 0;
  const flushDone = (at: number) => {
    if (doneTasks) {
      if (visibleAt(at)) omit({ kind: 'completed-tasks', reason: 'completed tasks are counted, not listed, in brief views', count: doneTasks }, doneFrom, doneTo);
      emit(`- (${doneTasks} completed task${doneTasks > 1 ? 's' : ''} omitted)`, at);
    }
    doneTasks = 0;
  };
  const sink = options.constraintSink;
  const alertView = alertTags(alerts, lines, emit, flushDone, (callout, at) => {
    if (sink && inScope(at) && !dropping() && !inAgent() && !inDanger()) recordConstraint(sink, callout, '', at);
  });

  for (let i = from; i < lines.length; i++) {
    current = i;
    // Inside a GitHub alert, the line without its quote marker; nothing for the alert's own marker line.
    const raw = alertView.line(i, lines[i]);
    if (raw === undefined) continue;

    // ---- fenced code ----
    if (fence) {
      if (new RegExp(`^\\s{0,3}${fence.marker[0] === '`' ? '`' : '~'}{${fence.marker.length},}\\s*$`).test(raw)) {
        const rendered = renderFence(fence, i, { ...options, brief: briefAt(fence.start) });
        if (rendered.omission && visibleAt(fence.start)) omit(rendered.omission, fence.start, i);
        for (const l of rendered.lines) emit(l, fence.start, true, i);
        fence = null;
      } else {
        fence.body.push(raw);
      }
      continue;
    }
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (f) {
      flushDone(i);
      fence = { marker: f[1], start: i, body: [], info: f[2] };
      continue;
    }

    // ---- indented code and display math: as written, like fenced code (no line of them is a task, a table or a comment) ----
    if (literal.has(i)) {
      flushDone(i);
      emit(raw, i);
      continue;
    }

    // ---- HTML comments ----
    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      line = line.slice(end + 3);
      inComment = false;
      if (visibleAt(i)) omit(COMMENT, commentStart, i);
    }
    const uncommented = line.replace(/<!--[\s\S]*?-->/g, '');
    if (uncommented !== line && visibleAt(i)) omit(COMMENT, i, i);
    line = uncommented;
    const startComment = line.indexOf('<!--');
    if (startComment >= 0) { line = line.slice(0, startComment); inComment = true; commentStart = i; }
    if (raw.trim() && !line.trim()) continue;

    // ---- containers ----
    if (CONTAINER_CLOSE.test(line)) {
      // The containers the fence closes, innermost first (spec v2 may close several, see closedBy).
      const at = closedBy(stack.map((f) => f.colons), closerColons(line), spec);
      if (at >= 0) flushDone(i);
      popFrames(stack, at, (frame) => closeFrame(frame, i));
      continue;
    }
    const open = CONTAINER_OPEN.exec(line);
    const info = open ? parseContainerInfo(open[3] + open[4], spec) : null;
    if (open && info) {
      flushDone(i);
      const title = info.title ? text(info.title) : '';
      // A constraint here, for the constraints pass: one inside a danger block or :::agent is already shown.
      if (sink && inScope(i) && !dropping() && !inAgent() && !inDanger()) {
        recordConstraint(sink, info.name, info.name === 'include' ? info.attrs.values.file ?? '' : title, i, info.attrs.values.status, info.attrs.id);
      }
      const frame: Frame = { name: info.name, colons: open[2].length, drop: false, start: i, visible: inScope(i) && !dropping() };
      stack.push(frame);
      if (info.name === 'human' && !options.includeHuman) { frame.drop = true; continue; }
      if (REVIEW_CONTAINERS.includes(info.name)) {
        const review = reviewHead(info.name, (options.review ?? reviewOf(lines)).get(i), info.attrs.values, title, !!options.includeReview);
        if (!review) {
          if (frame.visible) options.closedReview && options.closedReview.count++;
          frame.drop = true;
          continue;
        }
        emit(review.line!, i);
        frame.close = review.close;
        continue;
      }
      // Condensed in brief views, but not inside :::agent: there it is part of the instructions.
      if (info.name === 'details' && briefAt(i) && !inAgent()) {
        emit(`[details: ${title || 'Details'} — omitted, see L${i + 1}]`, i);
        frame.condensed = 'details';
        continue;
      }
      if (info.name === 'include') {
        // Traced inside: its lines are the included file's (see includeView).
        const shown = visibleAt(i);
        if (shown) {
          includeView(info, lines, i, { ...options, brief: briefAt(i), figures, trace, pick: undefined }).forEach((l) => emit(l, i, false));
        } else if (options.pick) {
          // A picked block may be inside the included file: its lines are picked there.
          if (inScope(i) && !stack.some((f) => f.drop) && options.includes !== false) {
            const picked = includeView(info, lines, i, { ...options, figures, trace: trace && { ...trace, omissions: undefined } });
            if (picked.length > 2) out.push(...picked);
          }
        } else if (inScope(i) && !stack.some((f) => f.drop) && !options.onlyConstraints && options.includes !== false) {
          // Hidden only because it is condensed or this pass shows agent blocks alone: the included file's :::agent
          // blocks still apply, as the document's own do (C01).
          const rules = includeView(info, lines, i, { ...options, figures, trace: trace && { ...trace, omissions: undefined }, onlyMandatory: true });
          if (rules.length > 2) {
            for (const l of rules) {
              out.push(l);
              options.collect?.push([i, l]);
            }
          }
        }
        frame.drop = true; // the body is fallback text for renderers that can't include
        continue;
      }
      frame.id = info.attrs.id;
      // A deprecated requirement is condensed to its opening line in brief views (semantic tags R23).
      if (info.name === 'requirement' && options.brief && !inAgent() && info.attrs.values.status?.toLowerCase() === 'deprecated') {
        emit(`[requirement${info.attrs.id ? ` ${info.attrs.id}` : ''} (deprecated): ${title || 'Requirement'} — omitted, see L${i + 1}]`, i);
        frame.condensed = 'deprecated';
        continue;
      }
      const requirement = info.name === 'acceptance' ? [...stack].reverse().find((f) => f !== frame && f.name === 'requirement')?.id : undefined;
      const tags = TAG_HEADS.has(info.name) ? tagsHere() : undefined;
      const head = containerHead(info.name, {
        title, values: info.attrs.values, id: info.attrs.id, figure: ownFigures.get(i), requirement,
        ...(tags ? { tags: { block: tags.byLine.get(i), context: tags } } : {}),
      });
      if (head.line !== undefined) emit(head.line, i);
      frame.close = head.close;
      continue;
    }

    // ---- headings ----
    const h = /^(\s{0,3}#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushDone(i);
      emit(`${h[1].trim()} ${headingText(h[2], changelogs.get(i), text, spec)}${lineRefs ? `  [L${i + 1}]` : ''}`, i);
      continue;
    }

    // ---- tasks ----
    // A task-shaped line that rendering shows as text (in a paragraph it continues) is not a task.
    const shape = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+(.*)$/.exec(line);
    const task = shape && taskLines.has(i) ? shape : null;
    if (task && task[2] !== ' ' && briefAt(i)) {
      if (inScope(i) && !dropping()) {
        if (!doneTasks) doneFrom = i;
        doneTasks++;
        doneTo = i;
      }
      continue;
    }
    if (!task) {
      if (line.trim()) flushDone(i);
    }

    // ---- tables ----
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      const isDelimiter = cells.every((c) => /^:?-{1,}:?$/.test(c));
      emit(isDelimiter ? `|${cells.map(() => '-').join('|')}|` : `|${cells.map((c) => text(c)).join('|')}|`, i);
      continue;
    }

    // Math and items that run on from one line to the next are known for the line as written (not with a comment or an
    // alert's quote marker cut out).
    const asWritten = line === lines[i];
    const converted = text(line, task ? task[2] === ' ' : false, asWritten ? inlineMath.get(i) : undefined, asWritten ? inlineItems.get(i) : undefined);
    emit(converted.trimEnd(), i);
  }
  alertView.end();
  flushDone(lines.length - 1);
  // Blocks left open at the end close there, for provenance (nothing is emitted for them, as before).
  if (trace?.omissions) for (const frame of stack) if (frame.visible) closeFrame({ ...frame, close: undefined }, lines.length - 1);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const COMMENT = { kind: 'comment', reason: 'HTML comments are not part of the view' } as const;

/**
 * A container that the constraints pass reports: a danger, warning or question, an accepted decision, an include, a
 * constraint (kept only when it applies nowhere in the view, see constraintsOutside).
 */
function recordConstraint(sink: ConstraintPointer[], name: string, title: string, line: number, status?: string, id?: string): void {
  if (name === 'decision' && status?.trim().toLowerCase() !== 'accepted') return;
  if (!['danger', 'warning', 'question', 'decision', 'include', 'constraint'].includes(name)) return;
  sink.push({ type: name as ConstraintPointer['type'], title, line, section: null, ...(name === 'constraint' && id ? { id } : {}) });
}

interface DocumentContext {
  figures: ExpandedFigures; ownFigures: ReadonlyMap<number, Figure>; literal: ReadonlySet<number>; inlineMath: InlineMathLines; alerts: readonly AlertLines[];
  inlineItems: InlineItemLines; taskLines: ReadonlySet<number>;
}

/**
 * The figures (numbered with the rest of the expanded document), this document's own figures by line, the lines
 * of code and display math, its GitHub alerts, multi-line inline items and task lines, from `options` when the
 * caller has them, else from `lines`.
 */
function documentContext(lines: string[], options: TransformOptions): DocumentContext {
  const text = lines.join('\n');
  const figures = options.figures ?? expandedFigures(text, viewReader(options));
  return {
    figures, ownFigures: figuresOf(figures, options.figureKey ?? ''), literal: options.literalLines ?? literalLines(text), inlineMath: options.inlineMath ?? inlineMathLines(text),
    alerts: options.alerts ?? alertLines(text), inlineItems: options.inlineItems ?? inlineItemLines(text), taskLines: options.taskLines ?? renderedTaskLines(text),
  };
}

/** A blockquote's `>` marker, with the space after it. */
const QUOTE_MARKER = /^ {0,3}> ?/;

/**
 * GitHub alerts in the agent view, as callouts (spec §3.8): `<warning>` on the quote's first line, its lines without
 * the `>` marker (the marker line itself left out), then `</warning>` after its last line that isn't blank.
 */
function alertTags(
  alerts: readonly AlertLines[], lines: string[], emit: (line: string, at: number) => void, flush: (at: number) => void,
  opened?: (callout: string, at: number) => void,
) {
  const byStart = new Map(alerts.map((a) => [a.start, a]));
  let open: { alert: AlertLines; last: number } | undefined;
  const close = () => {
    if (!open) return;
    flush(open.last);
    emit(`</${open.alert.callout}>`, open.last);
    open = undefined;
  };
  return {
    /** Line `i` as the view reads it, or undefined for an alert's marker line. */
    line(i: number, raw: string): string | undefined {
      if (open && i > open.last) close();
      const alert = byStart.get(i);
      if (alert) {
        close();
        let last = alert.end - 1;
        while (last > alert.start && !lines[last]?.trim()) last--;
        flush(i);
        opened?.(alert.callout, i);
        open = { alert, last };
        emit(`<${alert.callout}>`, i);
      }
      if (!open) return raw;
      return i === open.alert.marker ? undefined : raw.replace(QUOTE_MARKER, '');
    },
    /** Close an alert that runs to the end of the lines. */
    end: close,
    /** The callout of the alert open now, if any. */
    callout: (): string | undefined => open?.alert.callout,
  };
}

/** The agent view of lines [start, end] (zero-based, inclusive) on their own, e.g. one block. */
export function agentViewOfRange(lines: string[], start: number, end: number, options: AgentViewOptions = {}): string {
  const text = lines.join('\n');
  const variables = documentVariables(lines);
  const whole = { figures: expandedFigures(text, viewReader(options)), changelogs: changelogEntries(lines, 0, specVersion(variables)), variables, literalLines: literalLines(text), inlineMath: inlineMathLines(text),
    alerts: alertLines(text), inlineItems: inlineItemLines(text), taskLines: renderedTaskLines(text), review: reviewOf(lines) };
  return transform(lines.slice(0, end + 1), start, () => true, { ...options, ...whole }).trim();
}

/** A heading's words; a changelog release in brief, `1.2.0 (2026-03-01)`, the version without its link. */
function headingText(raw: string, entry: ChangelogEntry | undefined, text: (s: string) => string, spec: SpecVersion): string {
  if (!entry) return text(withoutHeadingAttrs(raw, spec));
  const version = text(versionLabel(entry.version));
  return entry.date ? `${version} (${text(entry.date)})` : version;
}

/**
 * `:::include` in the agent view: the included text inside `<included file="…" section="…">` (line references in it
 * are lines of that file), or a one-line pointer when it isn't expanded or can't be read.
 */
function includeView(info: ContainerInfo, lines: string[], line: number, options: TransformOptions): string[] {
  const request = includeRequest(info.attrs.values);
  if (!request) return ['[include: no file given]'];
  const scope = options.includeScope ?? rootScope(lines.join('\n'));
  const label = includeLabel(includePath(scope.dir, request.file), request.section);
  const trace = options.trace;
  const omitInclude = (reason: string) => {
    if (trace?.omissions) addOmission(trace.omissions, { kind: 'include', file: trace.file, lines: [line + 1, line + 1], reason });
  };
  if (options.includes === false) {
    omitInclude(`the included file ${label} is a pointer (includes are off)`);
    return [`[include: ${label} — read that file for the content]`];
  }
  const result = loadInclude(request, scope, includeSource(options.readFile));
  if (!result.ok) {
    const problem = includeProblemText(result);
    const reason = result.problem === 'unavailable' ? 'read that file for the content' : problem[0].toLowerCase() + problem.slice(1);
    omitInclude(`the included file ${label} was not shown: ${reason}`);
    return [`[include: ${label} — ${reason}]`];
  }
  const inc = result.include;
  // Included text uses this document's front matter variables, as the rendered HTML does.
  const inner = {
    ...options, collect: undefined, pinned: undefined, docPath: inc.path, includeScope: innerScope(scope, inc), variables: options.variables ?? documentVariables(lines), literalLines: includedLiteralLines(inc),
    inlineMath: includedInlineMath(inc), alerts: includedAlerts(inc), inlineItems: includedInlineItems(inc), taskLines: includedTaskLines(inc),
    // Its figures are numbered with the including document's, and `:ref` resolves across both, as in rendered output.
    figureKey: includeKey(options.figureKey ?? '', line),
    // Its lines are traced as the included file's lines, under the line of the outermost include.
    trace: trace && { ...trace, file: inc.path, root: trace.root ?? line },
    // Its :::agent lines count as the include's line (see budgetedView).
    onAgentLine: options.onAgentLine && (() => options.onAgentLine!(line)),
  };
  const all = includedLines(inc);
  // Sections the included file marks {agent=skip} stay out, as in the document itself.
  const skipped = sectionsOf(parseSmd(all.join('\n')).headings, all.length)
    .filter((s) => s.heading.agent === 'skip' && s.end >= inc.start && s.start <= inc.end);
  if (trace?.omissions) {
    for (const s of skipped) {
      addOmission(trace.omissions, {
        kind: 'skipped-section', file: inc.path, lines: [Math.max(s.start, inc.start) + 1, Math.min(s.end, inc.end) + 1], heading: s.heading.text,
        reason: 'the included file marks this section {agent=skip}',
      });
    }
  }
  const inScope = (l: number) => !skipped.some((s) => l >= s.start && l <= s.end);
  const body = transform(all.slice(0, inc.end + 1), inc.start, inScope, inner);
  const section = request.section ? ` section="${request.section}"` : '';
  return [`<included file="${inc.path}"${section}>`, ...withoutBlankEnds(body.split('\n')), '</included>'];
}

/** Lines without the blank ones at the start and at the end. */
function withoutBlankEnds(lines: string[]): string[] {
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return [];
  let last = lines.length - 1;
  while (!lines[last].trim()) last--;
  return lines.slice(first, last + 1);
}

/** A fence in the view, and what it left out (for provenance). */
interface RenderedFence { lines: string[]; omission?: Omit<Omission, 'file' | 'lines'> }

function renderFence(fence: { start: number; body: string[]; info: string }, endLine: number, options: TransformOptions): RenderedFence {
  const info = parseFenceInfo(fence.info);
  const lang = info.lang.toLowerCase();
  const ref = `L${fence.start + 1}-L${endLine + 1}`;
  if (lang === 'mermaid') {
    if (!options.brief) return { lines: ['```mermaid', ...fence.body, '```'] };
    const kind = fence.body.find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim().split(/[\s;:]/)[0] ?? 'diagram';
    const title = fence.body.map((l) => /^\s*title\s+(.+)$/.exec(l)?.[1] ?? /^\s*\w+\s+title\s+(.+)$/.exec(l)?.[1]).find(Boolean);
    return {
      lines: [`[diagram: ${kind}${title ? ` "${title.replace(/"/g, '')}"` : ''}, ${fence.body.length} lines — see ${ref}]`],
      omission: { kind: 'diagram', reason: 'a Mermaid diagram is condensed to one line in brief views' },
    };
  }
  const label = info.title ? `${info.title}:` : null;
  if (info.file) {
    const range = info.lines ? ` lines ${info.lines[0]}-${info.lines[1]}` : '';
    if (options.embed && options.readFile) {
      const content = options.readFile(info.file);
      if (content !== undefined) {
        const body = sliceLines(content, info.lines).text.replace(/\n$/, '').split('\n');
        return { lines: [`${info.file}${range}:`, '```' + info.lang, ...body, '```'] };
      }
    }
    const reason = options.embed ? `the embedded file ${info.file} could not be read` : `the embedded file ${info.file} is a pointer (embed shows it)`;
    return { lines: [`[code: ${info.file}${range} — read that file for the content]`], omission: { kind: 'embed', reason } };
  }
  let body = fence.body;
  if (options.brief && body.length > 15) {
    body = [...body.slice(0, 10), `… (${body.length - 10} more lines, see ${ref})`];
    const omission = { kind: 'code', reason: `long code is cut to its first 10 lines in brief views (${fence.body.length - 10} left out)` } as const;
    return { lines: [...(label ? [label] : []), '```' + info.lang, ...body, '```'], omission };
  }
  return { lines: [...(label ? [label] : []), '```' + info.lang, ...body, '```'] };
}

const STATUS_WORDS: Record<string, string> = { green: 'ok', teal: 'ok', red: 'bad', pink: 'bad', orange: 'warn', amber: 'warn', yellow: 'warn' };

/** How {@link inlineText} reads a line. Every field is optional. */
export interface InlineTextOptions {
  /** "Today" as YYYY-MM-DD: a `:due[…]` before it, on an open task, reads `(due …, OVERDUE)`. */
  today?: string;
  /** The line is an open task's (`- [ ] …`), so a past `:due[…]` is overdue. Default false. */
  openTask?: boolean;
  /** The document's figures by id: `:ref[id]` becomes `Figure 2 (id)`. Without them it stays as written. */
  figures?: ReadonlyMap<string, FigureNumber>;
  /** The document's front matter: `{{name}}` becomes the value of `name`. Without it, `{{name}}` stays as written. */
  variables?: Variables;
  /**
   * The line's inline math as `[start, end)` offsets, when it is read with the lines around it (see mathOnLine);
   * by default it is read from the line.
   */
  math?: ReadonlyArray<[number, number]>;
}

/**
 * Strip styling syntax from one line, keeping the words. Code spans and `$inline math$` are left
 * untouched. With the document's figures by id, `:ref[id]` becomes `Figure 2 (id)`; with its front matter,
 * `{{name}}` becomes the value of `name` (see {@link InlineTextOptions}).
 *
 * Since 2.0 the options are one object: 1.x's `inlineText(line, today, true)` is `inlineText(line, { today, openTask: true })`.
 */
export function inlineText(line: string, options: InlineTextOptions = {}): string {
  // JavaScript callers of the 1.x signature get an error, not a line read without their arguments.
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('inlineText(line, options): since 2.0 the options are one object, e.g. inlineText(line, { today, openTask: true })');
  }
  const { today, openTask = false, figures, variables, math } = options;
  // The front matter decides the rules: a spec v2 document's directives read in any case, and unknown ones show their content.
  return styledText(line, { today, openTask, figures, variables, spec: specVersion(variables) }, math);
}

/** inlineText read with the rules of `spec`, its `{{name}}` replaced from `variables` when given. Internal. */
export function plainInlineText(line: string, spec: SpecVersion, variables?: Variables): string {
  return styledText(line, { openTask: false, spec, variables });
}

/** How inlineText reads a line: the date for overdue tasks, whether it is an open task's, the figures and front matter. */
interface TextContext {
  today?: string; openTask: boolean; figures?: ReadonlyMap<string, FigureNumber>;
  /** The ids exactly one block gives, which `:ref[id]` shows as written when no figure has them (D4). */
  blocks?: ReadonlySet<string>;
  variables?: Variables; spec: SpecVersion;
  /** The tasks of the line's section, for `:progress{basis=tasks}`; unknown without it. */
  counts?: () => TaskCount;
}

/**
 * inlineText, with parts of the line already converted (see convertedParts): they are put back as converted, and the
 * rest of the line is read around them.
 */
function styledText(line: string, read: TextContext, math?: ReadonlyArray<[number, number]>, replaced?: ReadonlyArray<[number, number, string]>): string {
  return aroundInlineMath(line, (text) => text
    .split(/(`+[^`]*`+)/)
    .map((part, idx) => (idx % 2 === 1 ? part : plain(substituteVariables(part, read.variables), read)))
    .join(''), math, replaced);
}

/**
 * `:ref[id]` → `Figure 2 (id)`, or the id for another block that gives it (D4); references to unknown or ambiguous ids
 * stay as written.
 */
function refText(s: string, figures: ReadonlyMap<string, FigureNumber> | undefined, spec: SpecVersion, blocks?: ReadonlySet<string>): string {
  if (!figures?.size && !blocks?.size) return s;
  return s.replace(refDirective(spec), (m, pre: string, raw: string) => {
    const id = raw.trim();
    const figure = figures?.get(id);
    if (figure) return `${pre}${figure.label} (${id})`;
    return blocks?.has(id) ? `${pre}${id}` : m;
  });
}

/**
 * `:name[content]{attrs}` in text: a lower-case name in spec v1, any case in spec v2 (RFC proposal 11). A name with
 * neither `[content]` nor `{attributes}` is text, as in rendering. Content may run over a line break when an item is
 * read whole (see convertedParts).
 */
const DIRECTIVE_TEXT_V1 = /(^|[\s([{>*_~"'-]):([a-z][a-z0-9-]*)(?:\[([^\]]*)\])?(?:\{([^{}\n]*)\})?/g;
const DIRECTIVE_TEXT_V2 = /(^|[\s([{>*_~"'-]):([A-Za-z][A-Za-z0-9-]*)(?:\[([^\]]*)\])?(?:\{([^{}\n]*)\})?/g;

function plain(s: string, { today, openTask, figures, blocks, spec, counts }: TextContext): string {
  return refText(s, figures, spec, blocks)
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, (_m, alt) => (alt ? `[image: ${alt}]` : ''))
    .replace(spec >= 2 ? DIRECTIVE_TEXT_V2 : DIRECTIVE_TEXT_V1, (m, pre: string, name: string, content?: string, rawAttrs?: string) =>
      (content === undefined && rawAttrs === undefined
        ? m
        : directiveText(m, { pre, name: spec >= 2 ? name.toLowerCase() : name, content: content ?? '', rawAttrs: rawAttrs ?? '' }, { today, openTask, spec, counts })))
    .replace(/(!?)\[([^\]]*)\]\{([^{}\n]*)\}/g, (m, bang, content, rawAttrs) => (bang || !parseAttrs(rawAttrs, spec) ? m : content))
    .replace(/==(?=\S)([^=]+?)(?<=\S)==/g, '$1');
}

/**
 * A bar with a basis in the view, after its label when it has one: `[progress 80%: 8 of 10 tasks checked]`,
 * `[progress unknown]`, `[progress 40% (estimated)]`. Undefined for a bar without one, which reads as before.
 */
function progressBasisText(v: Record<string, string>, content: string, counts?: () => TaskCount): string | undefined {
  if (countsTasks(v) && !counts) return `${v.label ? `${v.label} ` : ''}[progress: the checked tasks of its section]`;
  const state = progressState(v, content, countsTasks(v) ? counts?.() : undefined);
  return state.kind === 'plain' ? undefined : `${v.label ? `${v.label} ` : ''}${progressTag(state)}`;
}

const METRIC_TRENDS = new Set(['up', 'down', 'flat']);

/**
 * What a `:metric` says beyond its value and delta (contract GAP-6): its written `trend`, then `good` or `bad` when
 * the author wrote which direction is good, as the rendered colour shows it. The trend of a metric without one comes
 * from the delta's sign, as rendering does, but is not printed: the delta already shows it. Without a written `good`
 * the view says nothing about tone, since the author did not say (contract rule 3).
 */
function metricMeaning(v: Record<string, string>): string[] {
  const written = v.trend?.toLowerCase();
  const trend = written ?? (v.delta ? (v.delta.trim().startsWith('-') ? 'down' : 'up') : undefined);
  const good = v.good?.toLowerCase();
  const out: string[] = [];
  if (written && METRIC_TRENDS.has(written)) out.push(written);
  if ((good === 'up' || good === 'down') && (trend === 'up' || trend === 'down')) out.push(trend === good ? 'good' : 'bad');
  return out;
}

/**
 * One `:name[content]{attrs}` in plain text (`m` as written), or `m` for a name the agent view keeps as written. In
 * spec v2 a name outside the vocabulary is a directive that shows its content (RFC proposal 7b), as a styled span does;
 * in spec v1 it is text.
 */
function directiveText(
  m: string, { pre, name, content, rawAttrs }: { pre: string; name: string; content: string; rawAttrs: string },
  { today, openTask, spec, counts }: { today: string | undefined; openTask: boolean; spec: SpecVersion; counts?: () => TaskCount },
): string {
  const attrs = parseAttrs(rawAttrs, spec);
  // In spec v2 a list that can't be read leaves the whole item as text, as rendering does.
  if (spec >= 2 && !attrs) return m;
  if (spec >= 2 && !Object.hasOwn(INLINE_DIRECTIVES, name)) return `${pre}${content}`;
  // Spec v1 reads only its own frozen names (D5): a directive added later is text there.
  if (!isKnownDirective(name, spec)) return m;
  const v = attrs?.values ?? {};
  const status = own(STATUS_WORDS, v.color ?? '');
  switch (name) {
    case 'badge': return `${pre}[${content}]`;
    case 'priority': return `${pre}[${content}]`;
    case 'kbd': return `${pre}${content}`;
    // The ids stay as written, so an agent can look each one up.
    case 'depends': return `${pre}(depends on ${idList(content).join(', ')})`;
    case 'mention': return `${pre}${content}`;
    case 'status': return `${pre}[status: ${content}${status ? ` (${status})` : ''}]`;
    case 'progress': return `${pre}${progressBasisText(v, content, counts) ?? v.label ?? `${Math.round(Number(v.value ?? content) || 0)}%`}`;
    case 'due': {
      const late = openTask && dueState(content.trim(), today) === 'overdue';
      return `${pre}(due ${content}${late ? ', OVERDUE' : ''})`;
    }
    case 'metric': {
      const notes = [v.delta, ...metricMeaning(v)].filter(Boolean);
      return `${pre}${v.label ? `${v.label}: ` : ''}${content}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    }
    default: return m;
  }
}

// ---------------------------------------------------------------------------
// Outline: a table of contents with per-section token costs, so an agent can
// decide what to read before reading anything.
// ---------------------------------------------------------------------------

/**
 * The agent view of any line range, as `transform` would produce it for that scope. The document is
 * transformed once and each range is cut from the result, so an outline stays linear in document
 * size. Brief views count completed tasks per scope, so they are transformed per range.
 */
function sectionViews(lines: string[], from: number, documentOptions: TransformOptions): (start: number, end: number) => string {
  const text = lines.join('\n');
  const variables = documentVariables(lines);
  const options = {
    ...documentOptions, figures: expandedFigures(text, viewReader(documentOptions)), changelogs: changelogEntries(lines, 0, specVersion(variables)), variables, literalLines: literalLines(text),
    inlineMath: inlineMathLines(text),
  };
  if (options.brief) return (start, end) => transform(lines, from, (l) => l >= start && l <= end, options);
  const emitted: Array<[number, string]> = [];
  transform(lines, from, () => true, { ...options, collect: emitted });
  const bound = (line: number) => {
    let lo = 0;
    let hi = emitted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (emitted[mid][0] < line) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const ordered = emitted.every((e, i) => i === 0 || emitted[i - 1][0] <= e[0]);
  return (start, end) => {
    const inRange = ordered
      ? emitted.slice(bound(start), bound(end + 1))
      : emitted.filter(([at]) => at >= start && at <= end);
    return inRange.map(([, line]) => line).join('\n').replace(/\n{3,}/g, '\n\n');
  };
}

/** A section (its heading up to the next heading of the same or a higher level) and the cost of reading it. */
export interface SectionCost {
  heading: Heading;
  /** Zero-based first and last line. */
  start: number;
  end: number;
  /** Approximate tokens of the section, subsections included, in the agent view (without line references). */
  tokens: number;
  /** The same text counted with `options.tokenizer`, when one is given. */
  counted?: number;
}

/** Every section of a document with its agent-view token cost, as `outline` lists them. */
export function sectionCosts(text: string, viewOptions: AgentViewOptions = {}): SectionCost[] {
  return oneView(viewOptions, (options) => sectionCostsOf(text, options));
}

function sectionCostsOf(text: string, options: AgentViewOptions): SectionCost[] {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const sectionView = sectionViews(lines, fm.bodyStartLine, { ...options, lineRefs: false });
  return sectionsOf(parseSmd(text).headings, lines.length).map((s) => {
    const view = sectionView(s.start, s.end);
    return { ...s, tokens: estimateTokens(view), ...(options.tokenizer ? { counted: options.tokenizer.count(view) } : {}) };
  });
}

/** The agent view of any line range of a document (zero-based, inclusive), with the context of the whole document. */
export function agentViewRanges(text: string, options: AgentViewOptions = {}): (start: number, end: number) => string {
  const view = sectionViews(text.split(/\r?\n/), parseFrontMatter(text).bodyStartLine, options);
  return (start, end) => view(start, end).replace(/\n{3,}/g, '\n\n').trim();
}

/** An outline note and the line that earns it: a fence that opens a diagram, or a container's opening line. */
interface SectionMark { note: string; line: RegExp; fence?: true }

const SECTION_MARKS: SectionMark[] = [
  { note: 'diagram', line: /^\s*```\s*mermaid/, fence: true },
  { note: 'AGENT INSTRUCTIONS', line: /^\s*:{3,}\s*agent\b/ },
  { note: 'API', line: /^\s*:{3,}\s*api\b/ },
  { note: 'decision', line: /^\s*:{3,}\s*decision\b/ },
  { note: 'risk', line: /^\s*:{3,}\s*risk(?![\w-])/ },
  { note: 'requirement', line: /^\s*:{3,}\s*requirement(?![\w-])/ },
  { note: 'constraint', line: /^\s*:{3,}\s*constraint(?![\w-])/ },
  { note: 'assumption', line: /^\s*:{3,}\s*assumption(?![\w-])/ },
  { note: 'open question', line: /^\s*:{3,}\s*question\b/ },
];

/**
 * Whether lines [start, end] of a document have a line that earns a note, as rendering reads them: code and
 * display math are shown as written, so a `:::decision` line there is text, and a ```` ```mermaid ```` line is a
 * diagram only where it opens a fence. The document is parsed only when a line has the shape of a mark.
 */
function sectionMarks(text: string, lines: string[]): (mark: SectionMark, start: number, end: number) => boolean {
  const opensFence = lazyLineSet(() => fenceLines(text));
  const isLiteral = lazyLineSet(() => literalLines(text));
  const counts = (mark: SectionMark, i: number) => (mark.fence ? opensFence(i) : !isLiteral(i));
  return (mark, start, end) => lines.slice(start, end + 1).some((l, k) => mark.line.test(l) && counts(mark, start + k));
}

export function outline(text: string, viewOptions: AgentViewOptions = {}): string {
  return oneView(viewOptions, (options) => outlineOf(text, options));
}

function outlineOf(text: string, options: AgentViewOptions): string {
  const fm = parseFrontMatter(text);
  const lines = text.split(/\r?\n/);
  const headings = parseSmd(text).headings;
  const full = agentView(text, { ...options, sections: undefined, maxTokens: undefined, provenance: false, constraints: false });
  const title = typeof fm.data.title === 'string' ? fm.data.title : headings.find((h) => h.level === 1)?.text ?? '(untitled)';
  const status = typeof fm.data.status === 'string' ? ` · ${fm.data.status}` : '';
  const out: string[] = [
    `${title}${status} · ${outlineCosts(full)}`,
  ];
  if (typeof fm.data.summary === 'string') out.push(`summary: ${fm.data.summary}`);
  out.push('');

  // Counted as `smd tasks` counts them: a task-shaped line in code is code.
  const openTaskAt = openTaskLines(text);
  const marked = sectionMarks(text, lines);
  const rows = sectionCosts(text, options).map((s) => {
    const openTasks = openTaskAt.filter((l) => l >= s.start && l <= s.end).length;
    const notes = [
      openTasks ? `${openTasks} open task${openTasks > 1 ? 's' : ''}` : '',
      ...SECTION_MARKS.map((mark) => (marked(mark, s.start, s.end) ? mark.note : '')),
      s.heading.agent === 'skip' ? 'skipped for agents' : '',
    ].filter(Boolean).join(', ');
    const range = `L${s.start + 1}-${s.end + 1}`;
    const indent = '  '.repeat(Math.max(0, s.heading.level - 2));
    return { range, head: `${indent}${'#'.repeat(s.heading.level)} ${s.heading.text}`, tokens: sectionCost(s), notes };
  });
  const w1 = Math.max(...rows.map((r) => r.range.length), 5);
  const w2 = Math.max(...rows.map((r) => r.head.length), 10);
  const w3 = costWidth(rows.map((r) => r.tokens), options.tokenizer);
  for (const r of rows) {
    out.push(`${r.range.padEnd(w1)}  ${r.head.padEnd(w2)}  ${r.tokens.padStart(w3)}${r.notes ? `  ${r.notes}` : ''}`);
  }
  out.push('', 'Read a section: smd agent <file> --section "<heading or id>"   (repeatable; add --brief to condense)');
  return out.join('\n') + '\n';
}

/** `file ≈2430 tokens · full agent view ≈1531 tokens`, with a tokenizer `file ≈2430 est · 2210 o200k_base tokens · …` */
function outlineCosts(full: AgentViewResult): string {
  const counted = full.counted;
  if (!counted) return `file ≈${full.originalTokens} tokens · full agent view ≈${full.tokens} tokens`;
  const pair = (estimate: number, exact: number) => `≈${estimate} est · ${exact} ${counted.tokenizer} tokens`;
  return `file ${pair(full.originalTokens, counted.originalTokens)} · full agent view ${pair(full.tokens, counted.tokens)}`;
}

/** A section's cost column: `≈420`, with a tokenizer `≈420 · 402`. */
function sectionCost(s: SectionCost): string {
  return s.counted === undefined ? `≈${s.tokens}` : `≈${s.tokens} · ${s.counted}`;
}

function costWidth(costs: string[], tokenizer?: Tokenizer): number {
  return tokenizer ? Math.max(...costs.map((c) => c.length), 6) : 6;
}

// ---------------------------------------------------------------------------
// Evidence in review views (`evidence: 'full'`, research AF27)
// ---------------------------------------------------------------------------

/**
 * The lines that follow a requirement or acceptance block in a view with `evidence: 'full'`: for each record that
 * supports or contradicts it, a line that says how and whether it is outdated, then the record's own view unless the
 * block already holds it. A requirement with no record gets `[evidence: none for R1]`. Records are read on the first ask.
 */
function evidenceFollower(lines: string[], options: TransformOptions): (name: string, start: number, end: number) => string[] {
  let known: { blocks: DocumentBlock[]; records: EvidenceRecord[] } | undefined;
  const read = () => {
    if (!known) {
      const text = lines.join('\n');
      const blocks = documentBlocks(text, options.today);
      known = { blocks, records: evidenceRecords(text, blocks) };
    }
    return known;
  };
  return (name, start, end) => {
    if (name !== 'requirement' && name !== 'acceptance') return [];
    const { blocks, records } = read();
    const block = blocks.find((b) => b.line === start && b.type === name);
    const id = typeof block?.attrs.id === 'string' ? block.attrs.id : undefined;
    if (!id) return name === 'requirement' ? ['[evidence: none for this requirement, which has no id]'] : [];
    const mine = records.filter((r) => r.supports.some((t) => t.id === id) || r.contradicts.some((t) => t.id === id));
    if (!mine.length) return name === 'requirement' ? [`[evidence: none for ${id}]`] : [];
    return mine.flatMap((r) => {
      const inside = r.line > start && r.line <= end;
      const view = inside ? [] : agentViewOfRange(lines, r.line, r.endLine, { today: options.today, lineRefs: options.lineRefs, includeHuman: options.includeHuman }).split('\n');
      return [evidenceLine(r, id, inside), ...view];
    });
  };
}

/** `[evidence for R1: E1 supports it · test · pass · by @ci · L40]`, with OUTDATED and what to do when R1 changed since. */
function evidenceLine(r: EvidenceRecord, id: string, above: boolean): string {
  const support = r.supports.find((t) => t.id === id);
  const how = support ? 'supports it' : 'contradicts it';
  const facts = [r.method ?? 'method not stated', r.result ?? 'no result', ...(r.by ? [`by ${r.by}`] : []), ...(r.date ? [r.date] : [])];
  const target = support ?? r.contradicts.find((t) => t.id === id);
  const outdated = target?.freshness === 'outdated'
    ? [`OUTDATED: ${id} changed after revision ${target.recorded}, recheck before treating it as current`]
    : [];
  return `[evidence for ${id}: ${r.id ?? 'a record'} ${how} · ${[...facts, ...outdated].join(' · ')} · L${r.line + 1}${above ? ', shown above' : ''}]`;
}
