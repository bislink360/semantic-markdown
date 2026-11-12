import { DocumentGraph, type GraphNode } from './graph';
import { documentBlocks, type DocumentBlock } from './query';
import { blockRevision, revisionOfText } from './revision';

/**
 * Updates since a checkpoint (feedback loop RFC, "Updates since a checkpoint"; AF21, AF22, AC-E). Two versions of a
 * document are compared by block id, and only the feedback state is reported: questions, suggestions, comments and
 * tasks by their disposition, and requirements, constraints, acceptance criteria, decisions, assumptions and evidence
 * when their revision or status changed, or they were added or removed. Each change names the blocks that point at it
 * (`verifies`, `depends-on`, `applies-to`, `supports`, `contradicts`, `for`) as affected. Other changed lines are
 * counted, never replayed.
 *
 * Reading the updates records nothing. It is retrieval, not incorporation, implementation or verification (research
 * contract, "Every transition is an explicit, attributed action").
 */

export type FeedbackKind =
  | 'question' | 'suggestion' | 'comment' | 'task'
  | 'requirement' | 'constraint' | 'acceptance' | 'decision' | 'assumption' | 'evidence';

export type ChangeType =
  | 'added' | 'removed' | 'answered' | 'incorporated' | 'withdrawn' | 'reopened' | 'accepted' | 'rejected' | 'resolved'
  | 'checked' | 'changed' | 'status';

export interface AffectedBlock {
  type: string;
  id: string | null;
  title: string;
  /** One-based line in the version the change is read in (the new one, or the old one for a removal). */
  line: number;
  /** The edge that ties it to the change: written in it and pointing at the changed block, or `for` from a review block to its target. */
  edge: string;
}

export interface FeedbackChange {
  kind: FeedbackKind;
  change: ChangeType;
  /** The block's `{#id}`; null for a task or review block without one. */
  id: string | null;
  title: string;
  /** One-based lines in the new and the old version; null where the block is not. */
  line: number | null;
  oldLine: number | null;
  /** Status before and after (a question's as read: `answered` without an answer reads as open). */
  status?: { before: string | null; after: string | null };
  /** Block revisions before and after, for content blocks whose text changed. */
  revision?: { before: string | null; after: string | null };
  /** A review block's target, author, kind, and who recorded the transition and when. */
  for?: string;
  author?: string;
  commentKind?: string;
  by?: string;
  on?: string;
  /** How the two versions were matched: by id, or by text and attributes (lower confidence). */
  matchedBy: 'id' | 'text';
  affected: AffectedBlock[];
}

export interface FeedbackUpdates {
  changes: FeedbackChange[];
  /** Lines changed outside the blocks reported, counted and not listed. */
  otherChangedLines: number;
  /** Document revisions (first 12 hex digits of the SHA-256 of the text). */
  revision: { before: string; after: string };
}

export interface UpdatesOptions {
  /** The document's path, for edges (default `doc.smd`). */
  file?: string;
  today?: string;
}

const CONTENT_KINDS: readonly FeedbackKind[] = ['requirement', 'constraint', 'acceptance', 'decision', 'assumption', 'evidence'];
const AFFECTING: readonly string[] = ['verifies', 'depends-on', 'applies-to', 'supports', 'contradicts', 'for'];

interface Version {
  text: string;
  lines: string[];
  blocks: DocumentBlock[];
  graph: DocumentGraph;
  path: string;
}

const str = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : undefined);
const lower = (v: string | string[] | undefined): string | undefined => str(v)?.trim().toLowerCase() || undefined;
const idOf = (b: DocumentBlock) => str(b.attrs.id);

