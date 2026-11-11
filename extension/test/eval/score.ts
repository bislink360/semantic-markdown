import { createHash } from 'node:crypto';
import { renderDoc, type Rendered } from './conditions';
import { estimate, normalise, overlaps, spanLines, spanText, type Corpus, type CorpusDoc } from './corpus';
import type { AnswerObject, AnswerRecord, AnnotationItem, Task } from './types';

/**
 * The task scorer. Closed-form task types are scored automatically; qualification answers go to judge packets that
 * show the task, its annotated items and the answer, never the condition. Per-condition aggregates carry a seeded
 * paired bootstrap 95% interval (documents resampled, then tasks within them, the same draws for every condition).
 */

/** An edit plan is correct when it finds every expected line and at least this share of its lines are expected. */
export const EDIT_PLAN_MIN_PRECISION = 0.5;
export const DEFAULT_SEED = 1;
export const DEFAULT_RESAMPLES = 2000;

/** One scored answer. */
export interface Outcome {
  doc: string;
  task: string;
  type: Task['type'];
  condition: string;
  run: string;
  seed?: string;
  model?: string;
  /** Whose line numbers the condition showed (M conditions: md, the rest: smd). */
  format: 'md' | 'smd';
  /** 1 or 0 (a judge may give a share); null while a qualification answer waits for its judge. */
  correct: number | null;
  scoredBy: 'auto' | 'judge' | 'pending-judge';
  /** The answer breaks an annotated constraint (a primary measure of its own). */
  violation: boolean;
  /** The constraint items it breaks. */
  violated: string[];
  /** Decision status only: the answer chose a superseded or rejected option (secondary measure). */
  usedSuperseded: boolean | null;
  verdictCorrect?: boolean;
  citedConstraint?: boolean;
  flaggedUndecided?: boolean;
  fallbackCorrect?: boolean;
  precision?: number;
  recall?: number;
  /** Judge packet id, for qualification answers. */
  packet?: string;
  /** Token counts the provider reported. Null when the record has none. */
  providerInputTokens: number | null;
  providerOutputTokens: number | null;
  /** Estimates (≈ characters / 4), never provider counts: what the condition showed (null when the model chose it), and the answer. */
  shownTokensEstimate: number | null;
  answerTokensEstimate: number;
}

/** What a judge or a person returns for one packet: correct as 0 to 1, and whether the answer breaks a constraint. */
export interface JudgedRecord { packet: string; correct: number; violation?: boolean }

export interface JudgePacket {
  packet: string;
  task: { id: string; type: string; prompt: string };
  rubric: Array<{ id: string; text: string; items?: string[] }>;
  /** The annotated items, as plain Markdown text, so the packet does not reveal the condition. */
  items: Array<{ id: string; kind: string; text: string }>;
  answer: string;
}

export interface ScoreOptions {
  seed?: number;
  resamples?: number;
  /** The condition differences are taken against (default M1 when present). */
  baseline?: string;
  judged?: JudgedRecord[];
  /**
   * Non-inferiority margin for correctness against the baseline, as a share (0.05 is 5 percentage points). Not set by
   * default: the study owner sets it after the pilot, and without it no verdict is given.
   */
  niMargin?: number;
  /** Two-sided equivalence margin, as a share. Not set by default. */
  equivalenceMargin?: number;
}

export interface Interval { mean: number; ci: [number, number]; n: number }

/**
 * Non-inferiority of a condition against the baseline, on the paired difference (condition minus baseline, higher is
 * better) and its 95% interval: `non-inferior` when the lower bound is above -margin, `inferior` when the upper bound
 * is below -margin, `inconclusive` when the interval holds -margin.
 */
export type NonInferiorityVerdict = 'non-inferior' | 'inferior' | 'inconclusive';
/** Equivalence (two one-sided tests on the same 95% interval): inside (-margin, margin), wholly outside it, or neither. */
export type EquivalenceVerdict = 'equivalent' | 'not-equivalent' | 'inconclusive';

