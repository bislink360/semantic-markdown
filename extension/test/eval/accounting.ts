import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SetupProbe } from './runner';
import { DEFAULT_RESAMPLES, DEFAULT_SEED, pairedBootstrap, type Interval, type Outcome } from './score';

/**
 * Total-token accounting (research/token-accounting.smd). Reads a run folder written by `run` and turns its
 * transcripts into one record per call, classified, with the provider's usage mapped to common fields. Only
 * provider-reported usage is counted; nothing here estimates tokens. The headline total is input plus output, with
 * cached input counted as ordinary input; cached and uncached input are always reported beside it.
 */

export const CALL_CLASSES = ['retrieval', 'repeat-read', 'repair', 'answer', 'retry'] as const;
export type CallClass = (typeof CALL_CLASSES)[number];

/** Provider usage in common fields. `input` includes cached input; null when the provider did not report it. */
export interface Usage { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null }

/** How the provider's fields were read: Chat Completions names, `input_tokens` names, or not recognised. */
export type UsageMapping = 'chat-completions' | 'input-tokens' | 'unknown';

const NO_USAGE: Usage = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };

const num = (o: any, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = k.split('.').reduce((x, p) => (x && typeof x === 'object' ? x[p] : undefined), o);
    if (typeof v === 'number') return v;
  }
  return null;
};

/**
 * Maps a usage object as the provider returned it. Chat Completions counts cached input inside `prompt_tokens`.
 * Some `input_tokens` APIs report cache reads and writes beside `input_tokens` (`cache_read_input_tokens`,
 * `cache_creation_input_tokens`); those are added, so `input` always includes cached input.
 */
export function mapUsage(raw: unknown): { usage: Usage; mapping: UsageMapping } {
  if (!raw || typeof raw !== 'object') return { usage: NO_USAGE, mapping: 'unknown' };
  const r = raw as Record<string, unknown>;
  if (typeof r.prompt_tokens === 'number' || typeof r.completion_tokens === 'number') {
    return {
      mapping: 'chat-completions',
      usage: {
        input: num(r, 'prompt_tokens'), output: num(r, 'completion_tokens'),
        cacheRead: num(r, 'prompt_tokens_details.cached_tokens'),
        cacheWrite: num(r, 'prompt_tokens_details.cache_write_tokens', 'prompt_tokens_details.cache_creation_tokens'),
        reasoning: num(r, 'completion_tokens_details.reasoning_tokens'),
      },
    };
  }
  if (typeof r.input_tokens === 'number' || typeof r.output_tokens === 'number') {
    const separateRead = num(r, 'cache_read_input_tokens');
    const separateWrite = num(r, 'cache_creation_input_tokens');
    const base = num(r, 'input_tokens');
    return {
      mapping: 'input-tokens',
      usage: {
        input: base === null ? null : base + (separateRead ?? 0) + (separateWrite ?? 0),
        output: num(r, 'output_tokens'),
        cacheRead: separateRead ?? num(r, 'input_tokens_details.cached_tokens'),
        cacheWrite: separateWrite,
        reasoning: num(r, 'output_tokens_details.reasoning_tokens'),
      },
    };
  }
  return { usage: NO_USAGE, mapping: 'unknown' };
}

/** One request of an episode, or one failed attempt (class `retry`). */
export interface CallRecord {
  episode: string;
  model: string; doc: string; task: string; condition: string; run: string;
  /** 1-based position among the episode's records. */
  call: number;
  class: CallClass;
  usage: Usage | null;
  usage_raw: unknown;
  mapping: UsageMapping | null;
  /** The tool calls this request asked for, and how many repeat an earlier read of the episode. */
  toolCalls: number;
  repeatedReads: number;
  status: number;
  error: string | null;
  ms: number | null;
}

export interface Episode {
  episode: string;
  model: string; doc: string; task: string; condition: string; run: string;
  outcome: 'answered' | 'failed';
  file: string;
  calls: number;
  /** Requests the provider answered, and failed attempts. */
  requests: number;
  retries: number;
  usage: Usage;
  total: number | null;
  /** Calls whose usage could not be read. */
  unmapped: number;
  correct?: number | null;
}

