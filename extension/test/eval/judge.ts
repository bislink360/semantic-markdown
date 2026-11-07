import * as fs from 'node:fs';
import * as path from 'node:path';
import { cohensKappa, type Kappa } from './agreement';
import { estimate } from './corpus';
import { extractJson } from './prompts';
import { addUsage, checkConfig, contentText, DEFAULTS, post, redact, RequestError, type ModelConfig, type RunConfig, type RunDeps } from './runner';
import { seededRandom, type JudgedRecord, type JudgePacket } from './score';

/**
 * The model judge and its human check (Study 1, "Scoring"). `judge` sends each blinded packet from `score` to one
 * model with a fixed rubric prompt and writes `judged.jsonl`, which `score --judged` reads. `sample` draws the packets
 * a person scores blind. `judge-agreement` compares the judge with the people and lists the tasks to rescore.
 *
 * A packet holds the task, the rubric, the annotated items as plain Markdown and the answer, never the condition, so
 * the judge stays blind. Only `judge` sends anything, and only with an explicit config and a key from the environment.
 */

// ---------------------------------------------------------------------------
// Packets and verdicts
// ---------------------------------------------------------------------------

/** Pass or fail on a judged share: an answer passes when it meets at least half of its rubric. */
export const PASS_AT = 0.5;
/** A task is rescored by people when judge and people disagree on more than this share of its sampled answers. */
export const RESCORE_ABOVE = 0.2;
export const DEFAULT_SHARE = 0.15;

export function parsePackets(text: string): JudgePacket[] {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    const p = JSON.parse(l) as JudgePacket;
    if (typeof p?.packet !== 'string' || !p.task?.id) throw new Error(`packets line ${i + 1}: needs "packet" and "task"`);
    return p;
  });
}

/** Reads judged or human scores (JSON lines). `correct` must be 0 to 1; later lines for a packet replace earlier ones. */
export function parseJudged(text: string, label = 'judged'): JudgedRecord[] {
  const byPacket = new Map<string, JudgedRecord>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let r: JudgedRecord;
    try { r = JSON.parse(line) as JudgedRecord; } catch (e) { throw new Error(`${label} line ${i + 1}: ${(e as Error).message}`); }
    if (typeof r?.packet !== 'string') throw new Error(`${label} line ${i + 1}: needs "packet"`);
    if (typeof r.correct !== 'number' || !(r.correct >= 0 && r.correct <= 1)) throw new Error(`${label} line ${i + 1}: "correct" must be a number from 0 to 1`);
    if (r.violation !== undefined && typeof r.violation !== 'boolean') throw new Error(`${label} line ${i + 1}: "violation" must be true or false`);
    byPacket.set(r.packet, r);
  });
  return [...byPacket.values()];
}

export const JUDGE_SYSTEM_PROMPT = [
  'You score one answer to a question about a project document against a rubric.',
  'You see the question, the rubric, the passages of the document the rubric is about, and the answer. Judge only what the answer says against those passages. Length and style do not earn credit: a short answer that meets a criterion meets it, and a long one that misses it misses it.',
  'A criterion is met when the answer states what it asks, in any wording, without contradicting the passages.',
  'The answer breaks a constraint when it states or recommends something a passage forbids or limits, or contradicts a passage marked as a constraint, negation or limit.',
  'Finish with only one JSON object: {"criteria": {"<criterion id>": true or false, ...}, "violation": true or false, "reason": "<one sentence>"}. Give every criterion id.',
].join('\n');

/** The judge's user message for one packet. */
export function judgeMessage(p: JudgePacket): string {
  return [
    `Question: ${p.task.prompt}`, '',
    'Rubric:', ...p.rubric.map((r) => `- ${r.id}: ${r.text}`), '',
    'Passages:', ...p.items.flatMap((i) => [`<passage id="${i.id}" kind="${i.kind}">`, i.text.replace(/\n$/, ''), '</passage>']), '',
    '<answer>', p.answer, '</answer>',
  ].join('\n');
}

export interface JudgeVerdict extends JudgedRecord {
  criteria: Record<string, boolean>;
  reason?: string;
  /** `<label>:<model id>` of the judge. */
  judge: string;
  usage?: Record<string, number>;
}

