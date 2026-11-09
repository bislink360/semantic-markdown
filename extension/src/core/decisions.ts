import { asStringList, parseFrontMatter } from './frontmatter';
import { formatSmd } from './format';
import { normalizePath, resolvePath } from './graph';
import { splitIdRef } from './idTarget';
import { parseSmd } from './parse';
import { parseSelector, querySmd, type QueryMatch } from './query';
import type { Heading } from './render';
import { listed, supersededBy, tagBlocks } from './semanticTags';
import { DECISION_STATUS, SMD_VERSION } from './spec';
import { own } from './util';

/**
 * Decision log (`smd decisions`): every `:::decision` across documents, newest first, filtered by
 * status and owner, as rows for tools or as an ADR index document that can be committed.
 */

export interface DecisionLogOptions {
  /** Keep only these statuses (case-insensitive); `open` means `proposed`. */
  status?: string[];
  /** Keep only decisions with this owner (`@maya` or `maya`, case-insensitive). */
  owner?: string;
}

export interface DecisionEntry {
  title: string;
  /** Lower case; `proposed` when the decision has none, as the spec says. */
  status: string;
  date: string | null;
  owner: string | null;
  /** The document's path as given. */
  path: string;
  /** Zero-based lines of the opening and closing fence. */
  line: number;
  endLine: number;
  /** The nearest heading above the decision. */
  section: string | null;
  /** The decision's own `{#id}`, else its section's heading id; null above the first heading. */
  anchor: string | null;
  /** The document's front matter `title`, else its first `#` heading, else its file name. */
  document: string;
  /**
   * The document's own decision, as in an ADR: its first decision, when the document is tagged `adr`
   * or the decision comes before any `##` section.
   */
  adr: boolean;
  /**
   * The decisions whose `supersedes` names this one (semantic tags R53): ids of the same document in document order,
   * then `other.smd#D7` for a decision of another listed document that names it as `this.smd#D1` (R19), written
   * relative to this document. Only present when one does; undefined for a decision without an id.
   */
  supersededBy?: string[];
}

export interface DecisionLogMarkdownOptions {
  /** Front matter title (default `Decision log`). */
  title?: string;
  /** The link to a document from where the index will live (default: the path as given). */
  link?: (path: string) => string;
}

/** Status values `--status` accepts: the spec's statuses and `open` (= proposed). */
export const DECISION_STATUS_FILTERS: readonly string[] = [...DECISION_STATUS, 'open'];

const STATUS_ALIASES: Record<string, string> = { open: 'proposed' };
const INACTIVE = new Set(['rejected', 'superseded', 'deprecated']);
const BADGE_COLORS: Record<string, string> = {
  accepted: 'green', proposed: 'blue', rejected: 'red', superseded: 'gray', deprecated: 'orange',
};
const DECISIONS = parseSelector('decision');

/** Every decision in the documents that passes the filters: newest date first, undated last, then by path and line. */
export function decisionLog(documents: Array<{ path: string; text: string }>, options: DecisionLogOptions = {}): DecisionEntry[] {
  const statuses = options.status?.map((s) => own(STATUS_ALIASES, s.trim().toLowerCase()) ?? s.trim().toLowerCase());
  const owner = options.owner === undefined ? undefined : normOwner(options.owner);
  const across = successorsAcross(documents);
  return documents
    .flatMap((d) => documentDecisions(d.path, d.text, across))
    .filter((e) => (!statuses?.length || statuses.includes(e.status)) && (!owner || ownersOf(e).includes(owner)))
    .sort(compareDecisions);
}

/**
 * The decisions of other documents that supersede one, keyed by the superseded decision's file and id, each written
 * as the path from that file to the successor's, then `#id`.
 */
function successorsAcross(documents: ReadonlyArray<{ path: string; text: string }>): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const d of documents) {
    if (!/\bsupersedes\s*=/i.test(d.text)) continue;
    for (const b of tagBlocks(d.text)) {
      if (b.name !== 'decision' || !b.id) continue;
      for (const written of listed(b, 'supersedes')) {
        const { path, id } = splitIdRef(written);
        if (!path) continue;
        const target = resolvePath(d.path, path);
        if (target === normalizePath(d.path)) continue; // this document: the same-document map has it
        const key = `${target}\0${id}`;
        by.set(key, [...(by.get(key) ?? []), `${relativePath(target, normalizePath(d.path))}#${b.id}`]);
      }
    }
  }
  return by;
}

/** The path from the file `from` to the file `to`, both normalized: `docs/a.smd` → `docs/adr/b.smd` is `adr/b.smd`. */
function relativePath(from: string, to: string): string {
  const fromDirs = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let common = 0;
  while (common < fromDirs.length && common < toParts.length - 1 && fromDirs[common] === toParts[common]) common++;
  return [...fromDirs.slice(common).map(() => '..'), ...toParts.slice(common)].join('/');
}

/** The decisions of one document, in document order. */
function documentDecisions(path: string, text: string, across: ReadonlyMap<string, string[]> = new Map()): DecisionEntry[] {
  const data = parseFrontMatter(text).data;
  const headings = parseSmd(text).headings;
  const document = documentTitle(data, headings, path);
  const tagged = asStringList(data.tags).some((t) => t.toLowerCase() === 'adr');
  const own = /\bsupersedes\s*=/i.test(text) ? supersededBy(tagBlocks(text)) : undefined;
  const file = normalizePath(path);
  const successors = { get: (id: string) => [...(own?.get(id) ?? []), ...(across.get(`${file}\0${id}`) ?? [])] };
  return querySmd(text, DECISIONS, { lineRefs: false }).map((m, i) => {
    const heading = headingAbove(headings, m.line);
    const subject = i === 0 && (tagged || !heading || heading.level < 2);
    return entryOf(m, { path, document, heading, adr: subject, successors });
  });
}