/** What changed in the feedback state between two versions of a document (see the module comment). */
export function feedbackUpdates(oldText: string, newText: string, options: UpdatesOptions = {}): FeedbackUpdates {
  const path = options.file ?? 'doc.smd';
  const version = (text: string): Version => ({
    text, lines: text.split(/\r?\n/), blocks: documentBlocks(text, options.today), graph: new DocumentGraph([{ path, text }], { today: options.today }), path,
  });
  const before = version(oldText);
  const after = version(newText);
  const changes: FeedbackChange[] = [];

  changes.push(...questionChanges(before, after));
  changes.push(...reviewChanges(before, after, 'suggestion'));
  changes.push(...reviewChanges(before, after, 'comment'));
  changes.push(...taskChanges(before, after));
  changes.push(...contentChanges(before, after));

  // Affected blocks, then document order (new version first, removals after).
  for (const c of changes) c.affected = affectedBy(c, c.line !== null ? after : before);
  changes.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || (a.oldLine ?? 0) - (b.oldLine ?? 0));

  return {
    changes,
    otherChangedLines: otherChangedLines(before, after, changes),
    revision: { before: revisionOfText(oldText), after: revisionOfText(newText) },
  };
}

interface Pair { old?: DocumentBlock; now?: DocumentBlock; matchedBy: 'id' | 'text' }

/**
 * Pairs of blocks of one type: by id where the block has one (an id given twice is left out, it names nothing), else
 * by `key` in order, so the n-th block with a key pairs with the n-th of the other version.
 */
function pairs(before: DocumentBlock[], after: DocumentBlock[], key: (b: DocumentBlock) => string | undefined): Pair[] {
  const out: Pair[] = [];
  const unique = (list: DocumentBlock[]) => {
    const count = new Map<string, number>();
    for (const b of list) { const id = idOf(b); if (id) count.set(id, (count.get(id) ?? 0) + 1); }
    return (b: DocumentBlock) => { const id = idOf(b); return id && count.get(id) === 1 ? id : undefined; };
  };
  const oldId = unique(before);
  const newId = unique(after);
  const oldById = new Map(before.filter(oldId).map((b) => [oldId(b)!, b]));
  for (const b of after) {
    const id = newId(b);
    if (!id) continue;
    const old = oldById.get(id);
    out.push({ old, now: b, matchedBy: 'id' });
  }
  for (const [id, old] of oldById) if (!after.some((b) => newId(b) === id)) out.push({ old, matchedBy: 'id' });
  // Without an id: by key, in order.
  const rest = (list: DocumentBlock[]) => list.filter((b) => !idOf(b));
  const waiting = new Map<string, DocumentBlock[]>();
  for (const b of rest(before)) {
    const k = key(b);
    if (k !== undefined) waiting.set(k, [...(waiting.get(k) ?? []), b]);
  }
  for (const b of rest(after)) {
    const k = key(b);
    if (k === undefined) continue;
    const old = waiting.get(k)?.shift();
    out.push({ old, now: b, matchedBy: 'text' });
  }
  for (const left of waiting.values()) for (const old of left) out.push({ old, matchedBy: 'text' });
  return out;
}

const lineOf = (b: DocumentBlock | undefined) => (b ? b.line + 1 : null);

function base(kind: FeedbackKind, p: Pair, change: ChangeType): FeedbackChange {
  const b = (p.now ?? p.old)!;
  return { kind, change, id: idOf(b) ?? null, title: b.title, line: lineOf(p.now), oldLine: lineOf(p.old), matchedBy: p.matchedBy, affected: [] };
}

// Questions, suggestions, comments, tasks

/** A question's status as read: `answered` or `incorporated` without an answer is still open (AF11). */
function questionStatus(q: DocumentBlock, v: Version): string {
  const written = lower(q.attrs.status) ?? 'open';
  if (written !== 'answered' && written !== 'incorporated') return written;
  const id = idOf(q);
  const answered = v.blocks.some((b) => b.type === 'comment' && lower(b.attrs.kind) === 'answer'
    && ((id && str(b.attrs.for)?.trim() === id) || (b.line > q.line && b.line <= q.endLine)));
  return answered ? written : 'open';
}

