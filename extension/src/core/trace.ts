import { accepts, evidenceRecords, isAcceptance, supportFor, type EvidenceFreshness, type EvidenceRecord } from './evidence';
import { DocumentGraph, nodeKey, type GraphDocument } from './graph';
import { documentBlocks, type DocumentBlock } from './query';

/**
 * Requirement tracing (research AF26, feedback-loop RFC "Tracing requirements"). Each requirement gets five separate
 * columns, and nothing in one is inferred from another: its status as written, its coverage (acceptance criteria that
 * verify it), its claims (tasks in it or that depend on it), its evidence (verification records that support it) and
 * its human acceptance. A checked task is never evidence, and an acceptance criterion is never evidence. Ids resolve
 * within each document: evidence in another document can't support a requirement yet (R19).
 */

export interface TraceCriterion {
  title: string;
  line: number;
  id?: string;
  /** Nested in the requirement, or standing alone with `verifies=`. */
  how: 'nested' | 'verifies';
}

export interface TraceTask {
  text: string;
  line: number;
  id?: string;
  done: boolean;
  /** Inside the requirement block, or naming it in `:depends[…]`. */
  how: 'inside' | 'depends';
}

export interface TraceRecord {
  title: string;
  line: number;
  id?: string;
  method?: string;
  result?: string;
  by?: string;
  date?: string;
  freshness: EvidenceFreshness;
}

export interface TraceRequirement {
  file: string;
  /** Zero-based line of the opening fence. */
  line: number;
  id?: string;
  title: string;
  /** As written; `proposed` when not written. */
  status: string;
  /** Says `verified` with no current passing evidence: reported as written, and flagged. */
  unsupportedVerified: boolean;
  coverage: TraceCriterion[];
  /** Implementation claims, not verification. */
  claims: { checked: number; total: number; tasks: TraceTask[] };
  /** Verification records (every method but acceptance) that support it. */
  evidence: {
    passing: number; failing: number; inconclusive: number; outdated: number;
    /** Records with no `result`. */
    unrecorded: number;
    total: number;
    methods: string[];
    records: TraceRecord[];
  };
  /** Records with `method=acceptance` that support it: accepted when one passes and is current. */
  acceptance: { accepted: boolean; by: string[]; records: TraceRecord[] };
}

export interface TraceSummary {
  /** How many documents were read. */
  documents: number;
  requirements: number;
  covered: number;
  withPassingEvidence: number;
  accepted: number;
  unsupportedVerified: number;
}

export interface TraceResult {
  requirements: TraceRequirement[];
  summary: TraceSummary;
}

export interface TraceOptions {
  /** Only requirements no acceptance criterion covers. The summary still counts every requirement. */
  uncovered?: boolean;
  today?: string;
}

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
const within = (outer: DocumentBlock, line: number) => line > outer.line && line <= outer.endLine;

function traceRecord(r: EvidenceRecord, id: string): TraceRecord {
  const freshness = supportFor(r, id)?.freshness ?? 'unchecked';
  const out: TraceRecord = { title: r.title, line: r.line, freshness };
  for (const key of ['id', 'method', 'result', 'by', 'date'] as const) if (r[key] !== undefined) out[key] = r[key];
  return out;
}

/** The requirements of `documents`, each with its five columns, and the counts over all of them. */
export function traceRequirements(documents: readonly GraphDocument[], options: TraceOptions = {}): TraceResult {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const graph = new DocumentGraph(documents, { today });
  const all: TraceRequirement[] = [];
  for (const path of graph.paths) {
    const doc = graph.document(path);
    if (!('text' in doc)) continue;
    const blocks = documentBlocks(doc.text, today);
    const records = evidenceRecords(doc.text, blocks);
    const edges = graph.edgesOf(path).filter((e) => e.status === 'resolved' && e.to);
    for (const req of blocks.filter((b) => b.type === 'requirement')) {
      const id = str(req.attrs.id);
      const key = `${path}:${req.line}`;
      const pointing = (type: string) => edges.filter((e) => e.type === type && nodeKey(e.to!) === key);

      const coverage: TraceCriterion[] = [];
      const seen = new Set<number>();
      const criterion = (b: DocumentBlock | undefined, how: TraceCriterion['how']) => {
        if (!b || seen.has(b.line)) return;
        seen.add(b.line);
        const cid = str(b.attrs.id);
        coverage.push({ title: b.title, line: b.line, ...(cid ? { id: cid } : {}), how });
      };
      for (const b of blocks) if (b.type === 'acceptance' && within(req, b.line)) criterion(b, 'nested');
      for (const e of pointing('verifies')) criterion(blocks.find((b) => b.line === e.from.line && b.type === 'acceptance'), 'verifies');
      coverage.sort((a, b) => a.line - b.line);

      const tasks: TraceTask[] = [];
      const task = (b: DocumentBlock | undefined, how: TraceTask['how']) => {
        if (!b || tasks.some((t) => t.line === b.line)) return;
        const tid = str(b.attrs.id);
        tasks.push({ text: b.title, line: b.line, ...(tid ? { id: tid } : {}), done: b.attrs.done === 'true', how });
      };
      for (const b of blocks) if (b.type === 'task' && within(req, b.line)) task(b, 'inside');
      for (const e of pointing('depends-on')) if (e.from.type === 'task') task(blocks.find((b) => b.line === e.from.line && b.type === 'task'), 'depends');
      tasks.sort((a, b) => a.line - b.line);

      // Records name requirements by id (resolved as the graph resolves it), so one without an id has none.
      const supporting = pointing('supports');
      const mine = id ? records.filter((r) => supporting.some((e) => e.from.line === r.line)) : [];
      const verification = mine.filter((r) => !isAcceptance(r)).map((r) => traceRecord(r, id!));
      const acceptance = mine.filter(isAcceptance).map((r) => traceRecord(r, id!));
      const current = verification.filter((r) => r.freshness !== 'outdated');
      const passing = current.filter((r) => r.result === 'pass').length;
      const status = (str(req.attrs.status) ?? 'proposed').trim();
      all.push({
        file: path, line: req.line, ...(id ? { id } : {}), title: req.title || firstLine(doc.lines, req), status,
        unsupportedVerified: status.toLowerCase() === 'verified' && !passing,
        coverage,
        claims: { checked: tasks.filter((t) => t.done).length, total: tasks.length, tasks },
        evidence: {
          passing,
          failing: current.filter((r) => r.result === 'fail').length,
          inconclusive: current.filter((r) => r.result === 'inconclusive').length,
          outdated: verification.length - current.length,
          unrecorded: current.filter((r) => !r.result).length,
          total: verification.length,
          methods: [...new Set(verification.map((r) => r.method ?? 'unstated'))],
          records: verification,
        },
        acceptance: {
          accepted: !!id && mine.some((r) => accepts(r, id)),
          by: [...new Set(mine.filter((r) => accepts(r, id!)).map((r) => r.by ?? 'someone unnamed'))],
          records: acceptance,
        },
      });
    }
  }
  const summary: TraceSummary = {
    documents: graph.paths.length,
    requirements: all.length,
    covered: all.filter((r) => r.coverage.length).length,
    withPassingEvidence: all.filter((r) => r.evidence.passing).length,
    accepted: all.filter((r) => r.acceptance.accepted).length,
    unsupportedVerified: all.filter((r) => r.unsupportedVerified).length,
  };
  return { requirements: options.uncovered ? all.filter((r) => !r.coverage.length) : all, summary };
}

