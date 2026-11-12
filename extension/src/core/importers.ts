import { isIsoDate } from './changelog';
import { quote } from './format';
import { markdownBodyForSmd, withoutHeadingAnchors } from './fromMarkdown';
import { parseFrontMatter } from './frontmatter';
import { parseSmd } from './parse';
import { CONTAINERS, SMD_VERSION } from './spec';
import { scanTasks } from './taskLines';

/**
 * Importers for `smd from-md --from <format>`: Markdown written by other tools, turned into a `.smd` document with
 * the blocks the spec already has. Each keeps every line of text it does not map (the prose, unknown keys, notes it
 * can't read), converts the prose as `smd from-md` does (markdownBodyForSmd), and returns warnings for what it kept
 * as text instead of mapping, so nothing is dropped silently.
 *
 * - `madr`: a MADR decision record (MADR 2's `* Status:` bullets, MADR 3 and 4's front matter). The decision becomes a
 *   `:::decision` block with its status, date and decision makers, around the text of "Decision Outcome".
 * - `spec-kit`: a GitHub Spec Kit `tasks.md`. Each `T001` task gets that id as `{#T001}`, and a `(depends on T001,
 *   T002)` note naming tasks of the file gets `:depends[T001,T002]`. The task text, `[P]` and story labels stay as written.
 */
export const IMPORT_FORMATS = ['madr', 'spec-kit'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export interface ImportOptions {
  /** `YYYY-MM-DD` for `updated:` when the source has no date (default: today). */
  today?: string;
}

export interface ImportResult {
  /** The `.smd` document (spec v2, `\n` line endings). */
  text: string;
  /** What was kept as text instead of mapped, one sentence each, for the person converting. */
  warnings: string[];
}

/** The `:::decision` statuses (SPEC §3.1), which MADR uses too. */
const DECISION_STATUSES = CONTAINERS.decision.values?.status ?? [];
/** The decision attributes in the order `smd fmt` writes them. */
const DECISION_ORDER = CONTAINERS.decision.attrs ?? [];
/** The document status that matches a MADR status: a settled record is approved, a replaced or refused one history. */
const DOCUMENT_STATUS: Record<string, string> = {
  proposed: 'review', accepted: 'approved', rejected: 'archived', deprecated: 'deprecated', superseded: 'deprecated',
};

// MADR

/** What a MADR status says: one of the decision statuses (with any text after it as a note), or text only. */
interface MadrStatus { status?: string; note?: string }

/**
 * A MADR status as written (`accepted`, `Accepted`, `superseded by [ADR-0005](0005-example.md)`). A known word keeps
 * any text after it as a note in the decision ("Superseded by [ADR-0005](…)"); an unknown one is kept whole as a note
 * and has no status.
 */
function madrStatus(raw: string): MadrStatus {
  const text = raw.trim();
  const lead = /^[a-z]+/i.exec(text)?.[0] ?? '';
  const rest = text.slice(lead.length);
  // The word must end there: `accepted2` or `accepted_x` is not the status `accepted`.
  const word = lead && !/^\w/.test(rest) ? lead.toLowerCase() : undefined;
  if (!word || !DECISION_STATUSES.includes(word)) return { note: `Status: ${text}` };
  return rest.trim() ? { status: word, note: text[0].toUpperCase() + text.slice(1) } : { status: word };
}

/** A list of people from a front matter value (`Alice, Bob` or a YAML list), as written. */
function people(value: unknown): string[] {
  const items = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : [];
  return items.map((s) => s.trim()).filter(Boolean);
}

/** A front matter value as text, when it is a scalar. */
function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : undefined;
}

/** The decision record's metadata, from the front matter or MADR 2's bullets. */
interface MadrMeta { status?: MadrStatus; statusText?: string; date?: string; deciders: string[] }

/** MADR 2's header bullets: `* Status: accepted`, `* Deciders: Alice, Bob`, `* Date: 2020-01-01`. */
const MADR2_BULLET = /^\s{0,3}[*+-]\s+(status|deciders|decision-makers|date)\s*:(.*)$/i;

/** A MADR 2 bullet's value, trimmed and without a trailing `<!-- … -->` comment. */
function bulletValue(raw: string): string {
  const value = raw.trim();
  const open = value.endsWith('-->') ? value.indexOf('<!--') : -1;
  return open >= 0 ? value.slice(0, open).trim() : value;
}