function questionChanges(before: Version, after: Version): FeedbackChange[] {
  const out: FeedbackChange[] = [];
  const of = (v: Version) => v.blocks.filter((b) => b.type === 'question' && idOf(b));
  for (const p of pairs(of(before), of(after), () => undefined)) {
    const was = p.old ? questionStatus(p.old, before) : null;
    const now = p.now ? questionStatus(p.now, after) : null;
    if (was === now) continue;
    let change: ChangeType = 'status';
    if (!p.old) change = 'added';
    else if (!p.now) change = 'removed';
    else if (now === 'open') change = 'reopened';
    else if (now === 'answered' || now === 'incorporated' || now === 'withdrawn') change = now;
    out.push({ ...base('question', p, change), status: { before: was, after: now }, ...attribution(p.now) });
  }
  return out;
}

const attribution = (b: DocumentBlock | undefined) => {
  const by = str(b?.attrs.by);
  const on = str(b?.attrs.on);
  return { ...(by ? { by } : {}), ...(on ? { on } : {}) };
};

/** A review block without an id: its target, author, date, kind and body, which a transition leaves as they were. */
function reviewKey(v: Version) {
  return (b: DocumentBlock) => {
    const body = v.lines.slice(b.line + 1, b.endLine).join('\n').trim();
    return [b.type, str(b.attrs.for), str(b.attrs.author), str(b.attrs.date), lower(b.attrs.kind), b.title, revisionOfText(body)].join('|');
  };
}

function reviewChanges(before: Version, after: Version, type: 'suggestion' | 'comment'): FeedbackChange[] {
  const out: FeedbackChange[] = [];
  const of = (v: Version) => v.blocks.filter((b) => b.type === type);
  const oldKey = reviewKey(before);
  const newKey = reviewKey(after);
  // Keys are made per version but agree for the same block, since only attributes the key leaves out change.
  const key = (b: DocumentBlock) => (before.blocks.includes(b) ? oldKey(b) : newKey(b));
  for (const p of pairs(of(before), of(after), key)) {
    const was = p.old ? lower(p.old.attrs.status) ?? 'open' : null;
    const now = p.now ? lower(p.now.attrs.status) ?? 'open' : null;
    if (p.old && p.now && was === now) continue;
    let change: ChangeType = 'status';
    if (!p.old) change = 'added';
    else if (!p.now) change = 'removed';
    else if (now === 'open') change = 'reopened';
    else if (['accepted', 'rejected', 'withdrawn', 'resolved'].includes(now!)) change = now as ChangeType;
    const b = (p.now ?? p.old)!;
    const target = str(b.attrs.for)?.trim();
    const author = str(b.attrs.author);
    const kind = type === 'comment' ? lower(b.attrs.kind) ?? 'remark' : undefined;
    out.push({
      ...base(type, p, change), status: { before: was, after: now },
      ...(target ? { for: target } : {}), ...(author ? { author } : {}), ...(kind ? { commentKind: kind } : {}), ...attribution(p.now),
    });
  }
  return out;
}

function taskChanges(before: Version, after: Version): FeedbackChange[] {
  const out: FeedbackChange[] = [];
  const of = (v: Version) => v.blocks.filter((b) => b.type === 'task');
  for (const p of pairs(of(before), of(after), (b) => b.title.trim().replace(/\s+/g, ' ').toLowerCase())) {
    const was = p.old ? p.old.attrs.done === 'true' : null;
    const now = p.now ? p.now.attrs.done === 'true' : null;
    if (p.old && p.now && was === now) continue;
    const change: ChangeType = !p.old ? 'added' : !p.now ? 'removed' : now ? 'checked' : 'reopened';
    const state = (done: boolean | null) => (done === null ? null : done ? 'done' : 'open');
    out.push({ ...base('task', p, change), status: { before: state(was), after: state(now) } });
  }
  return out;
}

// Requirements, constraints, acceptance criteria, decisions, assumptions, evidence