/** A block without a title by its first line of text, cut to 80 characters. */
function firstLine(lines: readonly string[], b: DocumentBlock): string {
  const text = lines.slice(b.line + 1, b.endLine).map((l) => l.trim()).find((l) => l && !l.startsWith(':::')) ?? '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const name = (x: { id?: string; line: number }) => x.id ?? `L${x.line + 1}`;

function coverageText(r: TraceRequirement): string {
  if (!r.coverage.length) return `none: no acceptance criterion verifies ${r.id ?? 'this requirement'}`;
  return `${plural(r.coverage.length, 'acceptance criterion', 'acceptance criteria')}: ${r.coverage.map((c) => `${name(c)} (${c.how})`).join(', ')}`;
}

function claimsText(r: TraceRequirement): string {
  const { checked, total } = r.claims;
  if (!total) return 'no tasks';
  return `${checked} of ${plural(total, 'task')} checked (implementation claims, not verification)`;
}

function evidenceText(r: TraceRequirement): string {
  const e = r.evidence;
  if (!r.id) return 'none: without an id no evidence can support it';
  if (!e.total) return `none: no verification record supports ${r.id}`;
  const parts = [`${e.passing} passing`, `${e.failing} failing`, `${e.inconclusive} inconclusive`, `${e.outdated} outdated`];
  if (e.unrecorded) parts.push(`${e.unrecorded} without a result`);
  return `${e.total} ${e.total === 1 ? 'record' : 'records'}: ${parts.join(', ')} · methods: ${e.methods.join(', ')}`;
}

function acceptanceText(r: TraceRequirement): string {
  const a = r.acceptance;
  if (a.accepted) return `accepted by ${a.by.join(', ')}`;
  const outdated = a.records.filter((x) => x.freshness === 'outdated').length;
  if (!a.records.length) return 'none';
  return `not accepted: ${plural(a.records.length, 'acceptance record')}${outdated ? `, ${outdated} outdated` : ''}, none current and passing`;
}

/** The trace as text: one block per requirement, then the summary. */
export function formatTrace(result: TraceResult): string {
  const blocks = result.requirements.map((r) => [
    `${r.file}:${r.line + 1}  ${r.id ?? '(no id)'}  ${r.title}`,
    `  status      ${r.status}${r.unsupportedVerified ? ' (as written; no current passing evidence supports it)' : ''}`,
    `  coverage    ${coverageText(r)}`,
    `  claims      ${claimsText(r)}`,
    `  evidence    ${evidenceText(r)}`,
    `  acceptance  ${acceptanceText(r)}`,
  ].join('\n'));
  return [...blocks, traceSummary(result.summary)].join('\n\n') + '\n';
}

/**
 * "Requirements: 5. Covered by acceptance criteria: 3 of 5. …", each count with its denominator, ending with what a
 * checked task is.
 */
export function traceSummary(s: TraceSummary): string {
  const of = (n: number) => `${n} of ${s.requirements}`;
  return [
    `Requirements: ${s.requirements}.`,
    `Covered by acceptance criteria: ${of(s.covered)}.`,
    `With current passing evidence: ${of(s.withPassingEvidence)}.`,
    `Accepted by a person: ${of(s.accepted)}.`,
    ...(s.unsupportedVerified ? [`Marked verified without current passing evidence: ${of(s.unsupportedVerified)}.`] : []),
    'Checked tasks are implementation claims, not verification.',
    ...(s.documents > 1 ? ['Evidence supports requirements in its own document only.'] : []),
  ].join(' ');
}