/**
 * Convert a MADR decision record (MADR 2, 3 or 4) to `.smd`. The record's H1 is the title of the document and of
 * its `:::decision` block. The block takes the status (`proposed` `accepted` `rejected` `deprecated` `superseded`,
 * any case), the date when it is `YYYY-MM-DD` and the decision makers as `owner`, and holds the text of the
 * "Decision Outcome" section (it goes first in the body when there is no such section). A status with more text,
 * such as `superseded by [ADR-0005](0005-example.md)`, keeps that text as the block's first line, since
 * `superseded-by` is computed from the successor's `supersedes=` and never written. An unknown status is kept as
 * written, the block gets none, and a warning says so. The front matter gets `smd: 2`, `title`, a document `status`
 * matching the decision's (`approved` for accepted, `review` for proposed, `deprecated` for deprecated and
 * superseded, `archived` for rejected, else `draft`), `owners`, `tags: [adr]` and `updated`; MADR's `consulted`,
 * `informed` and other keys stay as written.
 */
export function madrToSmd(md: string, fallbackTitle: string, options: ImportOptions = {}): ImportResult {
  const warnings: string[] = [];
  const source = sourceParts(md, warnings);
  const data = source.data;
  const consumed = new Set(['smd']);
  const meta: MadrMeta = { deciders: [] };
  // MADR 4 says decision-makers, MADR 3 deciders. A value that isn't a list of names (a template's `{…}`) stays as written.
  for (const key of ['decision-makers', 'deciders']) {
    const names = people(data[key]);
    if (names.length && !meta.deciders.length) meta.deciders = names;
    if (names.length || data[key] === null) consumed.add(key);
  }
  const statusText = scalar(data.status);
  if (statusText) {
    meta.status = madrStatus(statusText);
    meta.statusText = statusText;
  }
  // An empty key says nothing: it is replaced (status) or left out (date).
  if (statusText !== undefined || data.status === null) consumed.add('status');
  else if (data.status !== undefined) warnings.push('the status is not text (a template\'s {…}?): kept in the front matter as written, the decision has no status.');
  const date = scalar(data.date);
  if (date && isIsoDate(date)) meta.date = date;
  else if (data.date !== undefined && data.date !== null && date !== '') {
    warnings.push(`date ${JSON.stringify(date ?? data.date)} is not YYYY-MM-DD: kept in the front matter, the decision has no date.`);
  }
  if (meta.date || data.date === null || date === '') consumed.add('date');

  let lines = markdownBodyForSmd(source.body).split('\n');
  const h1 = takeTitle(lines);
  lines = h1.lines;
  const title = h1.title ?? fallbackTitle;
  lines = madr2Header(lines, meta, warnings);

  if (meta.statusText && !meta.status?.status) {
    warnings.push(`unknown MADR status "${meta.statusText}": kept as text in the decision, which has no status.`);
  }
  const attrs: Array<[string, string]> = [];
  if (meta.status?.status) attrs.push(['status', meta.status.status]);
  if (meta.date) attrs.push(['date', meta.date]);
  if (meta.deciders.length) attrs.push(['owner', meta.deciders.join(', ')]);
  // Text the status has beyond its word goes first in the decision (an unknown MADR 2 status stays its bullet).
  lines = withDecision(lines, title, attrs, meta.status?.note);

  const status = DOCUMENT_STATUS[meta.status?.status ?? ''] ?? 'draft';
  const head = [
    `smd: ${SMD_VERSION}`,
    ...(data.title === undefined ? [`title: ${JSON.stringify(title)}`] : []),
    ...(data.status === undefined || consumed.has('status') ? [`status: ${status}`] : []),
    ...(meta.deciders.length && data.owners === undefined ? [`owners: [${meta.deciders.map((d) => JSON.stringify(d)).join(', ')}]`] : []),
    ...(data.tags === undefined ? ['tags: [adr]'] : []),
    ...(data.updated === undefined ? [`updated: ${meta.date ?? options.today ?? today()}`] : []),
  ];
  return { text: document(head, keptFrontMatter(source.frontMatter, consumed), lines), warnings };
}