function contentChanges(before: Version, after: Version): FeedbackChange[] {
  const out: FeedbackChange[] = [];
  const of = (v: Version) => v.blocks.filter((b) => (CONTENT_KINDS as string[]).includes(b.type) && idOf(b));
  const revision = (v: Version, b: DocumentBlock | undefined) => {
    if (!b) return null;
    const r = blockRevision(v.text, idOf(b)!);
    return r.status === 'resolved' ? r.revision : null;
  };
  for (const p of pairs(of(before), of(after), () => undefined)) {
    const kind = (p.now ?? p.old)!.type as FeedbackKind;
    if (!p.old || !p.now) {
      out.push({ ...base(kind, p, p.old ? 'removed' : 'added'), status: { before: lower(p.old?.attrs.status) ?? null, after: lower(p.now?.attrs.status) ?? null } });
      continue;
    }
    const was = revision(before, p.old);
    const now = revision(after, p.now);
    if (was !== now) out.push({ ...base(kind, p, 'changed'), revision: { before: was, after: now } });
    const statusBefore = lower(p.old.attrs.status) ?? null;
    const statusAfter = lower(p.now.attrs.status) ?? null;
    if (statusBefore !== statusAfter) out.push({ ...base(kind, p, 'status'), status: { before: statusBefore, after: statusAfter }, ...attribution(p.now) });
  }
  return out;
}

// Affected blocks and other lines

/** The blocks that point at the changed block, and a review block's target. */
function affectedBy(c: FeedbackChange, v: Version): AffectedBlock[] {
  const line = c.line ?? c.oldLine;
  if (line === null) return [];
  const node = v.graph.nodeAt(v.path, line - 1);
  if (!node) return [];
  const out: AffectedBlock[] = [];
  const seen = new Set<string>();
  const add = (n: GraphNode | undefined, edge: string) => {
    if (!n || n.line === undefined || seen.has(`${n.line}|${edge}`) || n.line === node.line) return;
    seen.add(`${n.line}|${edge}`);
    out.push({ type: n.type, id: n.id ?? null, title: n.title, line: n.line + 1, edge });
  };
  if (c.kind === 'comment' || c.kind === 'suggestion') {
    for (const e of v.graph.outgoing(node)) if (e.type === 'for' && e.from.line === node.line) add(e.to, 'for');
  }
  if (c.id) for (const e of v.graph.incoming(node)) if (AFFECTING.includes(e.type)) add(e.from, e.type);
  return out.sort((a, b) => a.line - b.line);
}

/** Lines that aren't blank changed between the versions (a longest-common-subsequence diff), outside the blocks reported. */
function otherChangedLines(before: Version, after: Version, changes: readonly FeedbackChange[]): number {
  const { removed, added } = changedLines(before.lines, after.lines);
  const ranges = (v: Version, at: (c: FeedbackChange) => number | null) => changes.flatMap((c) => {
    const l = at(c);
    const b = l === null ? undefined : v.blocks.find((x) => x.line === l - 1);
    return b ? [[b.line, b.type === 'heading' ? b.line : b.endLine] as const] : [];
  });
  const oldRanges = ranges(before, (c) => c.oldLine);
  const newRanges = ranges(after, (c) => c.line);
  // Blank lines don't count.
  const outside = (v: Version, rs: ReadonlyArray<readonly [number, number]>) => (l: number) => !!v.lines[l].trim() && !rs.some(([a, b]) => l >= a && l <= b);
  return removed.filter(outside(before, oldRanges)).length + added.filter(outside(after, newRanges)).length;
}