interface EntryPlace { path: string; document: string; heading?: Heading; adr: boolean; successors?: { get(id: string): string[] | undefined } }

function entryOf(m: QueryMatch, at: EntryPlace): DecisionEntry {
  const id = first(m.attrs.id);
  const by = id ? at.successors?.get(id) : undefined;
  return {
    title: m.title,
    status: (first(m.attrs.status) ?? 'proposed').toLowerCase(),
    date: first(m.attrs.date) ?? null,
    owner: first(m.attrs.owner) ?? null,
    path: at.path,
    line: m.line,
    endLine: m.endLine,
    section: m.section,
    anchor: id ?? at.heading?.slug ?? null,
    document: at.document,
    adr: at.adr,
    ...(by?.length ? { supersededBy: by } : {}),
  };
}

export function headingAbove(headings: Heading[], line: number): Heading | undefined {
  let above: Heading | undefined;
  for (const h of headings) {
    if (h.line >= line) break;
    above = h;
  }
  return above;
}

/** The front matter `title`, else the first `#` heading, else the file name. */
export function documentTitle(data: Record<string, unknown>, headings: Heading[], path: string): string {
  return typeof data.title === 'string' && data.title.trim() ? data.title.trim() : firstTitle(headings, path);
}

function firstTitle(headings: Heading[], path: string): string {
  const h1 = headings.find((h) => h.level === 1);
  if (h1) return h1.text;
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.smd$/i, '');
}

function first(value: string | string[] | undefined): string | undefined {
  const v = [value ?? []].flat()[0]?.trim();
  return v || undefined;
}

const normOwner = (owner: string) => owner.trim().toLowerCase().replace(/^@/, '');

/** `@maya, @li` → `maya`, `li`. */
function ownersOf(e: DecisionEntry): string[] {
  return (e.owner ?? '').split(/[\s,]+/).filter(Boolean).map(normOwner);
}

/** Sort key of a date: YYYY-MM-DD dates sort, anything else counts as undated. */
function dateKey(date: string | null): string {
  return date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : '';
}

function compareDecisions(a: DecisionEntry, b: DecisionEntry): number {
  return compareText(dateKey(b.date), dateKey(a.date)) || compareText(a.path, b.path) || a.line - b.line;
}

/** Byte-order comparison, so the order doesn't depend on the locale. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Is the decision no longer in force (rejected, superseded or deprecated)? */
export function isInactiveDecision(status: string): boolean {
  return INACTIVE.has(status.toLowerCase());
}

/**
 * The decisions as an ADR index: a formatted .smd document with front matter and a table of date,
 * status badge, decision (linked to its section), owner and document. It passes `smd validate` and
 * `smd fmt --check` when the links resolve from where it is saved (see `link`).
 */
export function decisionLogMarkdown(entries: DecisionEntry[], options: DecisionLogMarkdownOptions = {}): string {
  const link = options.link ?? ((path: string) => path);
  const documents = new Set(entries.map((e) => e.path)).size;
  const summary = plural(entries.length, 'decision') + ' from ' + plural(documents, 'document') + ', newest first.';
  const lines = [
    '---',
    `smd: ${SMD_VERSION}`,
    `title: ${JSON.stringify(options.title?.trim() || 'Decision log')}`,
    `summary: ${JSON.stringify(summary)}`,
    'tags: [decisions]',
    '---',
    '',
    'Generated by `smd decisions`. Regenerate it instead of editing it by hand.',
    '',
    ...(entries.length ? decisionTable(entries, link) : ['No decisions found.']),
  ];
  return formatSmd(lines.join('\n') + '\n');
}

function decisionTable(entries: DecisionEntry[], link: (path: string) => string): string[] {
  return [
    '| Date | Status | Decision | Owner | Document |',
    '| --- | --- | --- | --- | --- |',
    ...entries.map((e) => tableRow(e, link(e.path))),
  ];
}

function tableRow(e: DecisionEntry, href: string): string {
  const target = decisionHref(e, href);
  const decision = `[${escapeInline(e.title)}](${linkTarget(target)})`;
  const cells = [
    e.date ? escapeInline(e.date) : '—',
    decisionBadge(e.status),
    (isInactiveDecision(e.status) ? `~~${decision}~~` : decision) + supersededNote(e),
    e.owner ? escapeInline(e.owner) : '—',
    `[${escapeInline(e.document)}](${linkTarget(href)})`,
  ];
  return `| ${cells.join(' | ')} |`;
}

/** ` (superseded by D7)` after a decision a later one supersedes (semantic tags R53), else nothing. */
function supersededNote(e: DecisionEntry): string {
  return e.supersededBy?.length ? ` (superseded by ${e.supersededBy.map(escapeInline).join(', ')})` : '';
}

/** The link to a decision: its section (or own id) in the document at `href`; the document itself for an ADR's own decision. */
export function decisionHref(e: DecisionEntry, href: string): string {
  return e.anchor && !e.adr ? `${href}#${e.anchor}` : href;
}

/** `:badge[accepted]{color=green}` */
export function decisionBadge(status: string): string {
  return `:badge[${escapeInline(status)}]{color=${own(BADGE_COLORS, status) ?? 'gray'}}`;
}

/** Plain text that stays plain inside a table cell or link text: Markdown, math and directive punctuation escaped. */
export function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]|<>$~]/g, (c) => `\\${c}`);
}

/** A link destination: in `<…>` when it has spaces or parentheses. */
export function linkTarget(target: string): string {
  return /[\s()<>]/.test(target) ? `<${target.replace(/[<>]/g, encodeURIComponent)}>` : target;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
