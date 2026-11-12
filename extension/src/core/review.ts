import { removeContainerAttr, setContainerAttr } from './attrEdit';
import { CONTAINER_CLOSE, CONTAINER_OPEN } from './containers';
import { quote } from './format';
import { parseFrontMatter } from './frontmatter';
import { documentBlocks, type DocumentBlock } from './query';
import { blockRevision, REVIEW_CONTAINERS, type BlockRevision } from './revision';
import { CONTAINERS, idList } from './spec';
import { specVersion, type SpecVersion } from './specVersion';

/**
 * Review comments and suggestions (collaboration RFC phase 3, feedback loop RFC "Review comments and suggestions").
 * Reading them: reviewItems. Writing them: one pure function per transition, each returning the new text or why it
 * was refused. A write changes only the lines it must (an opening line's attributes, an inserted block, the body an
 * accepted suggestion replaces), keeps every line ending as it was, and never formats. Browser-safe.
 */

import { CLOSED_STATES, hasReviewBlocks, setReviewReader, type ReviewType } from './reviewKinds';

export { CLOSED_STATES, hasReviewBlocks, type ReviewType };

export interface ReviewItem {
  type: ReviewType;
  /** Zero-based opening line and last line (the closing fence, when it has one). */
  line: number;
  endLine: number;
  id?: string;
  title: string;
  /** Attributes as written plus the spec's defaults (kind=remark, status=open). */
  attrs: Record<string, string>;
  /** The target id, when `for` names exactly one. */
  for?: string;
  kind: string;
  status: string;
  /** Not resolved, accepted, rejected or withdrawn. */
  open: boolean;
  /** `kind=answer`: an answer to a question, not a review remark. */
  answer: boolean;
  /** What `for` names: one block, none, a missing or ambiguous id, or several ids. */
  target: 'resolved' | 'missing' | 'ambiguous' | 'none' | 'several';
  /** The target's revision now, when it resolves. */
  currentRev?: string;
  /** The target changed since `rev`. Null when that can't be told (no rev, or the target doesn't resolve). */
  stale: boolean | null;
  /** The nearest heading above. */
  section: string | null;
  /** The body as written, outer blank lines dropped, without review blocks nested in it. */
  body: string;
}



const isReview = (b: DocumentBlock) => REVIEW_CONTAINERS.includes(b.type);
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(' ') : v);

/** Every comment and suggestion of a document, in order. */
export function reviewItems(text: string): ReviewItem[] {
  if (!hasReviewBlocks(text)) return [];
  const blocks = documentBlocks(text);
  const lines = text.split(/\r?\n/);
  const revisions = new Map<string, BlockRevision>();
  const revisionOf = (id: string) => {
    let r = revisions.get(id);
    if (!r) revisions.set(id, (r = blockRevision(text, id)));
    return r;
  };
  const reviews = blocks.filter(isReview);
  return reviews.map((b) => itemOf(b, lines, reviews, revisionOf));
}

function itemOf(b: DocumentBlock, lines: string[], reviews: DocumentBlock[], revisionOf: (id: string) => BlockRevision): ReviewItem {
  const type = b.type as ReviewType;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.attrs)) attrs[k] = str(v) ?? '';
  const defaults = CONTAINERS[type].defaults ?? {};
  const status = (attrs.status ?? defaults.status ?? 'open').trim().toLowerCase();
  const kind = (attrs.kind ?? defaults.kind ?? 'remark').trim().toLowerCase();
  const ids = attrs.for ? idList(attrs.for) : [];
  const item: ReviewItem = {
    type, line: b.line, endLine: b.endLine, title: b.title, attrs, kind, status,
    open: !CLOSED_STATES[type].includes(status), answer: type === 'comment' && kind === 'answer',
    target: ids.length === 0 ? 'none' : ids.length > 1 ? 'several' : 'resolved', stale: null, section: b.section,
    body: bodyText(lines, b, reviews),
  };
  if (attrs.id) item.id = attrs.id;
  if (ids.length === 1) {
    item.for = ids[0];
    const now = revisionOf(ids[0]);
    if (now.status === 'resolved') {
      item.currentRev = now.revision;
      if (attrs.rev) item.stale = now.revision !== attrs.rev.trim().toLowerCase();
    } else {
      item.target = now.status;
    }
  }
  return item;
}