const isError = (s: unknown) => typeof s === 'string' && (/^Error:/.test(s) || /\n\[budget: [^\]]*required content does not fit\]\s*$/.test(s));
const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}` : JSON.stringify(v));
const parseArgs = (raw: unknown) => {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return raw; }
};

/** Classifies the requests of one transcript (answered or failed) and maps their usage. */
export function classify(t: any, file: string): { episode: Episode; calls: CallRecord[] } {
  const model = t.model?.label ? `${t.model.label}:${t.model.id}` : String(t.model ?? '');
  const id = { model, doc: String(t.doc ?? ''), task: String(t.task ?? ''), condition: String(t.condition ?? ''), run: String(t.run ?? '') };
  const episode = `${id.model}/${id.doc}/${id.task}/${id.condition}/run${id.run}${/\.failed-\d+\.json$/.test(file) ? `/${path.basename(file, '.json').split('.').pop()}` : ''}`;
  const assistants: any[] = (Array.isArray(t.messages) ? t.messages : []).filter((m: any) => m?.role === 'assistant');
  const toolResults = new Map<string, string>();
  for (const m of Array.isArray(t.messages) ? t.messages : []) if (m?.role === 'tool') toolResults.set(String(m.tool_call_id), String(m.content ?? ''));
  const calls: CallRecord[] = [];
  const seen = new Set<string>();
  let previousHadError = false;
  let a = 0;
  const push = (c: Omit<CallRecord, 'episode' | 'call' | keyof typeof id>) => calls.push({ episode, ...id, call: calls.length + 1, ...c });
  for (const r of Array.isArray(t.responses) ? t.responses : []) {
    for (const f of r.failures ?? []) {
      push({ class: 'retry', usage: null, usage_raw: null, mapping: null, toolCalls: 0, repeatedReads: 0, status: f.status ?? 0, error: f.error ?? null, ms: f.ms ?? null });
    }
    if (r.failed) continue;
    const { usage, mapping } = mapUsage(r.usage);
    const message = assistants[a++];
    const requested: any[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    let cls: CallClass = 'answer';
    let repeated = 0;
    if (requested.length) {
      const keys = requested.map((c) => `${c.function?.name}:${canonical(parseArgs(c.function?.arguments))}`);
      repeated = keys.filter((k) => seen.has(k)).length;
      cls = previousHadError ? 'repair' : repeated === keys.length ? 'repeat-read' : 'retrieval';
      keys.forEach((k) => seen.add(k));
      previousHadError = requested.some((c) => isError(toolResults.get(String(c.id))));
    }
    push({ class: cls, usage, usage_raw: r.usage ?? null, mapping, toolCalls: requested.length, repeatedReads: repeated, status: r.status ?? 200, error: null, ms: r.latencyMs ?? null });
  }
  const priced = calls.filter((c) => c.usage);
  const sum = (k: keyof Usage) => {
    const xs = priced.map((c) => c.usage![k]).filter((x): x is number => x !== null);
    return xs.length ? xs.reduce((s, x) => s + x, 0) : null;
  };
  const usage: Usage = { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), reasoning: sum('reasoning') };
  const answered = !!t.record && !t.error;
  return {
    calls,
    episode: {
      episode, ...id, outcome: answered ? 'answered' : 'failed', file,
      calls: calls.filter((c) => c.class !== 'retry').length, requests: calls.length, retries: calls.filter((c) => c.class === 'retry').length,
      usage, total: usage.input === null && usage.output === null ? null : (usage.input ?? 0) + (usage.output ?? 0),
      unmapped: priced.filter((c) => c.mapping === 'unknown').length,
    },
  };
}

function transcriptFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? transcriptFiles(p) : e.name.endsWith('.json') ? [p] : [];
  }).sort((x, y) => x.localeCompare(y));
}

export interface ConditionTokens {
  model: string;
  condition: string;
  answered: number;
  failed: number;
  /** Per answered episode: median and quartiles of the total, and its mean with a paired bootstrap interval over (document, task). */
  perEpisode: { median: number | null; q1: number | null; q3: number | null; mean: Interval | null; vsBaseline?: Interval & { baseline: string } };
  /** Sums over answered episodes. `uncachedInput` is input minus cache reads and writes, when both are reported. */
  sums: { input: number; uncachedInput: number | null; cacheRead: number | null; cacheWrite: number | null; output: number; reasoning: number | null; total: number };
  /** Tokens spent by failed episodes, never left out of the spend. */
  failedTotal: number;
  /** Share of all tokens of the condition (answered and failed) by call class. */
  classShare: Record<CallClass, number>;
  calls: number;
  repairCalls: number;
  repeatReadCalls: number;
  retries: number;
  /** Fixed input per request from the setup probe, and its share of all input. Null without a probe. */
  setup: { perCall: number; share: number | null } | null;
  unmapped: number;
  /** Mean correctness over scored answered episodes (from `score`'s outcomes.json), beside the tokens, never combined with them. */
  correctness: { mean: number; n: number } | null;
}

export interface TokenReport {
  rules: string[];
  settings: { seed: number; resamples: number; baseline?: string };
  conditions: ConditionTokens[];
  episodes: Episode[];
  calls: CallRecord[];
  problems: string[];
}

const median = (xs: number[], q = 0.5) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = q * (s.length - 1);
  return s[Math.floor(at)] + (s[Math.ceil(at)] - s[Math.floor(at)]) * (at - Math.floor(at));
};

const sumOf = (xs: Array<number | null>) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
const sumOrNull = (xs: Array<number | null>) => (xs.some((x) => x !== null) ? sumOf(xs) : null);

export const ACCOUNTING_RULES = [
  'Only provider-reported usage is counted. Nothing in this report is an estimate.',
  'Total = input + output. Cached input is counted as ordinary input in the total and reported apart beside it.',
  'Per-episode figures use answered episodes. Tokens spent by failed episodes are reported apart and are part of the spend.',
  'Retries are logged as calls even when the provider bills nothing for them.',
  'Correctness is shown beside tokens and never combined with them into one score.',
];

export interface AccountOptions { seed?: number; resamples?: number; baseline?: string; outcomes?: Outcome[]; model?: string }

/** Accounts a run folder: `transcripts/` (answered and failed) and `setup.jsonl` when the setup probe ran. */
export function accountRun(runDir: string, options: AccountOptions = {}): TokenReport {
  const problems: string[] = [];
  const episodes: Episode[] = [];
  const calls: CallRecord[] = [];
  for (const file of transcriptFiles(path.join(runDir, 'transcripts'))) {
    let t: any;
    try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { problems.push(`${file}: not JSON`); continue; }
    const rel = path.relative(runDir, file).split(path.sep).join('/');
    const r = classify(t, rel);
    if (options.model && !(r.episode.model === options.model || r.episode.model.startsWith(`${options.model}:`))) continue;
    if (r.episode.outcome === 'failed' && !Array.isArray(t.responses)) problems.push(`${rel}: a failed answer from an older runner, its usage was not kept`);
    episodes.push(r.episode);
    calls.push(...r.calls);
  }
  if (!episodes.length) problems.push(`no transcripts under ${path.join(runDir, 'transcripts')}`);
  const correct = new Map<string, number>();
  for (const o of options.outcomes ?? []) if (o.correct !== null) correct.set([o.model ?? '', o.doc, o.task, o.condition, String(o.run)].join('\u0000'), o.correct);
  for (const e of episodes) {
    if (e.outcome !== 'answered' || !options.outcomes) continue;
    const c = correct.get([e.model, e.doc, e.task, e.condition, e.run].join('\u0000'));
    e.correct = c ?? null;
  }
  const setup = new Map<string, number>();
  const setupFile = path.join(runDir, 'setup.jsonl');
  if (fs.existsSync(setupFile)) {
    for (const line of fs.readFileSync(setupFile, 'utf8').split(/\r?\n/).filter((l) => l.trim())) {
      const p = JSON.parse(line) as SetupProbe;
      const input = mapUsage(p.usage_raw).usage.input;
      if (input === null) continue;
      for (const c of p.conditions) setup.set(`${p.model}\u0000${c}`, input);
    }
  }
  const seed = options.seed ?? DEFAULT_SEED;
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const conditions: ConditionTokens[] = [];
  for (const model of [...new Set(episodes.map((e) => e.model))].sort((a, b) => a.localeCompare(b))) {
    const mine = episodes.filter((e) => e.model === model);
    const condNames = [...new Set(mine.map((e) => e.condition))];
    const baseline = options.baseline ?? (condNames.includes('M1') ? 'M1' : undefined);
    const values = new Map<string, Map<string, number>>();
    for (const c of condNames) {
      const units = new Map<string, number[]>();
      for (const e of mine) {
        if (e.condition !== c || e.outcome !== 'answered' || e.total === null) continue;
        const k = `${e.doc}\u0000${e.task}`;
        units.set(k, [...(units.get(k) ?? []), e.total]);
      }
      values.set(c, new Map([...units].map(([k, xs]) => [k, xs.reduce((s, x) => s + x, 0) / xs.length])));
    }
    const boot = pairedBootstrap(values, { seed, resamples, baseline });
    for (const c of condNames) {
      const eps = mine.filter((e) => e.condition === c);
      const ok = eps.filter((e) => e.outcome === 'answered');
      const totals = ok.map((e) => e.total).filter((x): x is number => x !== null);
      const cs = calls.filter((x) => x.model === model && x.condition === c);
      const all = sumOf(cs.map((x) => (x.usage ? (x.usage.input ?? 0) + (x.usage.output ?? 0) : 0)));
      const classShare = Object.fromEntries(CALL_CLASSES.map((k) => [k, all ? sumOf(cs.filter((x) => x.class === k).map((x) => (x.usage ? (x.usage.input ?? 0) + (x.usage.output ?? 0) : 0))) / all : 0])) as Record<CallClass, number>;
      const input = sumOf(ok.map((e) => e.usage.input));
      const cacheRead = sumOrNull(ok.map((e) => e.usage.cacheRead));
      const cacheWrite = sumOrNull(ok.map((e) => e.usage.cacheWrite));
      const b = boot.get(c);
      const scored = ok.filter((e) => typeof e.correct === 'number');
      const perCall = setup.get(`${model}\u0000${c}`);
      const requests = cs.filter((x) => x.class !== 'retry' && x.usage);
      const allInput = sumOf(cs.map((x) => x.usage?.input ?? null));
      conditions.push({
        model, condition: c, answered: ok.length, failed: eps.length - ok.length,
        perEpisode: {
          median: median(totals), q1: median(totals, 0.25), q3: median(totals, 0.75), mean: b && totals.length ? b.estimate : null,
          ...(b?.diff && baseline ? { vsBaseline: { ...b.diff, baseline } } : {}),
        },
        sums: {
          input, cacheRead, cacheWrite, uncachedInput: cacheRead === null && cacheWrite === null ? null : input - (cacheRead ?? 0) - (cacheWrite ?? 0),
          output: sumOf(ok.map((e) => e.usage.output)), reasoning: sumOrNull(ok.map((e) => e.usage.reasoning)), total: sumOf(ok.map((e) => e.total)),
        },
        failedTotal: sumOf(eps.filter((e) => e.outcome === 'failed').map((e) => e.total)),
        classShare,
        calls: cs.filter((x) => x.class !== 'retry').length,
        repairCalls: cs.filter((x) => x.class === 'repair').length,
        repeatReadCalls: cs.filter((x) => x.class === 'repeat-read').length,
        retries: cs.filter((x) => x.class === 'retry').length,
        setup: perCall === undefined ? null : { perCall, share: allInput ? (perCall * requests.length) / allInput : null },
        unmapped: eps.reduce((s, e) => s + e.unmapped, 0),
        correctness: options.outcomes ? (scored.length ? { mean: scored.reduce((s, e) => s + (e.correct as number), 0) / scored.length, n: scored.length } : null) : null,
      });
    }
  }
  return { rules: ACCOUNTING_RULES, settings: { seed, resamples, ...(options.baseline ? { baseline: options.baseline } : {}) }, conditions, episodes, calls, problems };
}

const fmt = (x: number | null | undefined, digits = 0) => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
const ci = (i: Interval | null | undefined) => (i ? `${fmt(i.mean)} [${fmt(i.ci[0])}, ${fmt(i.ci[1])}]` : '-');

export function tokenReportText(r: TokenReport): string {
  const lines = ['# Token accounting', '', ...r.rules.map((x) => `- ${x}`), '',
    `Intervals: paired bootstrap, ${r.settings.resamples} resamples, seed ${r.settings.seed}, documents then tasks resampled.`, ''];
  for (const model of [...new Set(r.conditions.map((c) => c.model))]) {
    const rows = r.conditions.filter((c) => c.model === model);
    lines.push(`## ${model}`, '',
      '| Condition | Answered | Failed | Median per episode (IQR) | Mean per episode [95% CI] | vs baseline [95% CI] | Correct | Uncached in | Cache read | Cache write | Output | Reasoning | Failed spend | Calls | Repair | Repeat read | Retries | Setup per call |',
      '|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|');
    for (const c of rows) {
      lines.push(`| ${c.condition} | ${c.answered} | ${c.failed} | ${fmt(c.perEpisode.median)} (${fmt(c.perEpisode.q1)}–${fmt(c.perEpisode.q3)}) | ${ci(c.perEpisode.mean)} | ${c.perEpisode.vsBaseline ? `${ci(c.perEpisode.vsBaseline)} vs ${c.perEpisode.vsBaseline.baseline}` : '-'} | ${c.correctness ? `${pct(c.correctness.mean)} (n ${c.correctness.n})` : '-'} | ${fmt(c.sums.uncachedInput)} | ${fmt(c.sums.cacheRead)} | ${fmt(c.sums.cacheWrite)} | ${fmt(c.sums.output)} | ${fmt(c.sums.reasoning)} | ${fmt(c.failedTotal)} | ${c.calls} | ${c.repairCalls} | ${c.repeatReadCalls} | ${c.retries} | ${c.setup ? `${fmt(c.setup.perCall)} (${pct(c.setup.share)} of input)` : '-'} |`);
    }
    lines.push('', `Share of tokens by call class (${CALL_CLASSES.join(', ')}):`, '');
    for (const c of rows) lines.push(`- ${c.condition}: ${CALL_CLASSES.map((k) => `${k} ${pct(c.classShare[k])}`).join(', ')}`);
    lines.push('');
  }
  if (r.problems.length) lines.push('## Problems', '', ...r.problems.map((p) => `- ${p}`), '');
  return lines.join('\n');
}

/** One row per model, condition, document and task: mean total tokens and mean correctness beside each other. */
export function byTaskCsv(r: TokenReport): string {
  const groups = new Map<string, Episode[]>();
  for (const e of r.episodes) {
    if (e.outcome !== 'answered') continue;
    const k = [e.model, e.condition, e.doc, e.task].join('\u0000');
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = ['model,condition,doc,task,episodes,mean_total_tokens,mean_correct'];
  for (const [k, eps] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const totals = eps.map((e) => e.total).filter((x): x is number => x !== null);
    const scored = eps.map((e) => e.correct).filter((x): x is number => typeof x === 'number');
    rows.push([...k.split('\u0000').map(q), eps.length, totals.length ? (totals.reduce((s, x) => s + x, 0) / totals.length).toFixed(1) : '',
      scored.length ? (scored.reduce((s, x) => s + x, 0) / scored.length).toFixed(3) : ''].join(','));
  }
  return rows.join('\n') + '\n';
}