/**
 * Reads the judge's reply. `correct` is the share of rubric criteria met, computed here rather than taken from the
 * judge. A reply without a boolean for every criterion is an error, not a guess.
 */
export function parseVerdict(text: string, p: JudgePacket): { criteria: Record<string, boolean>; correct: number; violation: boolean; reason?: string } | { error: string } {
  const obj = extractJson(text);
  if (!obj) return { error: 'the reply has no JSON object' };
  const raw = obj.criteria;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the reply has no "criteria" object' };
  const criteria: Record<string, boolean> = {};
  for (const r of p.rubric) {
    const v = (raw as Record<string, unknown>)[r.id];
    if (typeof v !== 'boolean') return { error: `criterion ${r.id} is not true or false` };
    criteria[r.id] = v;
  }
  if (typeof obj.violation !== 'boolean') return { error: '"violation" is not true or false' };
  const met = Object.values(criteria).filter(Boolean).length;
  return {
    criteria, correct: p.rubric.length ? met / p.rubric.length : 0, violation: obj.violation,
    ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

export interface JudgeOptions {
  packets: JudgePacket[];
  config: RunConfig;
  out: string;
  /** The judge model's label; needed when the config lists more than one model. */
  model?: string;
  dryRun?: boolean;
  limit?: number;
  concurrency?: number;
}

export interface JudgeSummary { planned: number; skipped: number; judged: number; failed: number; dryRun: boolean }

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function pickJudge(config: RunConfig, label?: string): ModelConfig {
  const models = checkConfig(config).models;
  if (label) {
    const m = models.find((x) => x.label === label);
    if (!m) throw new Error(`no model ${label} in the config`);
    return m;
  }
  if (models.length !== 1) throw new Error('the config lists several models; pick the judge with --model <label>');
  return models[0];
}

function requestBody(m: ModelConfig, p: JudgePacket): Record<string, unknown> {
  return {
    model: m.model, [m.outputLimitField ?? DEFAULTS.outputLimitField]: m.maxOutputTokens ?? DEFAULTS.maxOutputTokens, ...(m.extraBody ?? {}),
    messages: [{ role: 'system', content: JUDGE_SYSTEM_PROMPT }, { role: 'user', content: judgeMessage(p) }],
  };
}

/** Judges every packet not yet in `<out>/judged.jsonl`. Failures go to `judge-errors.jsonl` and are tried again next time. */
export async function runJudge(options: JudgeOptions, deps: RunDeps): Promise<JudgeSummary> {
  const m = pickJudge(options.config, options.model);
  const judge = `${m.label}:${m.model}`;
  const judgedFile = path.join(options.out, 'judged.jsonl');
  const done = new Set(fs.existsSync(judgedFile) ? parseJudged(fs.readFileSync(judgedFile, 'utf8')).map((r) => r.packet) : []);
  const seen = new Set<string>();
  const pending = options.packets.filter((p) => !done.has(p.packet) && !seen.has(p.packet) && seen.add(p.packet));
  const skipped = options.packets.length - pending.length;
  const jobs = options.limit !== undefined ? pending.slice(0, Math.max(0, options.limit)) : pending;
  const summary: JudgeSummary = { planned: options.packets.length, skipped, judged: 0, failed: 0, dryRun: !!options.dryRun };
  const url = `${m.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  if (options.dryRun) {
    const tokens = jobs.reduce((s, p) => s + estimate(JUDGE_SYSTEM_PROMPT + judgeMessage(p)), 0);
    const maxOut = m.maxOutputTokens ?? DEFAULTS.maxOutputTokens;
    const cost = m.price ? [(tokens * m.price.inputPerMTok) / 1e6, (tokens * m.price.inputPerMTok + jobs.length * maxOut * m.price.outputPerMTok) / 1e6] : undefined;
    if (jobs.length) writeFile(path.join(options.out, 'judge-dry-run', 'request.json'), JSON.stringify({ url, note: 'The Authorization header is left out.', body: requestBody(m, jobs[0]) }, null, 2) + '\n');
    writeFile(path.join(options.out, 'judge-dry-run', 'plan.json'), JSON.stringify({ judge, requests: jobs.length, skipped, inputTokensEstimate: tokens, ...(cost ? { costEstimate: { low: cost[0], high: cost[1] } } : {}) }, null, 2) + '\n');
    deps.log([
      'Dry run: nothing is sent and no key is read.',
      `${jobs.length} packet(s) to judge with ${judge}${skipped ? `, ${skipped} already in judged.jsonl` : ''}.`,
      `Estimated input ≈ ${tokens} tokens (characters / 4)${cost ? `, est. cost $${cost[0].toFixed(4)} – $${cost[1].toFixed(4)}` : ''}.`,
      `Wrote ${path.join(options.out, 'judge-dry-run')}`,
    ].join('\n') + '\n');
    return summary;
  }

  const key = deps.env[m.apiKeyEnv];
  if (!key) throw new Error(`model ${m.label}: the environment variable ${m.apiKeyEnv} is not set. Set it to the provider's key (it is never written anywhere), or use --dry-run.`);
  fs.mkdirSync(options.out, { recursive: true });
  const settings = { timeoutMs: m.timeoutMs ?? options.config.timeoutMs ?? DEFAULTS.timeoutMs, retries: options.config.retries ?? DEFAULTS.retries };
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const p = jobs[i];
      const body = requestBody(m, p);
      const transcript: Record<string, unknown> = { judge, packet: p.packet, startedAt: deps.now().toISOString(), request: body };
      const where = `[${i + 1}/${jobs.length}] ${p.packet}`;
      let error: string | undefined;
      try {
        const res = await post(url, key, body, settings, deps);
        const usage: Record<string, number> = {};
        addUsage(usage, res.json.usage);
        const text = contentText(res.json.choices?.[0]?.message?.content);
        Object.assign(transcript, { response: { id: res.json.id, model: res.json.model, finish_reason: res.json.choices?.[0]?.finish_reason, status: res.status, attempts: res.attempts, latencyMs: res.latencyMs }, usage, final: text });
        const v = parseVerdict(text, p);
        if ('error' in v) error = v.error;
        else {
          const row: JudgeVerdict = { packet: p.packet, correct: v.correct, violation: v.violation, criteria: v.criteria, ...(v.reason ? { reason: v.reason } : {}), judge, usage };
          fs.appendFileSync(judgedFile, redact(JSON.stringify(row), key) + '\n');
          summary.judged++;
          deps.log(`${where}: ${v.correct.toFixed(2)}${v.violation ? ', violation' : ''}\n`);
        }
      } catch (e) {
        error = (e as Error).message;
        transcript.failures = e instanceof RequestError ? e.failures : [];
      }
      transcript.finishedAt = deps.now().toISOString();
      if (error) {
        summary.failed++;
        transcript.error = error;
        fs.appendFileSync(path.join(options.out, 'judge-errors.jsonl'), redact(JSON.stringify({ at: deps.now().toISOString(), judge, packet: p.packet, error }), key) + '\n');
        deps.log(`${where}: failed: ${redact(error, key)}\n`);
      }
      writeFile(path.join(options.out, 'judge-transcripts', safe(m.label), `${safe(p.packet)}${error ? '.failed' : ''}.json`), redact(JSON.stringify(transcript, null, 2), key) + '\n');
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? options.config.concurrency ?? DEFAULTS.concurrency, jobs.length)) }, worker));
  deps.log(`${summary.judged} judged, ${summary.failed} failed, ${summary.skipped} already in judged.jsonl. Verdicts: ${judgedFile}\n`);
  return summary;
}

