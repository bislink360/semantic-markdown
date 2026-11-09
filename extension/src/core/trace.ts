import { accepts, evidenceRecords, isAcceptance, supportFor, type EvidenceFreshness, type EvidenceRecord } from './evidence';
import { DocumentGraph, nodeKey, type GraphDocument, type GraphEdge } from './graph';
import { documentBlocks, type DocumentBlock } from './query';

/**
 * Requirement tracing (research AF26, feedback-loop RFC "Tracing requirements"). Each requirement gets five separate
 * columns, and nothing in one is inferred from another: its status as written, its coverage (acceptance criteria that
 * verify it), its claims (tasks in it or that depend on it), its evidence (verification records that support it) and
 * its human acceptance. A checked task is never evidence, and an acceptance criterion is never evidence. Ids resolve
 * within each document, and an acceptance criterion, task or record in another of the documents counts when it names
 * the requirement with its path, as in `verifies=spec.smd#R1` (R19).
 */

export interface TraceCriterion {
  title: string;
  line: number;
  id?: string;
  /** Nested in the requirement, or standing alone with `verifies=`. */
  how: 'nested' | 'verifies';
  /** The document it is in, when that is not the requirement's (`verifies=spec.smd#R1`). */
  file?: string;
}

export interface TraceTask {
  text: string;
  line: number;
  id?: string;
  done: boolean;
  /** Inside the requirement block, or naming it in `:depends[…]`. */
  how: 'inside' | 'depends';
  /** The document it is in, when that is not the requirement's (`:depends[spec.smd#R1]`). */
  file?: string;
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
  /** The document it is in, when that is not the requirement's (`supports=spec.smd#R1`). */
  file?: string;
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

/** A document's blocks and evidence records, read once per trace. */
interface TracedDocument { path: string; lines: readonly string[]; blocks: DocumentBlock[]; records: EvidenceRecord[] }

/** A record that supports a requirement, with the id it names it by as written (`R1`, or `a.smd#R1` from another document). */
interface Supporting { record: EvidenceRecord; as: string; file: string }

/** The requirements of `documents`, each with its five columns, and the counts over all of them. */
export function traceRequirements(documents: readonly GraphDocument[], options: TraceOptions = {}): TraceResult {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const graph = new DocumentGraph(documents, { today });
  const traced = new Map<string, TracedDocument>();
  for (const path of graph.paths) {
    const doc = graph.document(path);
    if (!('text' in doc)) continue;
    const blocks = documentBlocks(doc.text, today);
    traced.set(path, { path, lines: doc.lines, blocks, records: evidenceRecords(doc.text, blocks) });
  }
  // Edges from every document: an acceptance criterion, task or record in another one names a requirement with its
  // path (`verifies=spec.smd#R1`, R19).
  const edges = graph.allEdges().filter((e) => e.status === 'resolved' && e.to);
  const all: TraceRequirement[] = [];
  for (const doc of traced.values()) {
    for (const req of doc.blocks.filter((b) => b.type === 'requirement')) {
      all.push(traceOne(doc, req, edges.filter((e) => nodeKey(e.to!) === `${doc.path}:${req.line}`), traced));
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

/** One requirement's five columns, from the edges that point at it. */
function traceOne(doc: TracedDocument, req: DocumentBlock, pointingAt: readonly GraphEdge[], traced: ReadonlyMap<string, TracedDocument>): TraceRequirement {
  const id = str(req.attrs.id);
  const pointing = (type: string) => pointingAt.filter((e) => e.type === type);
  const blockOf = (e: GraphEdge, type: string) => traced.get(e.from.file)?.blocks.find((b) => b.line === e.from.line && b.type === type);
  const elsewhere = (file: string) => (file === doc.path ? {} : { file });
  const order = (a: { file?: string; line: number }, b: { file?: string; line: number }) =>
    (a.file ?? '').localeCompare(b.file ?? '') || a.line - b.line;

  const coverage: TraceCriterion[] = [];
  const seen = new Set<string>();
  const criterion = (file: string, b: DocumentBlock | undefined, how: TraceCriterion['how']) => {
    if (!b || seen.has(`${file}:${b.line}`)) return;
    seen.add(`${file}:${b.line}`);
    const cid = str(b.attrs.id);
    coverage.push({ title: b.title, line: b.line, ...(cid ? { id: cid } : {}), how, ...elsewhere(file) });
  };
  for (const b of doc.blocks) if (b.type === 'acceptance' && within(req, b.line)) criterion(doc.path, b, 'nested');
  for (const e of pointing('verifies')) criterion(e.from.file, blockOf(e, 'acceptance'), 'verifies');
  coverage.sort(order);

  const tasks: TraceTask[] = [];
  const task = (file: string, b: DocumentBlock | undefined, how: TraceTask['how']) => {
    if (!b || tasks.some((t) => t.line === b.line && (t.file ?? doc.path) === file)) return;
    const tid = str(b.attrs.id);
    tasks.push({ text: b.title, line: b.line, ...(tid ? { id: tid } : {}), done: b.attrs.done === 'true', how, ...elsewhere(file) });
  };
  for (const b of doc.blocks) if (b.type === 'task' && within(req, b.line)) task(doc.path, b, 'inside');
  for (const e of pointing('depends-on')) if (e.from.type === 'task') task(e.from.file, blockOf(e, 'task'), 'depends');
  tasks.sort(order);

  // Records name requirements by id (resolved as the graph resolves it), so one without an id has none.
  const mine: Supporting[] = [];
  if (id) {
    for (const e of pointing('supports')) {
      const record = traced.get(e.from.file)?.records.find((r) => r.line === e.from.line);
      if (record && !mine.some((m) => m.record === record)) mine.push({ record, as: e.target, file: e.from.file });
    }
    mine.sort((a, b) => order({ ...elsewhere(a.file), line: a.record.line }, { ...elsewhere(b.file), line: b.record.line }));
  }
  const record = (m: Supporting) => ({ ...traceRecord(m.record, m.as), ...elsewhere(m.file) });
  const verification = mine.filter((m) => !isAcceptance(m.record)).map(record);
  const acceptance = mine.filter((m) => isAcceptance(m.record)).map(record);
  const accepted = mine.filter((m) => accepts(m.record, m.as));
  const current = verification.filter((r) => r.freshness !== 'outdated');
  const passing = current.filter((r) => r.result === 'pass').length;
  const status = (str(req.attrs.status) ?? 'proposed').trim();
  return {
    file: doc.path, line: req.line, ...(id ? { id } : {}), title: req.title || firstLine(doc.lines, req), status,
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
      accepted: accepted.length > 0,
      by: [...new Set(accepted.map((m) => m.record.by ?? 'someone unnamed'))],
      records: acceptance,
    },
  };
}

/** A block without a title by its first line of text, cut to 80 characters. */
function firstLine(lines: readonly string[], b: DocumentBlock): string {
  const text = lines.slice(b.line + 1, b.endLine).map((l) => l.trim()).find((l) => l && !l.startsWith(':::')) ?? '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const name = (x: { id?: string; line: number; file?: string }) => `${x.file ? `${x.file} ` : ''}${x.id ?? `L${x.line + 1}`}`;

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
    ...(s.documents > 1 ? ['Evidence and acceptance criteria in another document count only when they name the requirement with its path (spec.smd#R1).'] : []),
  ].join(' ');
}
