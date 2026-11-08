import { agentViewOfRange, inlineText } from './agentView';
import {
  closeContainers, closerColons, CONTAINER_CLOSE, CONTAINER_OPEN, displayMath, openerColons, parseContainerInfo, type ContainerInfo,
} from './containers';
import { parseFrontMatter } from './frontmatter';
import { extractTasks } from './meta';
import { parseSmd } from './parse';
import type { Heading } from './render';
import { CALLOUT_TYPES, CONTAINERS, RISK_LEVELS, STYLE_KEYS } from './spec';
import { own, suggest } from './util';
import { documentVariables } from './variables';
import { specVersion, type SpecVersion } from './specVersion';

/**
 * Block queries: select decisions, risks, API endpoints, callouts, tasks and headings by type and
 * attributes with CSS-like selectors, and get each match in the agent view.
 *
 *   decision[status=accepted]      risk[impact>=high][status!=closed]      api[method=POST|PUT]
 *   task[owner=@maya][done=false]  task[due<today]                          question, risk
 *   heading[level=2]               callout[title*=migration]                *[owner=@maya]
 *
 * A selector is a block type (`*` or none for any, `callout` for any callout) followed by attribute
 * tests and `:not(…)`; commas list alternatives. As in CSS, a space selects a descendant (`heading[title=Rollout] task`)
 * and `>` a direct child (`tabs > tab`), where headings and containers hold what is in them. Values compare case-insensitively and ignore a leading `@`.
 * `a|b` lists alternative values. `<`, `<=`, `>`, `>=` compare numbers, YYYY-MM-DD dates (and `today`),
 * priorities (P0 < P1 < … and critical < high < medium < low) and risk levels (low < … < critical).
 */

export type QueryOperator = '=' | '!=' | '*=' | '^=' | '$=' | '<' | '<=' | '>' | '>=' | 'exists';

export interface AttributeTest {
  key: string;
  op: QueryOperator;
  /** Alternatives, written `a|b`: the test passes when any of them does (for `!=`, when none equals). */
  values: string[];
}

/**
 * One selector: a block type (`*` for any) and the attribute tests a block must pass. `not` lists selectors it must
 * not match (`:not(…)`), and `ancestor` the selector an enclosing block (` `) or the parent (`>`) must match. A
 * selector without combinators or `:not` has only `type` and `tests`, as before tree selectors.
 */
export interface Selector {
  type: string;
  tests: AttributeTest[];
  not?: Selector[];
  ancestor?: { combinator: ' ' | '>'; selector: Selector };
}

/** A heading or container that holds a match. */
export interface QueryAncestor {
  type: string;
  /** Zero-based line of the heading or the opening fence. */
  line: number;
  title: string;
  id?: string;
}

/** A selector that can't be parsed, or names an unknown block type or attribute. */
export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelectorError';
  }
}

export interface QueryOptions {
  /** Condense diagrams, long code, details blocks and completed tasks in each match (as `smd agent --brief`). */
  brief?: boolean;
  /** Append [L12] source line references to headings in each match (default true). */
  lineRefs?: boolean;
  /** YYYY-MM-DD used for `today` and overdue tasks; defaults to the current date. */
  today?: string;
}

export interface QueryMatch {
  /** Container name (`decision`, `risk`, `api`, `warning`…), `task` or `heading`. */
  type: string;
  /** Zero-based first line. */
  line: number;
  /** Zero-based last line: the closing fence, the task line itself, or the last line of a heading's section. */
  endLine: number;
  title: string;
  /**
   * Attributes as written plus the spec's defaults (a decision is `proposed`, a risk's impact `medium`).
   * Tasks have `done`, `overdue`, and `owner` (a list), `priority`, `due` and `id` when given; headings `level` and `id`.
   */
  attrs: Record<string, string | string[]>;
  /** The nearest heading above the block; for a heading, its parent heading. */
  section: string | null;
  /** The headings and containers that hold the block, outermost first (T4). */
  ancestors: QueryAncestor[];
  /** The block in the agent view. */
  text: string;
}