// ---------------------------------------------------------------------------
// sample
// ---------------------------------------------------------------------------

/**
 * The packets a person scores blind, in a seeded order. With `share`, the draw is stratified by task (at least one
 * answer of every task, then `share` of each task's answers rounded up), so every task can be checked for the
 * rescoring rule. With `count`, it is a plain random draw of that many packets (the 50 hand-scored answers).
 */
export function samplePackets(packets: JudgePacket[], options: { share?: number; count?: number; seed?: number }): JudgePacket[] {
  if (options.share !== undefined && options.count !== undefined) throw new Error('give --share or --count, not both');
  const random = seededRandom((options.seed ?? 1) ^ 0x27d4eb2d);
  const shuffled = packets.map((p) => ({ p, r: random() })).sort((a, b) => a.r - b.r).map((x) => x.p);
  if (options.count !== undefined) {
    if (!Number.isInteger(options.count) || options.count < 1) throw new Error('--count needs a whole number of at least 1');
    return shuffled.slice(0, options.count);
  }
  const share = options.share ?? DEFAULT_SHARE;
  if (!(share > 0 && share <= 1)) throw new Error('--share needs a number above 0 and at most 1');
  const byTask = new Map<string, JudgePacket[]>();
  for (const p of shuffled) byTask.set(p.task.id, [...(byTask.get(p.task.id) ?? []), p]);
  const keep = new Set([...byTask.values()].flatMap((list) => list.slice(0, Math.max(1, Math.ceil(list.length * share)))).map((p) => p.packet));
  return shuffled.filter((p) => keep.has(p.packet));
}