/** Zero-based lines only in `a` (removed) and only in `b` (added). Large changes fall back to counting lines by text. */
function changedLines(a: string[], b: string[]): { removed: number[]; added: number[] } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start;
  const m = endB - start;
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);
  if (!n || !m) return { removed: range(start, endA), added: range(start, endB) };
  if (n * m > 4_000_000) {
    // By text: a line counts as changed when the other side has fewer copies of it.
    const count = new Map<string, number>();
    for (let i = start; i < endA; i++) count.set(a[i], (count.get(a[i]) ?? 0) + 1);
    const added: number[] = [];
    for (let j = start; j < endB; j++) {
      const c = count.get(b[j]) ?? 0;
      if (c) count.set(b[j], c - 1); else added.push(j);
    }
    const left = new Map(count);
    const removed: number[] = [];
    for (let i = endA - 1; i >= start; i--) {
      const c = left.get(a[i]) ?? 0;
      if (c) { left.set(a[i], c - 1); removed.push(i); }
    }
    return { removed: removed.reverse(), added };
  }
  // table[i][j]: the longest common subsequence of a[start+i…] and b[start+j…].
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const removed: number[] = [];
  const added: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) { i++; j++; } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) removed.push(start + i++); else added.push(start + j++);
  }
  while (i < n) removed.push(start + i++);
  while (j < m) added.push(start + j++);
  return { removed, added };
}

export interface UpdatesFormat {
  /** How the checkpoint was named, e.g. `abc1234` or `rev:3f2a9c1b0d4e`. */
  since: string;
  /** The next checkpoint: the current revision, and the commit whose version is the current text, when there is one. */
  next: { revision: string; commit?: string };
  file?: string;
}

/** The line that ends every report: retrieval is not incorporation. */
export const UPDATES_NOTE = 'Reading these updates records nothing: it is not incorporation, implementation or verification.';

/** The report as compact text for agents, one line per change. */
export function formatFeedbackUpdates(updates: FeedbackUpdates, format: UpdatesFormat): string {
  const out: string[] = [];
  const file = format.file ? ` in ${format.file}` : '';
  out.push(updates.changes.length
    ? `Feedback updates${file} since ${format.since} (rev:${updates.revision.before} → rev:${updates.revision.after}):`
    : `No feedback updates${file} since ${format.since}.`);
  for (const c of updates.changes) out.push(changeLine(c));
  if (updates.otherChangedLines) {
    const n = updates.otherChangedLines;
    out.push(`${n} other changed line${n === 1 ? '' : 's'}, not listed${format.file ? ` (smd diff ${format.file} --since <commit> shows them)` : ''}.`);
  }
  const commit = format.next.commit ? ` or --since ${format.next.commit}` : '';
  out.push(`Next checkpoint: --since rev:${format.next.revision}${commit}`);
  out.push(UPDATES_NOTE);
  return out.join('\n') + '\n';
}

function changeLine(c: FeedbackChange): string {
  const name = c.id ?? (c.kind === 'task' ? `"${c.title}"` : c.title ? `"${c.title}"` : '');
  const parts = [`- ${c.kind}${name ? ` ${name}` : ''}`];
  if (c.commentKind && c.commentKind !== 'remark') parts.push(`(${c.commentKind})`);
  if (c.for) parts.push(`for ${c.for}`);
  parts.push(c.change);
  if (c.status && c.change !== 'added' && c.change !== 'removed' && c.kind !== 'task') parts.push(`(${c.status.before ?? '—'} → ${c.status.after ?? '—'})`);
  if (c.change === 'added' && c.status?.after && c.status.after !== 'open') parts.push(`as ${c.status.after}`);
  if (c.revision) parts.push(`(rev ${c.revision.before ?? '—'} → ${c.revision.after ?? '—'})`);
  if (c.by) parts.push(`by ${c.by}`);
  if (c.on) parts.push(`on ${c.on}`);
  parts.push(c.line !== null ? `[L${c.line}]` : `[was L${c.oldLine}]`);
  if (c.matchedBy === 'text') parts.push('(matched by text)');
  let line = parts.join(' ');
  const named = (a: AffectedBlock) => (a.id ? ` ${a.id}` : a.title ? ` "${a.title}"` : '');
  if (c.affected.length) line += ` · affected: ${c.affected.map((a) => `${a.type}${named(a)} (${a.edge}) [L${a.line}]`).join(', ')}`;
  return line;
}