const CONTAINER_TYPES = Object.keys(CONTAINERS);
const BLOCK_TYPES = ['*', 'task', 'heading', 'callout', ...CONTAINER_TYPES];
const COMMON_KEYS = ['title', 'section', 'type'];
const OWN_KEYS: Record<string, string[]> = {
  task: ['done', 'owner', 'priority', 'due', 'overdue', 'id'],
  heading: ['level', 'id', 'agent'],
};
const DEFAULTS: Record<string, Record<string, string>> = {
  decision: { status: 'proposed' },
  risk: { impact: 'medium' },
  api: { method: 'GET' },
  figure: { kind: 'figure' },
};
const PRIORITY_RANK: Record<string, number> = { p0: 0, critical: 0, p1: 1, high: 1, p2: 2, medium: 2, p3: 3, low: 3, p4: 4 };

/** Attributes a block type can have, or undefined when any key is allowed (`*`). */
function knownKeys(type: string): string[] | undefined {
  if (type === '*') return undefined;
  if (OWN_KEYS[type]) return [...COMMON_KEYS, ...OWN_KEYS[type]];
  const spec = CONTAINERS[type === 'callout' ? 'note' : type];
  return [...COMMON_KEYS, 'id', 'class', ...(spec.attrs ?? []).filter((k) => k !== 'title'), ...Object.keys(STYLE_KEYS)];
}

/** Parse `decision[status=accepted], risk[impact>=high]`. Throws a SelectorError that says what's wrong. */
export function parseSelector(source: string): Selector[] {
  return new SelectorParser(source).parse();
}

const ORDERED = new Set<QueryOperator>(['<', '<=', '>', '>=']);

class SelectorParser {
  private readonly src: string;
  private i = 0;

  constructor(source: string) {
    this.src = source.trim();
  }

  parse(): Selector[] {
    if (!this.src) throw new SelectorError('Empty selector. Try e.g. "decision[status=accepted]".');
    const selectors = this.list();
    if (this.i < this.src.length) this.fail(`Unexpected "${this.src[this.i]}"`);
    return selectors;
  }

  /** Selectors separated by commas, up to the end or a `)`. Keys are checked against `context` in `:not(…)`. */
  private list(context?: string): Selector[] {
    const selectors = [this.complex(context)];
    while (this.i < this.src.length && this.src[this.i] !== ')') {
      if (this.src[this.i] !== ',') this.fail(`Unexpected "${this.src[this.i]}". List several selectors with commas, e.g. "decision, risk"`);
      this.i++;
      selectors.push(this.complex(context));
    }
    return selectors;
  }

  /** Compound selectors joined by a space (descendant) or `>` (child). */
  private complex(context?: string): Selector {
    this.space();
    let selector = this.compound(context);
    for (;;) {
      const before = this.i;
      this.space();
      const next = this.src[this.i];
      if (next === undefined || next === ',' || next === ')') break;
      let combinator: ' ' | '>' = ' ';
      if (next === '>') {
        combinator = '>';
        this.i++;
        this.space();
      } else if (this.i === before) {
        this.fail(`Unexpected "${next}". List several selectors with commas, e.g. "decision, risk"`);
      }
      selector = { ...this.compound(context), ancestor: { combinator, selector } };
    }
    return selector;
  }