export interface MarginTest<V extends string> { margin: number; verdict: V; diff: number; ci: [number, number] }

/** The non-inferiority verdict for a difference interval (condition minus reference) and a margin > 0. */
export function nonInferiorityVerdict(ci: readonly [number, number], margin: number): NonInferiorityVerdict {
  if (ci[0] > -margin) return 'non-inferior';
  if (ci[1] < -margin) return 'inferior';
  return 'inconclusive';
}

/** The equivalence verdict for a difference interval and a two-sided margin > 0. */
export function equivalenceVerdict(ci: readonly [number, number], margin: number): EquivalenceVerdict {
  if (ci[0] > -margin && ci[1] < margin) return 'equivalent';
  if (ci[1] < -margin || ci[0] > margin) return 'not-equivalent';
  return 'inconclusive';
}

/** Checks a margin: a share strictly between 0 and 1, or undefined. */
export function checkMargin(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be a share between 0 and 1 (0.05 is 5 percentage points)`);
  }
  return value;
}

export interface ConditionSummary {
  condition: string;
  answers: number;
  /** (document, task) units with at least one answer. */
  units: number;
  /** Mean over units of the per-unit mean over runs, scored answers only. */
  correctness: Interval | null;
  violations: Interval | null;
  usedSuperseded: Interval | null;
  /** Correctness minus the baseline's, over units both have. */
  vsBaseline?: Interval & { baseline: string };
  /** Only when a non-inferiority margin is set: the verdict on vsBaseline. */
  nonInferiority?: MarginTest<NonInferiorityVerdict>;
  /** Only when an equivalence margin is set. */
  equivalence?: MarginTest<EquivalenceVerdict>;
  editPlan: { precision: number; recall: number; n: number } | null;
  pendingJudge: number;
  tokens: {
    /** Mean provider-reported counts over answers that have them. */
    providerInputMean: number | null;
    providerOutputMean: number | null;
    providerAnswers: number;
    /** Means of the estimates (≈ characters / 4), labelled as estimates. */
    shownEstimateMean: number | null;
    answerEstimateMean: number;
  };
}

export interface ScoreResult {
  outcomes: Outcome[];
  summary: ConditionSummary[];
  packets: JudgePacket[];
  /** Packet id to the answer it came from, kept apart from the packets so judges stay blind. */
  key: Array<{ packet: string; doc: string; task: string; condition: string; run: string; model?: string; seed?: string }>;
  problems: string[];
  settings: {
    seed: number; resamples: number; baseline?: string; editPlanMinPrecision: number;
    /** Null when not set: no verdict is given. */
    niMargin: number | null;
    equivalenceMargin: number | null;
  };
}

/** Lower case, marks removed, digit group commas dropped, outer punctuation and a leading article removed. */
export function normaliseAnswer(s: string): string {
  const trim = (x: string) => x.replace(/^[\s"'.,;:!?()[\]]+|[\s"'.,;:!?()[\]]+$/g, '');
  return trim(trim(normalise(s).replace(/(\d),(?=\d{3}\b)/g, '$1')).replace(/^(the|a|an) /, ''));
}

const matchesAny = (answer: string | undefined, accepted: string[]) =>
  answer !== undefined && accepted.some((a) => normaliseAnswer(a) === normaliseAnswer(answer));

const asObject = (a: AnswerRecord['answer']): AnswerObject => (typeof a === 'string' ? { text: a } : a ?? {});

/** The answer's main text for its task type. */
function mainText(task: Task, a: AnswerObject): string | undefined {
  switch (task.type) {
    case 'constraint-check': return a.verdict ?? a.text;
    case 'decision-status': return a.option ?? a.text;
    case 'open-question': return a.fallback;
    default: return a.text;
  }
}

/** Input and output tokens from a provider's usage object, under the common names. */
export function providerTokens(usage: Record<string, number> | undefined): { input: number | null; output: number | null } {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof usage?.[k] === 'number') return usage[k];
    return null;
  };
  return {
    input: pick('input', 'inputTokens', 'input_tokens', 'prompt_tokens', 'promptTokens'),
    output: pick('output', 'outputTokens', 'output_tokens', 'completion_tokens', 'completionTokens'),
  };
}

export const formatOf = (condition: string): 'md' | 'smd' => (/^M/i.test(condition) ? 'md' : 'smd');

export function packetId(r: Pick<AnswerRecord, 'condition' | 'run' | 'seed' | 'model'>, doc: string, task: string): string {
  return createHash('sha256').update([doc, task, r.condition, r.run, r.seed ?? '', r.model ?? ''].join('\u0000')).digest('hex').slice(0, 12);
}

/** Scores one answer. `items` are the document's annotation items by id. */
export function scoreAnswer(doc: CorpusDoc, task: Task, r: AnswerRecord, shownTokensEstimate: number | null = null): Outcome {
  const items = new Map(doc.annotations.items.map((i) => [i.id, i]));
  const format = formatOf(r.condition);
  const a = asObject(r.answer);
  const text = mainText(task, a);
  const usage = providerTokens(r.usage);
  const violated = new Set<string>();
  const out: Outcome = {
    doc: doc.name, task: task.id, type: task.type, condition: r.condition, run: String(r.run),
    ...(r.seed !== undefined ? { seed: String(r.seed) } : {}), ...(r.model ? { model: r.model } : {}),
    format, correct: 0, scoredBy: 'auto', violation: false, violated: [], usedSuperseded: null,
    providerInputTokens: usage.input, providerOutputTokens: usage.output,
    shownTokensEstimate, answerTokensEstimate: estimate(typeof r.answer === 'string' ? r.answer : JSON.stringify(r.answer ?? '')),
  };
  switch (task.type) {
    case 'fact-lookup':
      out.correct = matchesAny(text, task.expected.accepted) ? 1 : 0;
      break;
    case 'constraint-check': {
      const constraint = items.get(task.expected.constraint) as AnnotationItem;
      out.verdictCorrect = matchesAny(text, task.expected.verdict);
      out.citedConstraint = (r.cited ?? []).includes(constraint.id) || (r.lines ?? []).some((s) => overlaps(s, constraint[format]));
      out.correct = out.verdictCorrect && out.citedConstraint ? 1 : 0;
      // A verdict other than the expected one breaks the constraint the task checks.
      if (!out.verdictCorrect && text?.trim()) violated.add(constraint.id);
      break;
    }
    case 'decision-status':
      out.correct = matchesAny(text, task.expected.option) ? 1 : 0;
      out.usedSuperseded = matchesAny(text, task.expected.superseded);
      break;
    case 'open-question':
      out.flaggedUndecided = a.undecided === true;
      out.fallbackCorrect = matchesAny(text, task.expected.fallback);
      out.correct = out.flaggedUndecided && out.fallbackCorrect ? 1 : 0;
      break;
    case 'qualification':
      out.correct = null;
      out.scoredBy = 'pending-judge';
      out.packet = packetId(r, doc.name, task.id);
      break;
    case 'edit-plan': {
      const expected = spanLines(task.expected[format]);
      const planned = spanLines(r.lines ?? a.lines ?? []);
      const hit = [...planned].filter((l) => expected.has(l)).length;
      out.precision = planned.size ? hit / planned.size : 0;
      out.recall = expected.size ? hit / expected.size : 0;
      out.correct = out.recall === 1 && out.precision >= EDIT_PLAN_MIN_PRECISION ? 1 : 0;
      break;
    }
  }
  for (const v of task.violations ?? []) if (matchesAny(text, v.answers)) violated.add(v.item);
  out.violated = [...violated];
  out.violation = violated.size > 0;
  return out;
}

export function judgePacket(doc: CorpusDoc, task: Task, r: AnswerRecord): JudgePacket {
  const byId = new Map(doc.annotations.items.map((i) => [i.id, i]));
  const items = task.items.map((id) => byId.get(id)).filter((i): i is AnnotationItem => !!i);
  const a = asObject(r.answer);
  return {
    packet: packetId(r, doc.name, task.id),
    task: { id: task.id, type: task.type, prompt: task.prompt },
    rubric: task.type === 'qualification' ? task.expected.rubric : [],
    items: items.map((i) => ({ id: i.id, kind: i.kind, text: spanText(doc.md, i.md) })),
    answer: a.text ?? (typeof r.answer === 'string' ? r.answer : JSON.stringify(r.answer)),
  };
}

/** A small seeded generator (mulberry32), so intervals are the same on every run with the same seed. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const at = q * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

const unitKey = (doc: string, task: string) => `${doc}\u0000${task}`;
const docOfUnit = (unit: string) => unit.split('\u0000')[0];

/**
 * Seeded paired bootstrap over (document, task) units: each resample draws documents with replacement, then tasks
 * within each drawn document, and uses the same draws for every condition. `values`: condition → unit → value.
 * `level` is the interval's coverage (default 0.95, percentile interval).
 */
export function pairedBootstrap(
  values: Map<string, Map<string, number>>, options: { seed?: number; resamples?: number; baseline?: string; level?: number } = {},
): Map<string, { estimate: Interval; diff?: Interval }> {
  const seed = options.seed ?? DEFAULT_SEED;
  const tail = (1 - (options.level ?? 0.95)) / 2;
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const units = [...new Set([...values.values()].flatMap((m) => [...m.keys()]))].sort((a, b) => a.localeCompare(b));
  const docs = [...new Set(units.map(docOfUnit))];
  const tasksOf = new Map(docs.map((d) => [d, units.filter((u) => docOfUnit(u) === d)]));
  const random = seededRandom(seed);
  const conditions = [...values.keys()];
  const base = options.baseline ? values.get(options.baseline) : undefined;
  const means = new Map(conditions.map((c) => [c, [] as number[]]));
  const diffs = new Map(conditions.map((c) => [c, [] as number[]]));
  for (let b = 0; b < resamples; b++) {
    const draws: string[] = [];
    for (let d = 0; d < docs.length; d++) {
      const tasks = tasksOf.get(docs[Math.floor(random() * docs.length)])!;
      for (let t = 0; t < tasks.length; t++) draws.push(tasks[Math.floor(random() * tasks.length)]);
    }
    for (const c of conditions) {
      const v = values.get(c)!;
      let sum = 0;
      let n = 0;
      let dsum = 0;
      let dn = 0;
      for (const u of draws) {
        const x = v.get(u);
        if (x === undefined) continue;
        sum += x;
        n++;
        const y = base?.get(u);
        if (y !== undefined) { dsum += x - y; dn++; }
      }
      if (n) means.get(c)!.push(sum / n);
      if (dn) diffs.get(c)!.push(dsum / dn);
    }
  }
  const interval = (sample: number[], point: number, n: number): Interval => {
    const sorted = [...sample].sort((x, y) => x - y);
    return { mean: point, ci: [quantile(sorted, tail), quantile(sorted, 1 - tail)], n };
  };
  const out = new Map<string, { estimate: Interval; diff?: Interval }>();
  for (const c of conditions) {
    const v = values.get(c)!;
    const all = [...v.values()];
    const entry: { estimate: Interval; diff?: Interval } = { estimate: interval(means.get(c)!, all.reduce((s, x) => s + x, 0) / (all.length || 1), all.length) };
    if (base && c !== options.baseline) {
      const shared = [...v.keys()].filter((u) => base.has(u));
      if (shared.length) entry.diff = interval(diffs.get(c)!, shared.reduce((s, u) => s + v.get(u)! - base.get(u)!, 0) / shared.length, shared.length);
    }
    out.set(c, entry);
  }
  return out;
}

/** condition → unit → mean over runs of a metric, leaving out answers where it is null. */
function unitMeans(outcomes: Outcome[], metric: (o: Outcome) => number | null): Map<string, Map<string, number>> {
  const sums = new Map<string, Map<string, [number, number]>>();
  for (const o of outcomes) {
    const x = metric(o);
    if (x === null) continue;
    const byUnit = sums.get(o.condition) ?? new Map<string, [number, number]>();
    const key = unitKey(o.doc, o.task);
    const [s, n] = byUnit.get(key) ?? [0, 0];
    byUnit.set(key, [s + x, n + 1]);
    sums.set(o.condition, byUnit);
  }
  return new Map([...sums].map(([c, m]) => [c, new Map([...m].map(([u, [s, n]]) => [u, s / n]))]));
}

const meanOf = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Parses answers.jsonl; blank lines are skipped, bad lines reported. */
export function parseAnswers(text: string): { records: AnswerRecord[]; problems: string[] } {
  const records: AnswerRecord[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const r = JSON.parse(line) as AnswerRecord;
      if (!r.task || !r.condition || r.run === undefined) problems.push(`line ${i + 1}: needs task, condition and run`);
      else records.push(r);
    } catch (e) {
      problems.push(`line ${i + 1}: ${(e as Error).message}`);
    }
  });
  return { records, problems };
}

/** What each condition the renderer can reproduce showed, as estimated tokens, by document, task and condition. */
function shownEstimates(corpus: Corpus): Map<string, number> {
  const out = new Map<string, number>();
  const put = (r: Rendered) => out.set([r.doc, r.task ?? '', r.condition].join('\u0000'), r.tokensEstimate);
  for (const doc of corpus.docs) {
    const { doc: views, tasks } = renderDoc(corpus, doc);
    views.forEach(put);
    for (const list of tasks.values()) list.forEach(put);
  }
  return out;
}

export function scoreAnswers(corpus: Corpus, records: AnswerRecord[], options: ScoreOptions = {}): ScoreResult {
  const problems: string[] = [];
  const byId = new Map<string, Array<{ doc: CorpusDoc; task: Task }>>();
  for (const doc of corpus.docs) for (const task of doc.tasks) byId.set(task.id, [...(byId.get(task.id) ?? []), { doc, task }]);
  const shown = shownEstimates(corpus);
  const judged = new Map((options.judged ?? []).map((j) => [j.packet, j]));
  const outcomes: Outcome[] = [];
  const packets: JudgePacket[] = [];
  const key: ScoreResult['key'] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const found = (byId.get(r.task) ?? []).filter((f) => !r.doc || f.doc.name === r.doc);
    if (found.length !== 1) { problems.push(`${r.task}: ${found.length ? 'task id in several documents; add "doc"' : 'no such task'}`); continue; }
    const { doc, task } = found[0];
    const id = [doc.name, task.id, r.condition, r.run, r.model ?? ''].join('\u0000');
    if (seen.has(id)) problems.push(`${task.id} ${r.condition} run ${r.run}: more than one answer; all are scored`);
    seen.add(id);
    const estimateShown = shown.get([doc.name, '', r.condition].join('\u0000')) ?? shown.get([doc.name, task.id, r.condition].join('\u0000')) ?? null;
    const o = scoreAnswer(doc, task, r, estimateShown);
    if (o.packet) {
      packets.push(judgePacket(doc, task, r));
      key.push({ packet: o.packet, doc: doc.name, task: task.id, condition: r.condition, run: String(r.run), ...(r.model ? { model: r.model } : {}), ...(r.seed !== undefined ? { seed: String(r.seed) } : {}) });
      const j = judged.get(o.packet);
      if (j) {
        o.correct = j.correct;
        o.scoredBy = 'judge';
        if (j.violation) { o.violation = true; o.violated = [...o.violated, 'judge']; }
      }
    }
    outcomes.push(o);
  }
  // Packets in a seeded random order, so their order does not give the condition away.
  const random = seededRandom((options.seed ?? DEFAULT_SEED) ^ 0x5bd1e995);
  const order = new Map(packets.map((p) => [p.packet, random()]));
  packets.sort((a, b) => order.get(a.packet)! - order.get(b.packet)!);
  const conditions = [...new Set(outcomes.map((o) => o.condition))];
  const baseline = options.baseline ?? (conditions.includes('M1') ? 'M1' : undefined);
  const settings: ScoreResult['settings'] = {
    seed: options.seed ?? DEFAULT_SEED, resamples: options.resamples ?? DEFAULT_RESAMPLES, baseline, editPlanMinPrecision: EDIT_PLAN_MIN_PRECISION,
    niMargin: checkMargin(options.niMargin, 'the non-inferiority margin') ?? null,
    equivalenceMargin: checkMargin(options.equivalenceMargin, 'the equivalence margin') ?? null,
  };
  return { outcomes, summary: summarise(outcomes, settings), packets, key, problems, settings };
}

function summarise(outcomes: Outcome[], settings: ScoreResult['settings']): ConditionSummary[] {
  const boot = (metric: (o: Outcome) => number | null, withBaseline = false) =>
    pairedBootstrap(unitMeans(outcomes, metric), { seed: settings.seed, resamples: settings.resamples, baseline: withBaseline ? settings.baseline : undefined });
  const correctness = boot((o) => o.correct, true);
  // An answer still waiting for its judge has no violation verdict yet.
  const violations = boot((o) => (o.scoredBy === 'pending-judge' ? null : o.violation ? 1 : 0));
  const superseded = boot((o) => (o.usedSuperseded === null ? null : o.usedSuperseded ? 1 : 0));
  const conditions = [...new Set(outcomes.map((o) => o.condition))].sort((a, b) => a.localeCompare(b));
  return conditions.map((condition) => {
    const own = outcomes.filter((o) => o.condition === condition);
    const edits = own.filter((o) => o.type === 'edit-plan');
    const provider = own.filter((o) => o.providerInputTokens !== null || o.providerOutputTokens !== null);
    const c = correctness.get(condition);
    const s: ConditionSummary = {
      condition, answers: own.length, units: new Set(own.map((o) => unitKey(o.doc, o.task))).size,
      correctness: c?.estimate ?? null,
      violations: violations.get(condition)?.estimate ?? null,
      usedSuperseded: superseded.get(condition)?.estimate ?? null,
      editPlan: edits.length ? { precision: meanOf(edits.map((o) => o.precision ?? 0))!, recall: meanOf(edits.map((o) => o.recall ?? 0))!, n: edits.length } : null,
      pendingJudge: own.filter((o) => o.scoredBy === 'pending-judge').length,
      tokens: {
        providerInputMean: meanOf(provider.flatMap((o) => (o.providerInputTokens === null ? [] : [o.providerInputTokens]))),
        providerOutputMean: meanOf(provider.flatMap((o) => (o.providerOutputTokens === null ? [] : [o.providerOutputTokens]))),
        providerAnswers: provider.length,
        shownEstimateMean: meanOf(own.flatMap((o) => (o.shownTokensEstimate === null ? [] : [o.shownTokensEstimate]))),
        answerEstimateMean: meanOf(own.map((o) => o.answerTokensEstimate))!,
      },
    };
    if (c?.diff && settings.baseline) {
      s.vsBaseline = { ...c.diff, baseline: settings.baseline };
      const { mean: diff, ci } = c.diff;
      if (settings.niMargin !== null) s.nonInferiority = { margin: settings.niMargin, verdict: nonInferiorityVerdict(ci, settings.niMargin), diff, ci };
      if (settings.equivalenceMargin !== null) s.equivalence = { margin: settings.equivalenceMargin, verdict: equivalenceVerdict(ci, settings.equivalenceMargin), diff, ci };
    }
    return s;
  });
}

export const OUTCOME_COLUMNS = [
  'doc', 'task', 'type', 'condition', 'run', 'seed', 'model', 'format', 'correct', 'scoredBy', 'violation', 'violated', 'usedSuperseded',
  'verdictCorrect', 'citedConstraint', 'flaggedUndecided', 'fallbackCorrect', 'precision', 'recall', 'packet',
  'providerInputTokens', 'providerOutputTokens', 'shownTokensEstimate', 'answerTokensEstimate',
] as const;

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : Array.isArray(v) ? v.join(' ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function outcomesCsv(outcomes: Outcome[]): string {
  const rows = outcomes.map((o) => OUTCOME_COLUMNS.map((c) => csvCell((o as unknown as Record<string, unknown>)[c])).join(','));
  return [OUTCOME_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

const fmt = (x: number | null | undefined, digits = 3) => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(digits));
const fmtInterval = (i: Interval | null | undefined) => (i ? `${fmt(i.mean)} [${fmt(i.ci[0])}, ${fmt(i.ci[1])}] n=${i.n}` : '-');

export function summaryText(r: ScoreResult): string {
  const s = r.settings;
  const out = [
    '# Scores',
    '',
    `Paired bootstrap 95% intervals: ${s.resamples} resamples, seed ${s.seed}, documents then tasks resampled, units are (document, task).`,
    'Provider tokens are reported usage; "est" columns are estimates (≈ characters / 4), not usage.',
    '',
    `| condition | answers | correctness | ${s.baseline ? `vs ${s.baseline}` : 'vs baseline'} | constraint violations | used superseded | edit plan P / R | pending judge | provider in / out (mean) | shown est | answer est |`,
    '|-|-|-|-|-|-|-|-|-|-|-|',
  ];
  for (const c of r.summary) {
    out.push(`| ${[
      c.condition, String(c.answers), fmtInterval(c.correctness), fmtInterval(c.vsBaseline), fmtInterval(c.violations), fmtInterval(c.usedSuperseded),
      c.editPlan ? `${fmt(c.editPlan.precision, 2)} / ${fmt(c.editPlan.recall, 2)}` : '-', String(c.pendingJudge),
      c.tokens.providerAnswers ? `${fmt(c.tokens.providerInputMean, 0)} / ${fmt(c.tokens.providerOutputMean, 0)}` : '-',
      fmt(c.tokens.shownEstimateMean, 0), fmt(c.tokens.answerEstimateMean, 0),
    ].join(' | ')} |`);
  }
  out.push('', ...marginText(r));
  if (r.problems.length) out.push('', '## Problems', '', ...r.problems.map((p) => `- ${p}`));
  return out.join('\n') + '\n';
}

/** The non-inferiority and equivalence section: verdicts when a margin is set, and a line saying so when not. */
function marginText(r: ScoreResult): string[] {
  const s = r.settings;
  const out = ['## Non-inferiority and equivalence', ''];
  if (!s.baseline) return [...out, 'No baseline condition, so no comparison (pass --baseline).'];
  if (s.niMargin === null && s.equivalenceMargin === null) {
    return [...out, 'No margin set, so no verdict. The study owner sets it after the pilot: --ni-margin and --eq-margin, or "analysis" in a run config passed with --config.'];
  }
  const pts = (m: number | null) => (m === null ? 'not set' : `${fmt(m * 100, 1)} points`);
  out.push(
    `Correctness difference (condition minus ${s.baseline}) with its paired bootstrap 95% interval. Non-inferior when the lower bound is above -margin, `
      + 'inferior when the upper bound is below it, inconclusive otherwise. Equivalent when the interval is inside (-margin, margin), '
      + 'not equivalent when it is wholly outside, inconclusive otherwise.',
    '',
    `Non-inferiority margin: ${pts(s.niMargin)}. Equivalence margin: ${pts(s.equivalenceMargin)}.`,
    '',
    '| condition | difference [95% CI] | non-inferiority | equivalence |',
    '|-|-|-|-|',
  );
  for (const c of r.summary) {
    if (c.condition === s.baseline) continue;
    out.push(`| ${c.condition} | ${fmtInterval(c.vsBaseline)} | ${c.nonInferiority?.verdict ?? '-'} | ${c.equivalence?.verdict ?? '-'} |`);
  }
  return out;
}
