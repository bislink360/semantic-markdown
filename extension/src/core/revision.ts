import { CONTAINER_OPEN, parseContainerInfo } from './containers';
import { idOwners, parseSmd } from './parse';
import { documentBlocks } from './query';
import { REVIEW_CONTAINERS } from './reviewKinds';
import { sha256Hex } from './sha256';

/**
 * Block revisions (research contract, "Stale targets need a renewed decision"). A response to a block (a comment, a
 * suggestion, an answer, an evidence record) stores the revision of the block it was written against. When the
 * block's text changes, the revision changes, and tools show the response as stale instead of applying it.
 *
 * The revision is the first 12 hex digits of the SHA-256 of the block's text, the way C08 computes a document's
 * revision. The text is what a person would call the block's content, so a lifecycle change does not make every
 * response to the block stale:
 *
 * - A container: its title and body. Its attributes (status, owner, by, on…) are not part of it, and neither are the
 *   `:::comment`, `:::suggestion` and `:::evidence` blocks nested in it, so recording a response or a check never
 *   makes the earlier ones stale.
 * - A task: its text, without the list marker, the checkbox and the trailing `{#id}`. Ticking or unticking a task
 *   leaves its revision as it was.
 * - A heading: its text and its own section body, up to the next heading at any level, without review blocks.
 *
 * Lines are compared with trailing white space removed and leading and trailing blank lines dropped, and CRLF reads
 * as LF. A revision identifies content, never who wrote it (research contract, "Document status is not authority").
 */

export type BlockRevision =
  | {
    status: 'resolved';
    revision: string;
    /** Zero-based first and last line of the block's source (a heading's last line is the end of its own body). */
    line: number;
    endLine: number;
    kind: 'container' | 'task' | 'heading' | 'other';
    text: string;
  }
  | { status: 'ambiguous'; lines: number[] }
  | { status: 'missing' };

/** Containers that are responses, not content: left out of the text of the block they sit in. */
export { REVIEW_CONTAINERS } from './reviewKinds';

/** Containers left out of the text of the block they sit in: responses and the evidence recorded about it. */
const RESPONSE_CONTAINERS: readonly string[] = [...REVIEW_CONTAINERS, 'evidence'];

const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+(.*)$/;
const TRAILING_ID = /\s*\{#[^}\s]+\}\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/** The revision of a text: the first 12 hex digits of its SHA-256 (as `revisionOf` for documents). */
export function revisionOfText(text: string): string {
  return sha256Hex(text).slice(0, 12);
}

/** Normalize a block's lines for hashing: trailing white space off, outer blank lines dropped. */
function normalized(lines: readonly string[]): string {
  const trimmed = lines.map((l) => l.replace(/\s+$/, ''));
  let a = 0;
  let b = trimmed.length;
  while (a < b && !trimmed[a]) a++;
  while (b > a && !trimmed[b - 1]) b--;
  return trimmed.slice(a, b).join('\n');
}

/** The current revision of the block with `id`, or why there is none (ambiguous ids resolve to nothing, R17). */
export function blockRevision(text: string, id: string): BlockRevision {
  const owners = idOwners(text).get(id);
  if (owners && owners.length > 1) return { status: 'ambiguous', lines: owners.map((o) => o.line) };
  if (!owners?.length) return { status: 'missing' };
  const owner = owners[0];
  const lines = text.split(/\r?\n/);
  const blocks = documentBlocks(text);
  const reviewRanges = blocks.filter((b) => RESPONSE_CONTAINERS.includes(b.type)).map((b) => [b.line, b.endLine] as const);
  const keep = (i: number) => !reviewRanges.some(([a, b]) => i >= a && i <= b);
  const own = (from: number, to: number) => {
    const out: string[] = [];
    for (let i = from; i <= to && i < lines.length; i++) if (keep(i)) out.push(lines[i]);
    return out;
  };

  if (owner.heading) {
    const headings = parseSmd(text).headings;
    const at = headings.findIndex((h) => h.line === owner.line);
    const next = at >= 0 ? headings[at + 1] : undefined;
    const end = (next?.line ?? lines.length) - 1;
    const title = (HEADING.exec(lines[owner.line])?.[1] ?? lines[owner.line]).replace(TRAILING_ID, '');
    const body = normalized(own(owner.line + 1, end));
    return done(`${title}\n${body}`, owner.line, end, 'heading');
  }

  const container = blocks.find((b) => b.line === owner.line && b.type !== 'task' && b.type !== 'heading');
  if (container && CONTAINER_OPEN.test(lines[owner.line])) {
    const open = CONTAINER_OPEN.exec(lines[owner.line]);
    const info = open ? parseContainerInfo(open[3] + open[4], parseSmd(text).spec) : null;
    const closed = container.endLine > container.line && /^\s{0,3}:{3,}\s*$/.test(lines[container.endLine]);
    const bodyEnd = closed ? container.endLine - 1 : container.endLine;
    const body = normalized(own(owner.line + 1, bodyEnd));
    return done(`${info?.title ?? ''}\n${body}`, owner.line, container.endLine, 'container');
  }

  const task = TASK.exec(lines[owner.line]);
  if (task) return done(task[1].replace(TRAILING_ID, ''), owner.line, owner.line, 'task');
  return done(normalized([lines[owner.line]]), owner.line, owner.line, 'other');
}

function done(content: string, line: number, endLine: number, kind: 'container' | 'task' | 'heading' | 'other'): BlockRevision {
  return { status: 'resolved', revision: revisionOfText(content), line, endLine, kind, text: content };
}

/**
 * Whether a response written against `recorded` is stale for the block `id` now: true when the block's revision
 * differs, null when the block can't be resolved (missing or ambiguous, which is reported on its own) or no revision
 * was recorded.
 */
export function isStale(text: string, id: string, recorded: string | undefined): boolean | null {
  if (!recorded) return null;
  const now = blockRevision(text, id);
  if (now.status !== 'resolved') return null;
  return now.revision !== recorded.trim().toLowerCase();
}

/**
 * Parse an evidence record's `rev=` value: `R1@3f2a9c1b0d4e,R2@99ab…` gives each supported id its recorded revision.
 * A bare hash applies to every id the record names, which is only unambiguous when it names one.
 */
export function revisionList(value: string | undefined, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!value) return out;
  for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const at = part.lastIndexOf('@');
    if (at > 0) out.set(part.slice(0, at), part.slice(at + 1).toLowerCase());
    else for (const id of ids) out.set(id, part.toLowerCase());
  }
  return out;
}