  /** A type, then attribute tests and `:not(…)`. */
  private compound(context?: string): Selector {
    const start = this.i;
    const name = this.take(/^(?:\*|[A-Za-z][\w-]*)/);
    const type = (name ?? '*').toLowerCase();
    if (!BLOCK_TYPES.includes(type)) {
      this.i = start;
      this.fail(`Unknown block type "${type}".${didYouMean(type, BLOCK_TYPES)} Types: ${BLOCK_TYPES.join(', ')}`);
    }
    const tests: AttributeTest[] = [];
    const not: Selector[] = [];
    for (;;) {
      if (this.src[this.i] === '[') {
        this.i++;
        tests.push(this.test());
      } else if (/^:not\(/i.test(this.src.slice(this.i, this.i + 5))) {
        this.i += 5;
        this.space();
        if (this.src[this.i] === ')') this.fail('Empty ":not()". Put a selector in it, e.g. "risk:not([status=closed])"');
        not.push(...this.list(name ? type : context));
        if (this.src[this.i] !== ')') this.fail('Missing ")" after ":not("');
        this.i++;
      } else if (this.src[this.i] === ':') {
        this.fail('Unknown pseudo-class. Only ":not(…)" is supported, e.g. "risk:not([status=closed])"');
      } else break;
    }
    if (!name && !tests.length && !not.length) {
      this.fail(this.src[this.i] === undefined ? `Missing a selector after "${this.previous()}"` : `Unexpected "${this.src[this.i]}"`);
    }
    checkKeys(name ? type : context ?? type, tests);
    return not.length ? { type, tests, not } : { type, tests };
  }

  /** The last character before the current position that is not a space. */
  private previous(): string {
    return this.src.slice(0, this.i).trimEnd().at(-1) ?? '';
  }

  /** One `[key op values]`, after its `[`. */
  private test(): AttributeTest {
    this.space();
    const key = this.take(/^[A-Za-z_][\w-]*/);
    if (!key) this.fail('Expected an attribute name after "["');
    this.space();
    const op = this.take(/^(?:!=|\*=|\^=|\$=|<=|>=|=|<|>)/) as QueryOperator | undefined;
    const values = op ? this.values(op) : [];
    if (this.src[this.i] !== ']') this.fail(this.expected(op));
    this.i++;
    return { key: key.toLowerCase(), op: op ?? 'exists', values };
  }

  private expected(op: QueryOperator | undefined): string {
    if (!op) return 'Expected "]" or an operator: = != *= ^= $= < <= > >=';
    return this.src[this.i] === undefined ? 'Missing "]"' : `Unexpected "${this.src[this.i]}"`;
  }

  /** `a|"b c"|d`, up to the closing `]`. */
  private values(op: QueryOperator): string[] {
    const values = [this.value(op)];
    while (this.src[this.i] === '|') {
      this.i++;
      values.push(this.value(op));
    }
    if (values.length > 1 && ORDERED.has(op)) this.fail(`"${op}" takes one value`);
    return values;
  }

  private value(op: QueryOperator): string {
    this.space();
    const quote = this.src[this.i];
    let value: string;
    if (quote === '"' || quote === "'") {
      const end = this.src.indexOf(quote, this.i + 1);
      if (end < 0) this.fail(`Missing closing ${quote}`);
      value = this.src.slice(this.i + 1, end);
      this.i = end + 1;
    } else {
      value = (this.take(/^[^\]|"']*/) ?? '').trim();
      if (!value) this.fail(`Missing value after "${op}"`);
    }
    this.space();
    return value;
  }

  /** Consume what `pattern` matches at the current position. */
  private take(pattern: RegExp): string | undefined {
    const match = pattern.exec(this.src.slice(this.i))?.[0];
    if (match) this.i += match.length;
    return match || undefined;
  }

  private space(): void {
    while (/\s/.test(this.src[this.i] ?? '')) this.i++;
  }

  private fail(message: string): never {
    throw new SelectorError(`${message} (column ${this.i + 1} of "${this.src}")`);
  }
}

function checkKeys(type: string, tests: AttributeTest[]): void {
  const known = knownKeys(type);
  const unknown = known && tests.find((t) => !known.includes(t.key));
  if (known && unknown) {
    throw new SelectorError(`"${type}" has no attribute "${unknown.key}".${didYouMean(unknown.key, known)} Attributes: ${known.join(', ')}`);
  }
}

function didYouMean(word: string, candidates: string[]): string {
  const hint = suggest(word, candidates);
  return hint ? ` Did you mean "${hint}"?` : '';
}

type Block = Omit<QueryMatch, 'text'>;

/** A block of a document as `query` sees it, without its agent view text. */
export type DocumentBlock = Block;

/**
 * Every block `query` can select (headings, tasks, containers), in document order, with lines, attributes as
 * written plus defaults, and the nearest section. Cheaper than `querySmd(text, '*')`: no agent view is built.
 */
export function documentBlocks(text: string, today = new Date().toISOString().slice(0, 10)): DocumentBlock[] {
  return blocksOf(text, text.split(/\r?\n/), today);
}

/** The blocks of a document that match any of the selectors, in document order. */
export function querySmd(text: string, selector: string | Selector[], options: QueryOptions = {}): QueryMatch[] {
  const selectors = typeof selector === 'string' ? parseSelector(selector) : selector;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const lines = text.split(/\r?\n/);
  const blocks = blocksOf(text, lines, today);
  const parents = ancestorBlocks(blocks);
  const matched = blocks.filter((b) => selectors.some((s) => matches(s, b, parents, today)));
  return matched.map((b) => ({
    ...b,
    text: agentViewOfRange(lines, b.line, b.endLine, { brief: options.brief, lineRefs: options.lineRefs, today, includeHuman: b.type === 'human' }),
  }));
}

function blocksOf(text: string, lines: string[], today: string): Block[] {
  const headings = parseSmd(text).headings;
  const sectionAt = (line: number) => {
    let section: string | null = null;
    for (const h of headings) {
      if (h.line >= line) break;
      section = h.text;
    }
    return section;
  };
  const blocks = [
    ...headingBlocks(headings, lines.length),
    ...taskBlocks(text, today, sectionAt),
    ...containerBlocks(lines, parseFrontMatter(text).bodyStartLine, sectionAt),
  ].sort((a, b) => a.line - b.line);
  for (const [block, held] of ancestorBlocks(blocks)) {
    block.ancestors = held.map((a) => ({ type: a.type, line: a.line, title: a.title, ...(typeof a.attrs.id === 'string' ? { id: a.attrs.id } : {}) }));
  }
  return blocks;
}

/** The headings and containers that hold each block, outermost first: those that start above it and end at or after it. */
function ancestorBlocks(blocks: Block[]): Map<Block, Block[]> {
  const holders = blocks.filter((b) => b.type !== 'task');
  return new Map(blocks.map((b) => [b, holders.filter((h) => h.line < b.line && h.endLine >= b.line)]));
}

function headingBlocks(headings: Heading[], lineCount: number): Block[] {
  return headings.map((h, i) => {
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    const parent = headings.slice(0, i).reverse().find((p) => p.level < h.level);
    return {
      type: 'heading', line: h.line, endLine: (next?.line ?? lineCount) - 1, title: h.text,
      attrs: { level: String(h.level), id: h.slug, ...(h.agent ? { agent: h.agent } : {}) },
      section: parent?.text ?? null,
      ancestors: [],
    };
  });
}

function taskBlocks(text: string, today: string, sectionAt: (line: number) => string | null): Block[] {
  return extractTasks(text, today).map((t) => ({
    type: 'task', line: t.line, endLine: t.line, title: t.text,
    attrs: {
      done: String(t.done),
      overdue: String(t.overdue ?? false),
      ...(t.assignees.length ? { owner: t.assignees } : {}),
      ...(t.priority ? { priority: t.priority } : {}),
      ...(t.due ? { due: t.due } : {}),
      ...(t.id ? { id: t.id } : {}),
    },
    section: sectionAt(t.line),
    ancestors: [],
  }));
}

function containerBlocks(lines: string[], from: number, sectionAt: (line: number) => string | null): Block[] {
  const variables = documentVariables(lines);
  const spec = specVersion(variables);
  const blocks: Block[] = [];
  const open: Array<{ block: Block; colons: number }> = [];
  let fence: Fence = null;
  const inMath = displayMath(lines, spec);
  for (let i = from; i < lines.length; i++) {
    const step = fenceStep(lines[i], fence);
    fence = step.fence;
    if (step.code || inMath(i)) continue;
    if (CONTAINER_CLOSE.test(lines[i])) {
      // The fence's own container ends on it; one closed with it (spec v2) ends on the line before.
      const done = closeContainers(open, closerColons(lines[i]), spec, (o) => o.colons);
      done.forEach((o, k) => { o.block.endLine = k === done.length - 1 ? i : i - 1; });
      continue;
    }
    const info = openingOf(lines[i], spec);
    if (!info) continue;
    const block: Block = { type: info.name, line: i, endLine: lines.length - 1, title: inlineText(info.title, { variables }), attrs: containerAttrs(info), section: sectionAt(i), ancestors: [] };
    blocks.push(block);
    open.push({ block, colons: openerColons(lines[i]) });
  }
  return blocks;
}

type Fence = { char: string; len: number } | null;

/** Follow fenced code: the fence open after `line`, and whether `line` is code or a fence line. */
function fenceStep(line: string, fence: Fence): { fence: Fence; code: boolean } {
  const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  if (!fence) return { fence: mark ? { char: mark[1][0], len: mark[1].length } : null, code: !!mark };
  const closes = !!mark && mark[1].startsWith(fence.char) && mark[1].length >= fence.len && !line.slice(mark[0].length).trim();
  return { fence: closes ? null : fence, code: true };
}

function openingOf(line: string, spec: SpecVersion): ContainerInfo | null {
  const open = CONTAINER_OPEN.exec(line);
  return open ? parseContainerInfo(open[3] + open[4], spec) : null;
}

/** Attributes as written plus the spec's defaults; the title is a field of its own. */
function containerAttrs(info: ContainerInfo): Record<string, string | string[]> {
  const attrs: Record<string, string | string[]> = { ...own(DEFAULTS, info.name), ...info.attrs.values };
  delete attrs.title;
  if (info.name === 'api') attrs.method = String(attrs.method).toUpperCase();
  if (info.attrs.id) attrs.id = info.attrs.id;
  if (info.attrs.classes.length) attrs.class = info.attrs.classes;
  return attrs;
}

/** Whether a block matches a selector, with its `:not(…)` and the selectors of its ancestors. */
function matches(selector: Selector, block: Block, parents: Map<Block, Block[]>, today: string): boolean {
  if (!selects(selector, block, today)) return false;
  if (selector.not?.some((n) => matches(n, block, parents, today))) return false;
  const up = selector.ancestor;
  if (!up) return true;
  const held = parents.get(block) ?? [];
  if (up.combinator === '>') return held.length > 0 && matches(up.selector, held[held.length - 1], parents, today);
  return held.some((a) => matches(up.selector, a, parents, today));
}

function selects(selector: Selector, block: Block, today: string): boolean {
  const type = selector.type;
  if (type !== '*' && type !== block.type && !(type === 'callout' && (CALLOUT_TYPES as readonly string[]).includes(block.type))) return false;
  return selector.tests.every((t) => passes(t, valueOf(block, t.key), today));
}

function valueOf(block: Block, key: string): string | string[] | undefined {
  if (key === 'title') return block.title;
  if (key === 'section') return block.section ?? undefined;
  if (key === 'type') return block.type;
  return block.attrs[key];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/^@/, '');

function passes(test: AttributeTest, actual: string | string[] | undefined, today: string): boolean {
  const list = [actual ?? []].flat();
  const any = (check: (a: string, v: string) => boolean) => list.some((a) => test.values.some((v) => check(norm(a), norm(v))));
  switch (test.op) {
    case 'exists': return list.some((a) => a.trim() !== '' && norm(a) !== 'false');
    case '=': return any((a, v) => a === v);
    case '!=': return !any((a, v) => a === v);
    case '*=': return any((a, v) => a.includes(v));
    case '^=': return any((a, v) => a.startsWith(v));
    case '$=': return any((a, v) => a.endsWith(v));
    default: {
      const want = rank(test.key, test.values[0], today);
      return want !== undefined && list.some((a) => {
        const have = rank(test.key, a, today);
        if (have === undefined) return false;
        switch (test.op) {
          case '<': return have < want;
          case '<=': return have <= want;
          case '>': return have > want;
          default: return have >= want;
        }
      });
    }
  }
}

/** A value's place in its order, for `<` and friends; undefined when it has none. */
function rank(key: string, value: string, today: string): number | undefined {
  const v = value.trim().toLowerCase();
  if (key === 'priority') return own(PRIORITY_RANK, v);
  if (key === 'impact' || key === 'likelihood') {
    const level = RISK_LEVELS.indexOf(v);
    return level < 0 ? undefined : level;
  }
  const date = v === 'today' ? today : v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const time = Date.parse(date);
    return Number.isNaN(time) ? undefined : time;
  }
  return /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : undefined;
}