/**
 * MADR 2's header: the bullets right after the title that give the status, the deciders and the date. Each one
 * read is taken out of the text (an unknown status and a date that isn't `YYYY-MM-DD` stay as written); a value the
 * front matter already gave is left alone.
 */
function madr2Header(lines: string[], meta: MadrMeta, warnings: string[]): string[] {
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const drop = new Set<number>();
  for (let j = i; j < lines.length && MADR2_BULLET.test(lines[j]); j++) {
    const [, key, raw] = MADR2_BULLET.exec(lines[j]) ?? [];
    const name = key.toLowerCase();
    const value = bulletValue(raw ?? '');
    if (!value) continue;
    if (name === 'status' && !meta.statusText) {
      meta.statusText = value;
      meta.status = madrStatus(value);
      // An unknown status stays the bullet it was, so it reads as before.
      if (meta.status.status) drop.add(j);
      else meta.status.note = undefined;
    } else if (name === 'date' && !meta.date) {
      if (isIsoDate(value)) { meta.date = value; drop.add(j); }
      else warnings.push(`date "${value}" is not YYYY-MM-DD: kept as text, the decision has no date.`);
    } else if ((name === 'deciders' || name === 'decision-makers') && !meta.deciders.length) {
      meta.deciders = people(value);
      drop.add(j);
    }
  }
  if (!drop.size) return lines;
  const kept = lines.filter((_, j) => !drop.has(j));
  // No blank lines left at the top when the whole header was read.
  while (kept.length && !kept[0].trim()) kept.shift();
  return kept;
}

/**
 * The lines with the `:::decision` block: around the text of the "Decision Outcome" section (up to its first
 * subsection), or first in the body when there is no such section.
 */
function withDecision(lines: string[], title: string, attrs: Array<[string, string]>, note: string | undefined): string[] {
  const headings = bodyHeadings(lines);
  const at = headings.findIndex((h) => /^decision outcome$/i.test(h.text.trim()));
  const start = at >= 0 ? headings[at].line + 1 : 0;
  const end = at >= 0 ? headings[at + 1]?.line ?? lines.length : 0;
  const inner = lines.slice(start, end);
  while (inner.length && !inner[0].trim()) inner.shift();
  // A comment at the end belongs to the heading after it (MADR writes `<!-- This is an optional element. … -->` there).
  const after: string[] = [];
  while (inner.length && (!inner.at(-1)?.trim() || /^\s*<!--.*-->\s*$/.test(inner.at(-1) ?? ''))) {
    const line = inner.pop() ?? '';
    if (line.trim()) after.unshift(line);
  }
  const body = note ? [note, ...(inner.length ? [''] : []), ...inner] : inner;
  // One colon more than any fence inside, so the block's own fence closes it in every spec version.
  const colons = ':'.repeat(Math.max(3, ...body.map((l) => (/^\s*(:{3,})/.exec(l)?.[1].length ?? 0) + 1)));
  const list = attrs.map(([k, v]) => `${k}=${quote(k, v, DECISION_ORDER, 2)}`).join(' ');
  const block = [`${colons}decision${list ? `{${list}}` : ''} ${title}`, ...body, colons];
  if (at < 0) return [...block, ...(lines.length ? [''] : []), ...lines];
  const rest = [...after, ...lines.slice(end)];
  return [...lines.slice(0, start), '', ...block, ...(rest.length ? [''] : []), ...rest];
}

/**
 * The headings of body lines (no front matter), with zero-based lines. A blank line goes first for the parse, so a
 * body that starts with a `---` thematic break is never read as front matter.
 */
function bodyHeadings(lines: readonly string[]): Array<{ level: number; text: string; line: number }> {
  return parseSmd(['', ...lines].join('\n')).headings.map((h) => ({ level: h.level, text: h.text, line: h.line - 1 }));
}

// Spec Kit

/** A Spec Kit task id at the start of a task's text: `T001`. */
const SPEC_KIT_ID = /^(T\d+)\b/;
/** Where a "depends on" note can start. */
const DEPENDS_HEAD = /\bdepends\s+on\b/gi;

/**
 * "depends on T012, T013" in a task's text (also "depends on: …", "and", "&"): where the note starts, the ids it lists,
 * and the character right after the list ('' at the end of the line). A scanner rather than one regular expression, so
 * a long line costs linear time.
 */