/** A plain text sheet for a person: each packet with its rubric, passages and answer, and nothing about the condition. */
export function scoringSheet(packets: JudgePacket[]): string {
  const out = [
    '# Blind scoring sheet',
    '',
    `${packets.length} answer(s). Score each one against its rubric using only the passages, without looking up which condition produced it. Write one line per answer to a JSON lines file:`,
    '',
    '```json',
    '{"packet": "<id>", "correct": <share of criteria met, 0 to 1>, "violation": <true or false>, "criteria": {"<criterion id>": true}}',
    '```',
    '',
    'An answer breaks a constraint when it states or recommends something a passage forbids or limits.',
  ];
  for (const p of packets) {
    out.push('', `## ${p.packet}`, '', `**Question:** ${p.task.prompt}`, '', '**Rubric:**', '', ...p.rubric.map((r) => `- \`${r.id}\` ${r.text}`), '', '**Passages:**', '');
    for (const i of p.items) out.push(`- \`${i.id}\` (${i.kind}):`, '', ...i.text.replace(/\n$/, '').split('\n').map((l) => `  > ${l}`), '');
    out.push('**Answer:**', '', ...p.answer.split('\n').map((l) => `> ${l}`));
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// judge-agreement
// ---------------------------------------------------------------------------

export interface TaskAgreement { task: string; n: number; disagreements: number; share: number; rescore: boolean; packets: string[] }

export interface JudgeAgreement {
  /** Packets both the judge and a person scored. */
  n: number;
  /** Human rows with no judge verdict, and judge rows outside the sample are not compared. */
  missingJudge: string[];
  unknownPackets: string[];
  rules: { passAt: number; rescoreAbove: number; disagreement: string };
  correct: { meanAbsDiff: number | null; meanJudgeMinusHuman: number | null; pass: Kappa };
  violation: Kappa;
  /** Answer length (estimated tokens) against judge minus human: a positive slope means the judge favours long answers. */
  length: { pearson: number | null; longerHalfBias: number | null; shorterHalfBias: number | null };
  tasks: TaskAgreement[];
  rescore: string[];
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const pass = (x: number) => (x >= PASS_AT ? 'pass' : 'fail');

/** Judge against people on the packets both scored; flags tasks where they disagree on more than a fifth of answers. */
export function judgeAgreement(packets: JudgePacket[], judged: JudgedRecord[], human: JudgedRecord[]): JudgeAgreement {
  const byPacket = new Map(packets.map((p) => [p.packet, p]));
  const judge = new Map(judged.map((j) => [j.packet, j]));
  const missingJudge: string[] = [];
  const unknownPackets: string[] = [];
  const pairs: Array<{ p: JudgePacket; j: JudgedRecord; h: JudgedRecord }> = [];
  for (const h of human) {
    const p = byPacket.get(h.packet);
    if (!p) { unknownPackets.push(h.packet); continue; }
    const j = judge.get(h.packet);
    if (!j) { missingJudge.push(h.packet); continue; }
    pairs.push({ p, j, h });
  }
  const disagree = (j: JudgedRecord, h: JudgedRecord) => pass(j.correct) !== pass(h.correct) || !!j.violation !== !!h.violation;
  const tasks = new Map<string, TaskAgreement>();
  for (const { p, j, h } of pairs) {
    const t = tasks.get(p.task.id) ?? { task: p.task.id, n: 0, disagreements: 0, share: 0, rescore: false, packets: [] };
    t.n++;
    t.packets.push(p.packet);
    if (disagree(j, h)) t.disagreements++;
    tasks.set(p.task.id, t);
  }
  for (const t of tasks.values()) {
    t.share = t.disagreements / t.n;
    t.rescore = t.share > RESCORE_ABOVE;
  }
  const lengths = pairs.map(({ p }) => estimate(p.answer));
  const diffs = pairs.map(({ j, h }) => j.correct - h.correct);
  const median = [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)];
  const sorted = [...tasks.values()].sort((a, b) => b.share - a.share || a.task.localeCompare(b.task));
  return {
    n: pairs.length, missingJudge, unknownPackets,
    rules: { passAt: PASS_AT, rescoreAbove: RESCORE_ABOVE, disagreement: `pass/fail differs (pass is correct ≥ ${PASS_AT}) or the violation verdict differs` },
    correct: {
      meanAbsDiff: mean(diffs.map(Math.abs)), meanJudgeMinusHuman: mean(diffs),
      pass: cohensKappa(pairs.map(({ j, h }) => [pass(j.correct), pass(h.correct)])),
    },
    violation: cohensKappa(pairs.map(({ j, h }) => [String(!!j.violation), String(!!h.violation)])),
    length: {
      pearson: pearson(lengths, diffs),
      longerHalfBias: mean(diffs.filter((_, i) => lengths[i] > median)),
      shorterHalfBias: mean(diffs.filter((_, i) => lengths[i] <= median)),
    },
    tasks: sorted,
    rescore: sorted.filter((t) => t.rescore).map((t) => t.task),
  };
}

const num = (x: number | null | undefined, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(d));

export function judgeAgreementText(r: JudgeAgreement): string {
  const out = [
    '# Judge and human agreement',
    '',
    `${r.n} answer(s) scored by both. A disagreement is: ${r.rules.disagreement}. A task is rescored by people when they disagree on more than ${r.rules.rescoreAbove * 100}% of its answers.`,
    '',
    '| measure | value |',
    '|-|-|',
    `| pass/fail agreement | ${num(r.correct.pass.observed)} |`,
    `| pass/fail kappa | ${num(r.correct.pass.kappa)}${r.correct.pass.note ? ` (${r.correct.pass.note})` : ''} |`,
    `| mean absolute difference in correct | ${num(r.correct.meanAbsDiff)} |`,
    `| mean judge minus human | ${num(r.correct.meanJudgeMinusHuman)} |`,
    `| violation agreement | ${num(r.violation.observed)} |`,
    `| violation kappa | ${num(r.violation.kappa)}${r.violation.note ? ` (${r.violation.note})` : ''} |`,
    `| answer length vs judge minus human (Pearson r) | ${num(r.length.pearson)} |`,
    `| judge minus human, longer half / shorter half | ${num(r.length.longerHalfBias)} / ${num(r.length.shorterHalfBias)} |`,
    '',
    `Tasks to rescore by people: ${r.rescore.length ? r.rescore.join(', ') : 'none'}.`,
    '',
    '| task | answers | disagreements | share | rescore |',
    '|-|-|-|-|-|',
    ...r.tasks.map((t) => `| ${t.task} | ${t.n} | ${t.disagreements} | ${num(t.share, 2)} | ${t.rescore ? 'yes' : ''} |`),
  ];
  if (r.missingJudge.length) out.push('', `Human scores with no judge verdict (not compared): ${r.missingJudge.join(', ')}.`);
  if (r.unknownPackets.length) out.push('', `Human scores for packets not in the packets file: ${r.unknownPackets.join(', ')}.`);
  return out.join('\n') + '\n';
}
