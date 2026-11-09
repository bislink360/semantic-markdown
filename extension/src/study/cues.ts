// What the study log records about a document's cues and edits: kinds, lines, ids and states, never text.
// No `vscode` import, so the unit tests can check it.
import { querySmd } from '../core';
import { studyBlockId, studyKind, studyStatus } from './schema';

/** The block types logged as cues: the attention and feedback cues of AF01 and the audience blocks of Study 2. */
const CUE_SELECTOR = 'question, danger, warning, note, info, tip, success, decision, risk, requirement, constraint, acceptance, evidence, agent, human, details, comment, suggestion, timeline, deprecated, task';

export interface StudyCue {
  kind: string;
  /** Zero-based first line. */
  line: number;
  block?: string;
  status?: string;
  state?: 'done' | 'undone';
}

/** The cues in a document, in order, as the log records them. */
export function studyCues(text: string): StudyCue[] {
  let matches;
  try {
    matches = querySmd(text, CUE_SELECTOR);
  } catch {
    return [];
  }
  return matches.map((m) => {
    const cue: StudyCue = { kind: studyKind(m.type) ?? 'other', line: m.line };
    const id = studyBlockId(m.attrs.id);
    if (id) cue.block = id;
    if (m.type === 'task') cue.state = m.attrs.done === 'true' ? 'done' : 'undone';
    else {
      const status = studyStatus(m.attrs.status);
      if (status) cue.status = status;
    }
    return cue;
  });
}

/** The block that starts on a line, as the log records it: for a comment or suggestion, `block` is its target (`for=`). */
export function studyBlockAt(text: string, line: number): { kind?: string; block?: string; status?: string; commentKind?: string } {
  let matches;
  try {
    matches = querySmd(text, CUE_SELECTOR);
  } catch {
    return {};
  }
  const m = matches.find((b) => b.line === line && b.type !== 'task');
  if (!m) return {};
  const review = m.type === 'comment' || m.type === 'suggestion';
  const kind = typeof m.attrs.kind === 'string' ? m.attrs.kind : undefined;
  return {
    kind: studyKind(m.type),
    block: studyBlockId(review ? m.attrs.for : m.attrs.id),
    status: studyStatus(m.attrs.status),
    commentKind: m.type === 'comment' && kind && ['remark', 'answer', 'correction'].includes(kind) ? kind : undefined,
  };
}

/** A template's name as a slug: `Agent block` is `agent-block`. */
export function templateSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41);
}

/** Counts by kind. */
export function cueCounts(cues: readonly StudyCue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of cues) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  return counts;
}

/** One text change as VS Code reports it, without its text: where, and how much. */
export interface StudyChange {
  startLine: number;
  endLine: number;
  /** Characters replaced. */
  rangeLength: number;
  /** Characters inserted (the length of the new text, not the text). */
  textLength: number;
}

/** Text edits to one document, gathered until a pause: the lines they touched and how much changed. */
export class EditBatch {
  line = Number.MAX_SAFE_INTEGER;
  lineEnd = 0;
  changes = 0;
  inserted = 0;
  deleted = 0;
  readonly first: number;
  last: number;

  constructor(now: number) {
    this.first = now;
    this.last = now;
  }

  add(changes: readonly StudyChange[], now: number): void {
    for (const c of changes) {
      this.line = Math.min(this.line, c.startLine);
      this.lineEnd = Math.max(this.lineEnd, c.endLine);
      this.changes++;
      this.inserted += c.textLength;
      this.deleted += c.rangeLength;
    }
    this.last = now;
  }

  /** The `edit` event's fields. */
  fields(): Record<string, number> {
    return {
      line: this.changes ? this.line : 0,
      lineEnd: this.lineEnd,
      changes: this.changes,
      inserted: this.inserted,
      deleted: this.deleted,
      durationMs: this.last - this.first,
    };
  }
}

/**
 * A cue event the study page script in the preview sent (`{ type: 'studyCue', event: 'visible' | 'toggle', … }`),
 * as an event type and fields. The page is not trusted to have checked anything: the logger's schema checks again.
 */
export function studyPageEvent(raw: unknown): { type: 'cue.visible' | 'cue.toggle'; fields: Record<string, unknown> } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'studyCue') return undefined;
  const base = { kind: studyKind(m.kind), line: m.line, block: studyBlockId(m.block) };
  if (m.event === 'visible') return { type: 'cue.visible', fields: { ...base, status: studyStatus(m.status), durationMs: m.durationMs } };
  if (m.event === 'toggle') return { type: 'cue.toggle', fields: { ...base, state: m.state } };
  return undefined;
}