export function dependsNote(text: string): { index: number; ids: string[]; next: string } | undefined {
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
  for (const head of text.matchAll(DEPENDS_HEAD)) {
    let i = head.index + head[0].length;
    const skip = () => { const from = i; while (isSpace(text[i])) i++; return i > from; };
    const spaced = skip();
    if (text[i] === ':') { i++; if (!skip()) continue; } else if (!spaced) continue;
    const id = () => { const m = /^T\d+/i.exec(text.slice(i, i + 32)); if (m) i += m[0].length; return m?.[0]; };
    const first = id();
    if (!first) continue;
    const ids = [first];
    for (;;) {
      const before = i;
      skip();
      let joined = false;
      if (text[i] === ',') {
        i++;
        skip();
        const and = /^and\s+/i.exec(text.slice(i, i + 16));
        if (and) i += and[0].length;
        joined = true;
      } else if (text[i] === '&') {
        i++;
        skip();
        joined = true;
      } else {
        const and = /^and\s+/i.exec(text.slice(i, i + 16));
        if (and) { i += and[0].length; joined = true; }
      }
      const next = joined ? id() : undefined;
      if (!next) { i = before; break; }
      ids.push(next);
    }
    const after = text[i];
    return { index: head.index, ids, next: after === undefined || after === '\n' || after === '\r' ? '' : after };
  }
  return undefined;
}

/**
 * Convert a GitHub Spec Kit `tasks.md` to `.smd`. Every line stays as written; each task whose text starts with an
 * id such as `T001` gets that id as a trailing `{#T001}` (the case kept, so the ids still match Spec Kit's), and a
 * note in its text that it "depends on" tasks of the file, a plain list of ids such as `(depends on T012, T013)`,
 * also gets `:depends[T012,T013]`. `[P]`, story labels such as `[US1]`, file paths and checked boxes stay as written.
 * A note that names an id no task has, a range or other words is left as text, with a warning; so is a repeated id.
 * The front matter gets `smd: 2`, the H1 as `title`, `status: draft` and `updated`, and keeps Spec Kit's keys.
 */
export function specKitTasksToSmd(md: string, fallbackTitle: string, options: ImportOptions = {}): ImportResult {
  const warnings: string[] = [];
  const source = sourceParts(md, warnings);
  const h1 = takeTitle(markdownBodyForSmd(source.body).split('\n'));
  const lines = h1.lines;
  const title = h1.title ?? fallbackTitle;

  // A blank line first, as in bodyHeadings, so a body that starts with `---` is never read as front matter.
  const tasks = scanTasks(['', ...lines].join('\n'), 1, 2).flatMap((t) => {
    const id = t.kind === 'task' && !t.id ? SPEC_KIT_ID.exec(t.body)?.[1] : undefined;
    return id && t.kind === 'task' ? [{ line: t.line - 1, id, text: t.body }] : [];
  });
  const first = new Map<string, number>();
  for (const t of tasks) {
    if (first.has(t.id)) warnings.push(`a second task ${t.id} ("${t.text}") gets no {#${t.id}}: an id names one task.`);
    else first.set(t.id, t.line);
  }
  for (const t of tasks) {
    if (first.get(t.id) !== t.line) continue;
    const depends = taskDepends(t.id, t.text, first, warnings);
    lines[t.line] = `${lines[t.line].trimEnd()}${depends ? ` :depends[${depends.join(',')}]` : ''} {#${t.id}}`;
  }

  const data = source.data;
  const head = [
    `smd: ${SMD_VERSION}`,
    ...(data.title === undefined ? [`title: ${JSON.stringify(title)}`] : []),
    ...(data.status === undefined ? ['status: draft'] : []),
    ...(data.updated === undefined ? [`updated: ${options.today ?? today()}`] : []),
  ];
  return { text: document(head, keptFrontMatter(source.frontMatter, new Set(['smd'])), lines), warnings };
}