/** The lines of a container's body: after its opening line, up to its closing fence (or its last line when it has none). */
function bodyRange(lines: readonly string[], b: { line: number; endLine: number }): [number, number] {
  const closed = b.endLine > b.line && CONTAINER_CLOSE.test(lines[b.endLine] ?? '');
  return [b.line + 1, closed ? b.endLine - 1 : b.endLine];
}

function bodyText(lines: readonly string[], b: DocumentBlock, reviews: readonly DocumentBlock[]): string {
  const [from, to] = bodyRange(lines, b);
  const nested = reviews.filter((r) => r.line > b.line && r.line <= to);
  const own: string[] = [];
  for (let i = from; i <= to; i++) if (!nested.some((r) => i >= r.line && i <= r.endLine)) own.push(lines[i]);
  return trimBlank(own).join('\n');
}

function trimBlank(lines: readonly string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

export type ReviewResult =
  | { ok: true; text: string; /** Zero-based opening line of the item written or changed, in the new text. */ line: number; message: string }
  | { ok: false; error: string };

/** Who does a transition and when. */
export interface ReviewActor {
  /** `@name`; a leading `@` is added when missing. */
  by: string;
  /** YYYY-MM-DD; defaults to the current date. */
  today?: string;
}

export interface ReviewWrite extends ReviewActor {
  /** The body: the comment, the answer or the replacement text. */
  text: string;
  /** A title for the block, shown by tools that don't know it. */
  title?: string;
}

const refuse = (error: string): ReviewResult => ({ ok: false, error });
const dateOf = (actor: ReviewActor) => actor.today ?? new Date().toISOString().slice(0, 10);

/** `@maya` from `maya` or `@maya`; undefined when blank or not one word. */
export function normalizeActor(name: string | undefined): string | undefined {
  const v = name?.trim();
  if (!v || /\s/.test(v)) return undefined;
  return v.startsWith('@') ? v : `@${v}`;
}

/** The lines of a document with their own line endings, edited in place. */
class Rows {
  readonly rows: Array<{ text: string; eol: string }>;
  /** The ending new lines get: the document's first. */
  readonly eol: string;

  constructor(text: string) {
    const parts = text.split(/(\r\n|\n)/);
    this.rows = [];
    for (let i = 0; i < parts.length; i += 2) this.rows.push({ text: parts[i], eol: parts[i + 1] ?? '' });
    this.eol = /\r\n/.exec(text)?.[0] ?? '\n';
  }

  get length(): number {
    return this.rows.length;
  }

  text(i: number): string | undefined {
    return this.rows[i]?.text;
  }

  set(i: number, text: string): void {
    this.rows[i].text = text;
  }

  /** Replace rows [from, to] (inclusive; to = from - 1 inserts before `from`) with `texts` and the `kept` rows after them. */
  splice(from: number, to: number, texts: readonly string[], kept: ReadonlyArray<{ text: string; eol: string }> = []): void {
    const fresh = [...texts.map((t) => ({ text: t, eol: this.eol })), ...kept.map((r) => ({ ...r }))];
    const last = to >= from ? this.rows[to] : undefined;
    // Rows replaced up to the end keep the end as it was: no line ending after the last line when it had none.
    if (last && to === this.rows.length - 1 && fresh.length) fresh[fresh.length - 1].eol = last.eol;
    else if (last && to === this.rows.length - 1 && from > 0) this.rows[from - 1].eol = last.eol;
    if (!last && from >= this.rows.length && fresh.length) {
      const end = this.rows[this.rows.length - 1];
      if (end && end.eol === '') {
        end.eol = this.eol;
        fresh[fresh.length - 1].eol = '';
      }
    }
    this.rows.splice(from, Math.max(0, to - from + 1), ...fresh);
  }

  toString(): string {
    return this.rows.map((r) => r.text + r.eol).join('');
  }
}

interface Doc {
  text: string;
  lines: string[];
  spec: SpecVersion;
  blocks: DocumentBlock[];
  items: ReviewItem[];
}

function docOf(text: string): Doc {
  const lines = text.split(/\r?\n/);
  const spec = specVersion(parseFrontMatter(text).data);
  return { text, lines, spec, blocks: documentBlocks(text), items: reviewItems(text) };
}

/** A block named by `{#id}` or by the 1-based line of its opening, among `candidates`. */
function named<T extends { line: number; attrs: Record<string, unknown> }>(candidates: readonly T[], ref: string): T | undefined {
  const r = ref.trim();
  if (/^\d+$/.test(r)) return candidates.find((c) => c.line === Number(r) - 1);
  const id = r.replace(/^#/, '');
  return candidates.find((c) => c.attrs.id === id);
}

function findItem(doc: Doc, ref: string): ReviewItem | string {
  const item = named(doc.items, ref);
  if (item) return item;
  return /^\d+$/.test(ref.trim())
    ? `No comment or suggestion opens on line ${ref.trim()}.`
    : `No comment or suggestion with id "${ref.trim().replace(/^#/, '')}".`;
}

const where = (item: ReviewItem) => `${item.type === 'comment' ? (item.answer ? 'Answer' : 'Comment') : 'Suggestion'} on line ${item.line + 1}`;

/** Set (a value) or remove (undefined) attributes on an opening line; null when the line can't hold them. */
function editAttrs(line: string, values: ReadonlyArray<[string, string | undefined]>, spec: SpecVersion): string | null {
  let out: string | null = line;
  for (const [key, value] of values) {
    if (out === null) return null;
    out = value === undefined ? removeContainerAttr(out, key, spec) : setContainerAttr(out, key, value, spec);
  }
  return out;
}

/** Record a transition on an item's opening line. */
function transition(doc: Doc, item: { line: number }, values: ReadonlyArray<[string, string | undefined]>, message: string): ReviewResult {
  const rows = new Rows(doc.text);
  const next = editAttrs(rows.text(item.line)!, values, doc.spec);
  if (next === null) return refuse(`The attributes on line ${item.line + 1} can't be written: check its {…} list.`);
  rows.set(item.line, next);
  return { ok: true, text: rows.toString(), line: item.line, message };
}

function actorOf(actor: ReviewActor): string | ReviewResult {
  const by = normalizeActor(actor.by);
  return by ?? refuse('Say who does this: --by @name.');
}

// --- Where a new block goes, and what it looks like -------------------------

/** The target block: its lines and what kind it is. */
interface Target {
  id: string;
  revision: Extract<BlockRevision, { status: 'resolved' }>;
  block?: DocumentBlock;
}

function findTarget(doc: Doc, id: string): Target | string {
  const clean = id.trim().replace(/^#/, '');
  if (!clean) return 'Name the target block by its id.';
  const revision = blockRevision(doc.text, clean);
  if (revision.status === 'missing') return `No block with id "${clean}".`;
  if (revision.status === 'ambiguous') return `"${clean}" is the id of ${revision.lines.length} blocks (lines ${revision.lines.map((l) => l + 1).join(', ')}): give each its own id.`;
  const block = doc.blocks.find((b) => b.line === revision.line && b.type !== 'heading' && b.type !== 'task') ?? doc.blocks.find((b) => b.line === revision.line);
  if (block && REVIEW_CONTAINERS.includes(block.type)) return `"${clean}" is a ${block.type}: review the block it is for.`;
  return { id: clean, revision, block };
}

const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s/;
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;

/** The line a new block goes after: a container's last line, a heading's own section, the end of a task's list. */
function insertAfter(doc: Doc, target: Target): number {
  const { revision } = target;
  if (revision.kind === 'heading') {
    let end = revision.endLine;
    while (end > revision.line && !doc.lines[end]?.trim()) end--;
    return end;
  }
  if (revision.kind === 'task') {
    let end = revision.line;
    for (let i = revision.line + 1; i < doc.lines.length; i++) {
      const line = doc.lines[i];
      if (line.trim() && (LIST_LINE.test(line) || /^\s/.test(line))) { end = i; continue; }
      if (!line.trim() && i + 1 < doc.lines.length && (LIST_LINE.test(doc.lines[i + 1]) || /^\s+\S/.test(doc.lines[i + 1]))) continue;
      break;
    }
    return end;
  }
  return revision.endLine;
}

/** The indentation of a container target's opening line, so a block after it sits at the same level. */
function indentOf(doc: Doc, target: Target): string {
  if (target.revision.kind !== 'container') return '';
  return /^\s*/.exec(doc.lines[target.revision.line])![0];
}

/** Enough colons that no fence in the body closes the block. */
function fenceFor(body: readonly string[]): string {
  let most = 2;
  for (const line of body) {
    const m = /^\s*(:{3,})/.exec(line);
    if (m) most = Math.max(most, m[1].length);
  }
  return ':'.repeat(most + 1);
}

/** `:::name{attrs} Title`, the body and the closing fence, indented. */
function blockLines(name: ReviewType, attrs: ReadonlyArray<[string, string | undefined]>, title: string | undefined, body: string, indent: string, spec: SpecVersion): string[] {
  const order = CONTAINERS[name].attrs ?? [];
  const list = attrs.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${quote(k, v!, order, spec)}`).join(' ');
  const text = trimBlank(body.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+$/, '')));
  const fence = fenceFor(text);
  const head = title?.trim() ? ` ${title.trim().split(/\s*[\r\n]+\s*/).join(' ')}` : '';
  return [`${indent}${fence}${name}{${list}}${head}`, ...text.map((l) => (l ? indent + l : '')), `${indent}${fence}`];
}

/** Insert `block` after line `after`, with a blank line on each side where the neighbors aren't blank. */
function insertBlock(rows: Rows, after: number, block: string[]): number {
  const before = rows.text(after);
  const next = rows.text(after + 1);
  const atEnd = after + 1 >= rows.length || (after + 1 === rows.length - 1 && next === '' && rows.rows[after + 1].eol === '');
  const lead = before !== undefined && before.trim() ? [''] : [];
  const tail = !atEnd && next !== undefined && next.trim() ? [''] : [];
  rows.splice(after + 1, after, [...lead, ...block, ...tail]);
  return after + 1 + lead.length;
}

function addBlock(doc: Doc, name: ReviewType, target: Target, attrs: ReadonlyArray<[string, string | undefined]>, write: ReviewWrite, message: string): ReviewResult {
  if (!write.text.trim()) return refuse(`A ${name} needs text: --text "…".`);
  const rows = new Rows(doc.text);
  const block = blockLines(name, attrs, write.title, write.text, indentOf(doc, target), doc.spec);
  const line = insertBlock(rows, insertAfter(doc, target), block);
  return { ok: true, text: rows.toString(), line, message };
}

/** Add a comment after the block with id `targetId`, against its current revision. */
export function addComment(text: string, targetId: string, write: ReviewWrite & { kind?: string }): ReviewResult {
  const by = actorOf(write);
  if (typeof by !== 'string') return by;
  const doc = docOf(text);
  const target = findTarget(doc, targetId);
  if (typeof target === 'string') return refuse(target);
  const kind = write.kind && write.kind !== 'remark' ? write.kind : undefined;
  return addBlock(doc, 'comment', target, [
    ['for', target.id], ['author', by], ['date', dateOf(write)], ['rev', target.revision.revision], ['kind', kind],
  ], write, `Added a comment for ${target.id}.`);
}

/** Add a suggestion for the body of the block with id `targetId`, against its current revision. */
export function addSuggestion(text: string, targetId: string, write: ReviewWrite): ReviewResult {
  const by = actorOf(write);
  if (typeof by !== 'string') return by;
  const doc = docOf(text);
  const target = findTarget(doc, targetId);
  if (typeof target === 'string') return refuse(target);
  if (target.revision.kind === 'other') return refuse(`"${target.id}" is not a container, a task or a heading, so it has no body to replace.`);
  if (target.revision.kind === 'task' && trimBlank(write.text.split(/\r?\n/)).length > 1) return refuse('A task\'s text is one line: suggest one line.');
  return addBlock(doc, 'suggestion', target, [
    ['for', target.id], ['author', by], ['date', dateOf(write)], ['rev', target.revision.revision],
  ], write, `Added a suggestion for ${target.id}.`);
}

function findQuestion(doc: Doc, ref: string): DocumentBlock | string {
  const questions = doc.blocks.filter((b) => b.type === 'question');
  const found = named(questions, ref);
  if (found) return found;
  return `No question ${/^\d+$/.test(ref.trim()) ? `opens on line ${ref.trim()}` : `with id "${ref.trim().replace(/^#/, '')}"`}.`;
}

const questionStatus = (q: DocumentBlock) => String(str(q.attrs.status) ?? 'open').trim().toLowerCase();

/** Answer a question: a `kind=answer` comment after it, and the question's status set to `answered`. */
export function answerQuestion(text: string, questionRef: string, write: ReviewWrite): ReviewResult {
  const by = actorOf(write);
  if (typeof by !== 'string') return by;
  if (!write.text.trim()) return refuse('An answer needs text: --text "…".');
  const doc = docOf(text);
  const question = findQuestion(doc, questionRef);
  if (typeof question === 'string') return refuse(question);
  const status = questionStatus(question);
  if (status === 'withdrawn' || status === 'incorporated') return refuse(`The question on line ${question.line + 1} is ${status}: reopen it first.`);
  const id = str(question.attrs.id);
  if (!id) return refuse(`The question on line ${question.line + 1} has no {#id}, so an answer can't name it: give it one.`);
  const target = findTarget(doc, id);
  if (typeof target === 'string') return refuse(target);
  const rows = new Rows(doc.text);
  if (status !== 'answered') {
    const next = editAttrs(rows.text(question.line)!, [['status', 'answered'], ['by', by], ['on', dateOf(write)]], doc.spec);
    if (next === null) return refuse(`The attributes on line ${question.line + 1} can't be written: check its {…} list.`);
    rows.set(question.line, next);
  }
  const block = blockLines('comment', [
    ['for', id], ['author', by], ['date', dateOf(write)], ['rev', target.revision.revision], ['kind', 'answer'],
  ], write.title, write.text, indentOf(doc, target), doc.spec);
  const line = insertBlock(rows, insertAfter(doc, target), block);
  return { ok: true, text: rows.toString(), line, message: `Answered ${id}.` };
}

/** Set an answered question to `incorporated`: its answer is in the document now. */
export function incorporateQuestion(text: string, questionRef: string, actor: ReviewActor): ReviewResult {
  const by = actorOf(actor);
  if (typeof by !== 'string') return by;
  const doc = docOf(text);
  const question = findQuestion(doc, questionRef);
  if (typeof question === 'string') return refuse(question);
  const status = questionStatus(question);
  if (status !== 'answered') return refuse(`The question on line ${question.line + 1} is ${status}, not answered: answer it first.`);
  return transition(doc, question, [['status', 'incorporated'], ['by', by], ['on', dateOf(actor)]], `Incorporated the question on line ${question.line + 1}.`);
}

/** The lines of a target's body, as accept replaces them: [from, to] inclusive, maybe empty (to < from). */
function targetBody(doc: Doc, target: Target): [number, number] {
  const { revision } = target;
  if (revision.kind === 'heading') {
    let to = revision.endLine;
    // The empty line after a final line break is not a line of the body.
    if (to === doc.lines.length - 1 && doc.lines[to] === '') to--;
    return [revision.line + 1, to];
  }
  return bodyRange(doc.lines, { line: revision.line, endLine: revision.endLine });
}

const TASK_TEXT = /^(\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+)(.*?)(\s*\{#[^}\s]+\}\s*)?$/;

/** Accept an open suggestion: its body replaces the target's, and it records `accepted`. Refused when stale. */
export function acceptSuggestion(text: string, ref: string, actor: ReviewActor): ReviewResult {
  const by = actorOf(actor);
  if (typeof by !== 'string') return by;
  const doc = docOf(text);
  const item = findItem(doc, ref);
  if (typeof item === 'string') return refuse(item);
  if (item.type !== 'suggestion') return refuse(`${where(item)} is a comment: only a suggestion can be accepted.`);
  if (!item.open) return refuse(`${where(item)} is ${item.status}: reopen it first.`);
  const problem = targetProblem(item);
  if (problem) return refuse(problem);
  if (!item.attrs.rev) return refuse(`${where(item)} has no rev, so whether ${item.for} changed since can't be told: rebase it first.`);
  if (item.stale) return refuse(`${where(item)} is stale: ${item.for} changed since it was written (rev ${item.attrs.rev}, now ${item.currentRev}). Read ${item.for} and rebase the suggestion to accept it.`);
  const target = findTarget(doc, item.for!);
  if (typeof target === 'string') return refuse(target);

  const rows = new Rows(doc.text);
  const marked = editAttrs(rows.text(item.line)!, [['status', 'accepted'], ['by', by], ['on', dateOf(actor)], ['reason', undefined]], doc.spec);
  if (marked === null) return refuse(`The attributes on line ${item.line + 1} can't be written: check its {…} list.`);
  rows.set(item.line, marked);
  const body = item.body.split('\n');

  if (target.revision.kind === 'task') {
    const lines = trimBlank(body);
    if (lines.length !== 1) return refuse('A task\'s text is one line: the suggestion has more.');
    const m = TASK_TEXT.exec(rows.text(target.revision.line)!);
    if (!m) return refuse(`Line ${target.revision.line + 1} is not a task any more.`);
    rows.set(target.revision.line, `${m[1]}${lines[0].trim()}${m[3] ?? ''}`);
    return { ok: true, text: rows.toString(), line: item.line, message: `Accepted the suggestion for ${item.for}.` };
  }
  if (target.revision.kind === 'other') return refuse(`"${item.for}" has no body to replace.`);

  const [from, to] = targetBody(doc, target);
  // Review blocks in the body stay, byte for byte, after the new text.
  const nested = doc.items.filter((r) => r.line >= from && r.line <= to && !doc.items.some((o) => o !== r && r.line > o.line && r.line <= o.endLine));
  const indent = target.revision.kind === 'container' ? /^\s*/.exec(doc.lines[target.revision.line])![0] : '';
  const fresh = trimBlank(reindent(body, indent));
  const heading = target.revision.kind === 'heading';
  const texts = heading ? ['', ...fresh] : fresh;
  const kept: Array<{ text: string; eol: string }> = [];
  for (const r of nested) {
    kept.push({ text: '', eol: rows.eol });
    for (let i = r.line; i <= Math.min(r.endLine, to); i++) kept.push(rows.rows[i]);
  }
  // A heading's section ends with a blank line before the next heading.
  const nextLine = doc.lines[to + 1];
  if (heading && nextLine !== undefined && to + 1 < doc.lines.length && !(to + 1 === doc.lines.length - 1 && nextLine === '')) kept.push({ text: '', eol: rows.eol });
  if (to < from && !texts.length && !kept.length) return refuse('Nothing to replace.');
  if (kept.length) rows.splice(from, to, texts, kept);
  else rows.splice(from, to, texts);
  const moved = movedLine(item, from, to, texts.length, nested, kept);
  return { ok: true, text: rows.toString(), line: moved, message: `Accepted the suggestion for ${item.for}.` };
}

/** The suggestion's opening line after the target's body was replaced. */
function movedLine(item: ReviewItem, from: number, to: number, added: number, nested: readonly ReviewItem[], kept: readonly unknown[]): number {
  if (item.line < from) return item.line;
  const delta = from + added + kept.length - (to + 1);
  if (item.line > to) return item.line + delta;
  // Nested in the body: it was copied after the new text.
  let at = from + added;
  for (const r of nested) {
    at += 1;
    if (r.line === item.line) return at;
    at += r.endLine - r.line + 1;
  }
  return item.line;
}

/** Body lines with their common indentation replaced by `indent`. */
function reindent(lines: readonly string[], indent: string): string[] {
  const common = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  const cut = Number.isFinite(common) ? common : 0;
  return lines.map((l) => (l.trim() ? indent + l.slice(cut) : ''));
}

function targetProblem(item: ReviewItem): string | undefined {
  switch (item.target) {
    case 'none': return `${where(item)} has no for=…: say which block it is for.`;
    case 'several': return `${where(item)} names several blocks in for=…: it can only be applied to one.`;
    case 'missing': return `${where(item)} is for "${item.for}", which no block is.`;
    case 'ambiguous': return `${where(item)} is for "${item.for}", which is the id of more than one block: give each its own id.`;
    default: return undefined;
  }
}

/** Reject an open suggestion. */
export function rejectSuggestion(text: string, ref: string, actor: ReviewActor & { reason?: string }): ReviewResult {
  const by = actorOf(actor);
  if (typeof by !== 'string') return by;
  const doc = docOf(text);
  const item = findItem(doc, ref);
  if (typeof item === 'string') return refuse(item);
  if (item.type !== 'suggestion') return refuse(`${where(item)} is a comment: resolve it instead.`);
  if (!item.open) return refuse(`${where(item)} is ${item.status} already.`);
  const reason = actor.reason?.trim() || undefined;
  return transition(doc, item, [['status', 'rejected'], ['by', by], ['on', dateOf(actor)], ['reason', reason]], `Rejected the suggestion on line ${item.line + 1}.`);
}

/** Withdraw an open suggestion, or a question, with a reason. */
export function withdrawItem(text: string, ref: string, actor: ReviewActor & { reason: string }): ReviewResult {
  const by = actorOf(actor);
  if (typeof by !== 'string') return by;
  const reason = actor.reason?.trim();
  if (!reason) return refuse('Say why: --reason "…".');
  const doc = docOf(text);
  const item = named(doc.items, ref);
  if (item) {
    if (item.type !== 'suggestion') return refuse(`${where(item)} is a comment: resolve it instead.`);
    if (!item.open) return refuse(`${where(item)} is ${item.status} already.`);
    return transition(doc, item, [['status', 'withdrawn'], ['by', by], ['on', dateOf(actor)], ['reason', reason]], `Withdrew the suggestion on line ${item.line + 1}.`);
  }
  const question = findQuestion(doc, ref);
  if (typeof question === 'string') return refuse(`No suggestion or question ${/^\d+$/.test(ref.trim()) ? `opens on line ${ref.trim()}` : `with id "${ref.trim().replace(/^#/, '')}"`}.`);
  if (questionStatus(question) === 'withdrawn') return refuse(`The question on line ${question.line + 1} is withdrawn already.`);
  return transition(doc, question, [['status', 'withdrawn'], ['by', by], ['on', dateOf(actor)], ['reason', reason]], `Withdrew the question on line ${question.line + 1}.`);
}

/** Resolve an open comment. */
export function resolveComment(text: string, ref: string, actor: ReviewActor): ReviewResult {
  const by = actorOf(actor);
  if (typeof by !== 'string') return by;
  const doc = docOf(text);
  const item = findItem(doc, ref);
  if (typeof item === 'string') return refuse(item);
  if (item.type !== 'comment') return refuse(`${where(item)} is a suggestion: accept, reject or withdraw it.`);
  if (item.answer) return refuse(`${where(item)} answers a question: incorporate the question instead.`);
  if (!item.open) return refuse(`${where(item)} is resolved already.`);
  return transition(doc, item, [['status', 'resolved'], ['by', by], ['on', dateOf(actor)]], `Resolved the comment on line ${item.line + 1}.`);
}

/** Set a closed item, or a question that isn't open, back to open. */
export function reopenItem(text: string, ref: string, actor: ReviewActor): ReviewResult {
  const by = actorOf(actor);
  if (typeof by !== 'string') return by;
  const doc = docOf(text);
  const item = named(doc.items, ref);
  if (item) {
    if (item.open) return refuse(`${where(item)} is open already.`);
    return transition(doc, item, [['status', 'open'], ['by', by], ['on', dateOf(actor)], ['reason', undefined]], `Reopened the ${item.type} on line ${item.line + 1}.`);
  }
  const question = findQuestion(doc, ref);
  if (typeof question === 'string') return refuse(`No comment, suggestion or question ${/^\d+$/.test(ref.trim()) ? `opens on line ${ref.trim()}` : `with id "${ref.trim().replace(/^#/, '')}"`}.`);
  if (questionStatus(question) === 'open') return refuse(`The question on line ${question.line + 1} is open already.`);
  return transition(doc, question, [['status', 'open'], ['by', by], ['on', dateOf(actor)], ['reason', undefined]], `Reopened the question on line ${question.line + 1}.`);
}

/** Record the target's current revision on an open item, so a person re-accepts a stale one explicitly. */
export function rebaseItem(text: string, ref: string, actor: ReviewActor): ReviewResult {
  const by = actorOf(actor);
  if (typeof by !== 'string') return by;
  const doc = docOf(text);
  const item = findItem(doc, ref);
  if (typeof item === 'string') return refuse(item);
  if (!item.open) return refuse(`${where(item)} is ${item.status}: reopen it first.`);
  const problem = targetProblem(item);
  if (problem) return refuse(problem);
  return transition(doc, item, [['rev', item.currentRev!], ['by', by], ['on', dateOf(actor)]], `Rebased the ${item.type} on line ${item.line + 1} on ${item.for}@${item.currentRev}.`);
}

/** The text of an item's target now, for a person to read before rebasing. */
export function targetText(text: string, item: ReviewItem): string | undefined {
  if (!item.for) return undefined;
  const r = blockRevision(text, item.for);
  return r.status === 'resolved' ? r.text : undefined;
}

/** The transitions that take one item and an actor, by command name (the CLI and the Block Editor). */
export const REVIEW_TRANSITIONS = {
  accept: acceptSuggestion,
  reject: rejectSuggestion,
  resolve: resolveComment,
  reopen: reopenItem,
  rebase: rebaseItem,
  incorporate: incorporateQuestion,
} as const;

/**
 * The text without its review blocks, for outputs built from the source (a site's search index and dashboard). A
 * blank line stays where one is needed to keep the blocks around apart. A text without review blocks comes back as it is.
 */
export function withoutReviewBlocks(text: string): string {
  const items = reviewItems(text);
  if (!items.length) return text;
  const outer = items.filter((r) => !items.some((o) => o !== r && r.line > o.line && r.line <= o.endLine));
  const rows = new Rows(text);
  for (const r of [...outer].reverse()) {
    const before = rows.text(r.line - 1);
    const after = rows.text(r.endLine + 1);
    const apart = !!before?.trim() && !!after?.trim();
    rows.splice(r.line, r.endLine, apart ? [''] : []);
  }
  return rows.toString();
}

/** Whether a line opens a review block (outside code; the caller knows). */
export function isReviewOpening(line: string): boolean {
  const m = CONTAINER_OPEN.exec(line);
  return !!m && REVIEW_CONTAINERS.includes(m[3].toLowerCase());
}

setReviewReader(reviewItems);
