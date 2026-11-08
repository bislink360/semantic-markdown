import { documentBlocks, type DocumentBlock } from './query';
import { blockRevision, revisionList } from './revision';
import { idList } from './spec';

/**
 * Evidence records (research AF26 to AF28, feedback-loop RFC "Evidence"). A record supports or contradicts blocks by
 * id, within its own document. It is outdated for a block when the block's revision is no longer the one its `rev`
 * recorded. `method=acceptance` is a person accepting the result; every other method is verification. Nothing here
 * turns a checked task or an acceptance criterion into evidence.
 */

/** Whether a record still describes a block: `current`, `outdated` (the block changed), or `unchecked` (no `rev`, or the block can't be resolved). */
export type EvidenceFreshness = 'current' | 'outdated' | 'unchecked';

export interface EvidenceTarget {
  id: string;
  /** The revision the record names, lower case. */
  recorded?: string;
  /** The block's revision now, when it resolves to one block. */
  current?: string;
  freshness: EvidenceFreshness;
}

export interface EvidenceRecord {
  /** Zero-based first and last line of the `:::evidence` block. */
  line: number;
  endLine: number;
  id?: string;
  title: string;
  /** Lower case, as written; undefined when not written. */
  method?: string;
  result?: string;
  by?: string;
  date?: string;
  commit?: string;
  supports: EvidenceTarget[];
  contradicts: EvidenceTarget[];
}

const lower = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined);
const written = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Every `:::evidence` block of a document, with each target's freshness. `blocks` saves a second scan. */
export function evidenceRecords(text: string, blocks: readonly DocumentBlock[] = documentBlocks(text)): EvidenceRecord[] {
  const revisions = new Map<string, string | undefined>();
  const revisionOf = (id: string) => {
    if (!revisions.has(id)) {
      const r = blockRevision(text, id);
      revisions.set(id, r.status === 'resolved' ? r.revision : undefined);
    }
    return revisions.get(id);
  };
  return blocks.filter((b) => b.type === 'evidence').map((b) => {
    const supports = idList(written(b.attrs.supports) ?? '');
    const contradicts = idList(written(b.attrs.contradicts) ?? '');
    const recorded = revisionList(written(b.attrs.rev), [...supports, ...contradicts]);
    const target = (id: string): EvidenceTarget => {
      const was = recorded.get(id);
      const now = was === undefined ? undefined : revisionOf(id);
      const freshness: EvidenceFreshness = was === undefined || now === undefined ? 'unchecked' : now === was ? 'current' : 'outdated';
      return { id, ...(was === undefined ? {} : { recorded: was }), ...(now === undefined ? {} : { current: now }), freshness };
    };
    const id = written(b.attrs.id);
    const fields = { method: lower(b.attrs.method), result: lower(b.attrs.result), by: written(b.attrs.by), date: written(b.attrs.date), commit: written(b.attrs.commit) };
    return {
      line: b.line, endLine: b.endLine, ...(id ? { id } : {}), title: b.title,
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
      supports: supports.map(target), contradicts: contradicts.map(target),
    };
  });
}

/** Whether a record is a person's acceptance rather than verification. */
export const isAcceptance = (r: EvidenceRecord): boolean => r.method === 'acceptance';

/** The record's target `id` among what it supports, if it supports it. */
export const supportFor = (r: EvidenceRecord, id: string): EvidenceTarget | undefined => r.supports.find((t) => t.id === id);

/** Current passing verification of `id`: a non-acceptance record that supports it with result=pass and is not outdated. */
export function verifies(r: EvidenceRecord, id: string): boolean {
  const t = supportFor(r, id);
  return !!t && !isAcceptance(r) && r.result === 'pass' && t.freshness !== 'outdated';
}

/** A person's current acceptance of `id`: method=acceptance, result=pass, supporting it and not outdated. */
export function accepts(r: EvidenceRecord, id: string): boolean {
  const t = supportFor(r, id);
  return !!t && isAcceptance(r) && r.result === 'pass' && t.freshness !== 'outdated';
}

/** How a record names itself in messages: its id, else its line. */
export const recordName = (r: EvidenceRecord): string => r.id ?? `the evidence on line ${r.line + 1}`;