/** The task ids a task's "depends on" note names, when it is a plain list of tasks of the file; else undefined. */
function taskDepends(id: string, text: string, tasks: ReadonlyMap<string, number>, warnings: string[]): string[] | undefined {
  const m = dependsNote(text);
  if (!m) return undefined;
  const ids = m.ids;
  // A list ends the note: a range (T012-T015) or more words after it leave what it means open.
  if (m.next && !/[).;]/.test(m.next)) {
    const note = text.slice(m.index).trim();
    warnings.push(`task ${id}: "${note.length > 60 ? `${note.slice(0, 59)}…` : note}" is not a plain list of task ids, kept as text.`);
    return undefined;
  }
  const unknown = ids.filter((d) => !tasks.has(d) || d === id);
  if (unknown.length) {
    warnings.push(`task ${id}: depends on ${unknown.join(', ')}, which no other task of the file is, kept as text.`);
    return undefined;
  }
  return [...new Set(ids)];
}

/** The source's front matter (raw lines and data) and its body, `\n` line endings. */
interface SourceParts { frontMatter: string[]; data: Record<string, unknown>; body: string }

/**
 * Split the source into front matter and body. Front matter that can't be read is kept in the body as a YAML code
 * block, with a warning, so its text survives and the new front matter stays valid.
 */
function sourceParts(md: string, warnings: string[]): SourceParts {
  const text = md.replace(/\r\n?/g, '\n');
  const fm = parseFrontMatter(text);
  if (!fm.present) return { frontMatter: [], data: {}, body: text };
  const lines = text.split('\n');
  if (fm.error || fm.bodyStartLine === 0) {
    warnings.push('the front matter could not be read: kept as a yaml code block at the top of the body.');
    const end = fm.bodyStartLine > 0 ? fm.bodyStartLine : lines.length;
    const raw = lines.slice(1, fm.bodyStartLine > 0 ? end - 1 : end);
    return { frontMatter: [], data: {}, body: ['```yaml', ...raw, '```', '', ...lines.slice(end)].join('\n') };
  }
  return { frontMatter: lines.slice(1, fm.bodyStartLine - 1), data: fm.data, body: lines.slice(fm.bodyStartLine).join('\n') };
}

/**
 * The first heading of the body when it is an H1 (ATX or setext), taken out as the title, with the blank lines
 * after it; the lines unchanged when the body starts otherwise.
 */
function takeTitle(lines: string[]): { title?: string; lines: string[] } {
  const first = bodyHeadings(lines)[0];
  if (first?.level !== 1) return { lines };
  const opener = /^\s{0,3}#\s+/.exec(lines[first.line]);
  const atx = opener ? [opener[0], lines[first.line].slice(opener[0].length)] : null;
  const setext = !atx && /^\s{0,3}=+\s*$/.test(lines[first.line + 1] ?? '');
  if (!atx && !setext) return { lines };
  const title = atx ? atxText(atx[1]) : lines[first.line].trim();
  const rest = [...lines.slice(0, first.line), ...lines.slice(first.line + (setext ? 2 : 1))];
  let i = first.line;
  while (i < rest.length && !rest[i].trim()) rest.splice(i, 1);
  // The blank lines above the title go too when nothing comes before it.
  if (rest.slice(0, first.line).every((l) => !l.trim())) rest.splice(0, first.line);
  return { title: title || undefined, lines: rest };
}

/** An ATX heading's text without its optional closing `#` sequence, which needs a space before it. */
function atxText(raw: string): string {
  const text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  return (end < text.length && end > 0 && /\s/.test(text[end - 1]) ? text.slice(0, end) : text).trim();
}

/** The source's front matter lines without the keys in `drop`, each with its nested lines. */
function keptFrontMatter(lines: readonly string[], drop: ReadonlySet<string>): string[] {
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const key = /^([^\s#:][^:]*):(?:\s|$)/.exec(line)?.[1]?.trimEnd();
    if (key !== undefined) skipping = drop.has(key.replace(/^["']|["']$/g, ''));
    // Indented lines and list items at the left edge (`key:` then `- a`) belong to the key above; a comment doesn't.
    else if (!/^\s|^-(?:\s|$)/.test(line) && line.trim()) skipping = false;
    if (!skipping) kept.push(line);
  }
  while (kept.length && !kept[0].trim()) kept.shift();
  while (kept.length && !kept.at(-1)?.trim()) kept.pop();
  return kept;
}

/** The document: the new front matter keys, then the source's other keys, then the body. */
function document(head: readonly string[], kept: readonly string[], body: string[]): string {
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1)?.trim()) body.pop();
  return withoutHeadingAnchors(['---', ...head, ...kept, '---', '', ...body, ''].join('\n'));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
