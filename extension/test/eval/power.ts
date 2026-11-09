import {
  DEFAULT_RESAMPLES, equivalenceVerdict, nonInferiorityVerdict, pairedBootstrap, seededRandom, type Outcome,
} from './score';

/**
 * Simulated power for Study 1's correctness comparison (AF34): documents, and tasks nested in documents, each task
 * answered under a reference condition and a comparison condition. Every simulated data set is analysed the way the
 * scorer analyses real answers, so the power is the power of the analysis the study will report. Deterministic for a
 * seed. Nothing here calls a model.
 *
 * The outcome model is logit-normal. For document d, task t, condition c (0 = reference, 1 = comparison) and run r:
 *
 *   logit P(correct) = beta_c + u_dc + v_dtc,     u_dc ~ N(0, su2), v_dtc ~ N(0, sv2)
 *
 * where corr(u_d0, u_d1) = docCorr and corr(v_dt0, v_dt1) = taskCorr: a document or a task that is hard under one
 * condition tends to be hard under the other, which is what the paired analysis exploits. `icc` and `taskIcc` are the
 * shares of the latent variance (with the logistic residual pi^2 / 3) that documents and tasks hold. beta_0 and beta_1
 * are set so the marginal accuracy is `accuracy` under the reference and `accuracy + diff` under the comparison.
 */

export const POWER_METHODS = ['scorer', 'cluster', 'bootstrap'] as const;
export type PowerMethod = (typeof POWER_METHODS)[number];

export interface PowerModel {
  /** Marginal correctness under the reference condition, 0 to 1. */
  accuracy: number;
  /** True marginal difference, comparison minus reference (e.g. -0.05). */
  diff: number;
  /** Latent-scale share of variance between documents (intra-cluster correlation of the latent outcome). */
  icc: number;
  /** Latent-scale share of variance between tasks within a document. icc + taskIcc < 1. */
  taskIcc: number;
  /** Correlation of a document's effect between the two conditions. 1 means the document effect cancels in the difference. */
  docCorr: number;
  /** Correlation of a task's effect between the two conditions. */
  taskCorr: number;
  /** Answers per task and condition; a unit's score is their mean, as in the scorer. */
  runs: number;
}

/** Planning defaults. They are placeholders for the pilot's estimates, not findings. */
export const DEFAULT_MODEL: PowerModel = { accuracy: 0.8, diff: 0, icc: 0.1, taskIcc: 0.3, docCorr: 0.5, taskCorr: 0.5, runs: 1 };

export interface PowerOptions {
  /** Non-inferiority margin, a share. Without it no non-inferiority power is given. */
  niMargin?: number;
  /** Two-sided equivalence margin, a share. */
  equivalenceMargin?: number;
  /** One-sided significance of each test; the interval is the two-sided 1 - 2 alpha one (0.025 gives the scorer's 95%). */
  alpha?: number;
  sims?: number;
  seed?: number;
  method?: PowerMethod;
  /** Resamples per data set for method `bootstrap`. */
  resamples?: number;
}

export const POWER_DEFAULTS = { alpha: 0.025, sims: 1000, seed: 1, method: 'scorer' as PowerMethod };

export interface PowerRow {
  docs: number;
  tasksPerDoc: number;
  units: number;
  sims: number;
  /** Share of data sets judged non-inferior; null without a margin. */
  nonInferiority: number | null;
  /** Share judged equivalent; null without a margin. */
  equivalence: number | null;
  /** Share whose interval excludes 0 (a difference in either direction). */
  difference: number;
  /** Monte Carlo standard error of a power near 0.5 is largest; this is the one for nonInferiority (else difference). */
  mcError: number;
  meanDiff: number;
  meanHalfWidth: number;
}

// ---------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------

const expit = (x: number) => 1 / (1 + Math.exp(-x));
const RESIDUAL = (Math.PI * Math.PI) / 3;

/** A standard normal grid with weights summing to 1, for expectations over a normal random effect. */
function normalGrid(points: number, span = 7): { z: Float64Array; w: Float64Array } {
  const z = new Float64Array(points);
  const w = new Float64Array(points);
  const h = (2 * span) / (points - 1);
  let sum = 0;
  for (let i = 0; i < points; i++) {
    z[i] = -span + i * h;
    w[i] = Math.exp(-0.5 * z[i] * z[i]);
    sum += w[i];
  }
  for (let i = 0; i < points; i++) w[i] /= sum;
  return { z, w };
}

const GRID = normalGrid(401);
const GRID2 = normalGrid(81);

/** beta with E[expit(beta + sd Z)] = target, Z standard normal. */
export function calibrateIntercept(target: number, sd: number): number {
  if (!(target > 0 && target < 1)) throw new Error(`an accuracy of ${target} cannot be simulated: it must be between 0 and 1`);
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    let m = 0;
    for (let k = 0; k < GRID.z.length; k++) m += GRID.w[k] * expit(mid + sd * GRID.z[k]);
    if (m < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The latent standard deviations of the document and task effects. */
export function latentSds(model: Pick<PowerModel, 'icc' | 'taskIcc'>): { doc: number; task: number } {
  const k = RESIDUAL / (1 - model.icc - model.taskIcc);
  return { doc: Math.sqrt(model.icc * k), task: Math.sqrt(model.taskIcc * k) };
}

/** Acklam's inverse of the standard normal distribution function. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error('normalQuantile needs 0 < p < 1');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function logGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const gj of g) ser += gj / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued fraction for the regularized incomplete beta function (Numerical Recipes). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(a, b, x)) / a : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Student t distribution function. */
export function tCdf(t: number, df: number): number {
  const tail = 0.5 * regularizedBeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** Student t quantile, by bisection. */
export function tQuantile(p: number, df: number): number {
  let lo = -1e3;
  let hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A standard normal draw (Box-Muller) from a uniform source. */
function gaussian(random: () => number): number {
  let u = random();
  while (u <= 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** A pair of standard normals with correlation rho. */
function correlated(random: () => number, rho: number): [number, number] {
  const a = gaussian(random);
  const b = gaussian(random);
  return [a, rho * a + Math.sqrt(Math.max(0, 1 - rho * rho)) * b];
}

/** A 32-bit seed from several numbers, so each design cell has its own reproducible stream. */
function mixSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export function checkModel(model: PowerModel): PowerModel {
  const share = (v: number, name: string) => {
    if (!Number.isFinite(v) || v < 0 || v >= 1) throw new Error(`${name} must be at least 0 and below 1`);
  };
  if (!(model.accuracy > 0 && model.accuracy < 1)) throw new Error('the reference accuracy must be between 0 and 1');
  const other = model.accuracy + model.diff;
  if (!(other > 0 && other < 1)) throw new Error(`accuracy + diff is ${other.toFixed(3)}: it must be between 0 and 1`);
  share(model.icc, 'icc');
  share(model.taskIcc, 'task icc');
  if (model.icc + model.taskIcc >= 1) throw new Error('icc + task icc must be below 1 (the rest is the answer-level residual)');
  for (const [v, name] of [[model.docCorr, 'doc corr'], [model.taskCorr, 'task corr']] as const) {
    if (!Number.isFinite(v) || v < -1 || v > 1) throw new Error(`${name} must be between -1 and 1`);
  }
  if (!Number.isInteger(model.runs) || model.runs < 1) throw new Error('runs must be a whole number of at least 1');
  return model;
}

/** What the simulation needs from a model, worked out once. */
interface Prepared { beta: [number, number]; sd: { doc: number; task: number }; model: PowerModel }

function prepare(model: PowerModel): Prepared {
  checkModel(model);
  const sd = latentSds(model);
  const total = Math.sqrt(sd.doc * sd.doc + sd.task * sd.task);
  return { beta: [calibrateIntercept(model.accuracy, total), calibrateIntercept(model.accuracy + model.diff, total)], sd, model };
}

/** One simulated data set: per document, each task's unit score under the reference and the comparison. */
export interface SimulatedData { reference: Float64Array[]; comparison: Float64Array[] }

export function simulate(model: PowerModel, docs: number, tasksPerDoc: number, random: () => number, prepared = prepare(model)): SimulatedData {
  const { beta, sd } = prepared;
  const { runs, docCorr, taskCorr } = model;
  const reference: Float64Array[] = [];
  const comparison: Float64Array[] = [];
  for (let d = 0; d < docs; d++) {
    const [u0, u1] = correlated(random, docCorr);
    const ref = new Float64Array(tasksPerDoc);
    const cmp = new Float64Array(tasksPerDoc);
    for (let t = 0; t < tasksPerDoc; t++) {
      const [v0, v1] = correlated(random, taskCorr);
      const p0 = expit(beta[0] + sd.doc * u0 + sd.task * v0);
      const p1 = expit(beta[1] + sd.doc * u1 + sd.task * v1);
      let s0 = 0;
      let s1 = 0;
      for (let r = 0; r < runs; r++) {
        if (random() < p0) s0++;
        if (random() < p1) s1++;
      }
      ref[t] = s0 / runs;
      cmp[t] = s1 / runs;
    }
    reference.push(ref);
    comparison.push(cmp);
  }
  return { reference, comparison };
}

// ---------------------------------------------------------------------------
// Analysis of one data set
// ---------------------------------------------------------------------------

/** Per-document unit differences (comparison minus reference). */
const differences = (data: SimulatedData) => data.comparison.map((c, d) => c.map((x, t) => x - data.reference[d][t]));

/**
 * The variance of the scorer's two-stage bootstrap distribution of the mean paired difference, worked out exactly
 * instead of by resampling (delta method for the ratio when documents have different numbers of tasks). Stage 1 draws
 * documents, stage 2 draws tasks within each, so the variance is between-document plus within-document over n:
 *
 *   V = [ (1/D) sum_d (S_d - m n_d)^2 + (1/D) sum_d n_d w_d ] / (D nbar^2)
 *
 * with S_d the document's sum of differences, n_d its tasks, w_d the within-document variance (divisor n_d) and m
 * the mean difference.
 */
export function scorerVariance(diffs: readonly ArrayLike<number>[]): { mean: number; variance: number } {
  const D = diffs.length;
  let N = 0;
  let total = 0;
  for (const doc of diffs) for (let i = 0; i < doc.length; i++) { total += doc[i]; N++; }
  const m = total / N;
  let between = 0;
  let within = 0;
  for (const doc of diffs) {
    const n = doc.length;
    let s = 0;
    for (let i = 0; i < n; i++) s += doc[i];
    between += (s - m * n) ** 2;
    const mean = s / n;
    let w = 0;
    for (let i = 0; i < n; i++) w += (doc[i] - mean) ** 2;
    within += w; // n_d * w_d, with w_d's divisor n_d
  }
  const nbar = N / D;
  return { mean: m, variance: (between / D + within / D) / (D * nbar * nbar) };
}

/** The cluster-robust (documents as clusters) variance of the mean difference, with the D / (D - 1) correction. */
export function clusterVariance(diffs: readonly ArrayLike<number>[]): { mean: number; variance: number } {
  const D = diffs.length;
  let N = 0;
  let total = 0;
  for (const doc of diffs) for (let i = 0; i < doc.length; i++) { total += doc[i]; N++; }
  const m = total / N;
  let between = 0;
  for (const doc of diffs) {
    let s = 0;
    for (let i = 0; i < doc.length; i++) s += doc[i];
    between += (s - m * doc.length) ** 2;
  }
  return { mean: m, variance: (D / (D - 1)) * between / (N * N) };
}

/** The difference and its 1 - 2 alpha interval, by one of the methods. */
export function analyse(data: SimulatedData, method: PowerMethod, alpha: number, bootstrap: { seed: number; resamples: number } = { seed: 1, resamples: DEFAULT_RESAMPLES }): { diff: number; ci: [number, number] } {
  if (method === 'bootstrap') {
    const ref = new Map<string, number>();
    const cmp = new Map<string, number>();
    data.reference.forEach((doc, d) => doc.forEach((x, t) => {
      const unit = `d${d}\u0000t${t}`;
      ref.set(unit, x);
      cmp.set(unit, data.comparison[d][t]);
    }));
    const out = pairedBootstrap(new Map([['reference', ref], ['comparison', cmp]]), { ...bootstrap, baseline: 'reference', level: 1 - 2 * alpha });
    const diff = out.get('comparison')!.diff!;
    return { diff: diff.mean, ci: diff.ci };
  }
  const diffs = differences(data);
  const { mean, variance } = method === 'scorer' ? scorerVariance(diffs) : clusterVariance(diffs);
  const q = method === 'scorer' ? normalQuantile(1 - alpha) : tQuantile(1 - alpha, Math.max(1, diffs.length - 1));
  const half = q * Math.sqrt(variance);
  return { diff: mean, ci: [mean - half, mean + half] };
}

export const METHOD_TEXT: Record<PowerMethod, string> = {
  scorer: 'normal approximation with the exact variance of the scorer\'s two-stage paired bootstrap (documents, then tasks within them)',
  cluster: 'cluster-robust interval with documents as clusters (one-stage, D / (D - 1) correction, t with D - 1 degrees of freedom)',
  bootstrap: 'the scorer\'s own seeded paired bootstrap (pairedBootstrap), percentile interval',
};

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

export function power(model: PowerModel, docs: number, tasksPerDoc: number, options: PowerOptions = {}): PowerRow {
  const alpha = options.alpha ?? POWER_DEFAULTS.alpha;
  const sims = options.sims ?? POWER_DEFAULTS.sims;
  const seed = options.seed ?? POWER_DEFAULTS.seed;
  const method = options.method ?? POWER_DEFAULTS.method;
  if (!(alpha > 0 && alpha < 0.5)) throw new Error('alpha must be between 0 and 0.5 (one-sided)');
  if (!Number.isInteger(sims) || sims < 1) throw new Error('sims must be a whole number of at least 1');
  if (!Number.isInteger(docs) || docs < 2) throw new Error('documents must be a whole number of at least 2');
  if (!Number.isInteger(tasksPerDoc) || tasksPerDoc < 1) throw new Error('tasks per document must be a whole number of at least 1');
  if (!POWER_METHODS.includes(method)) throw new Error(`method is one of ${POWER_METHODS.join(', ')}`);
  const prepared = prepare(model);
  const random = seededRandom(mixSeed(seed, docs, tasksPerDoc));
  let ni = 0;
  let eq = 0;
  let dif = 0;
  let sumDiff = 0;
  let sumHalf = 0;
  for (let s = 0; s < sims; s++) {
    const data = simulate(model, docs, tasksPerDoc, random, prepared);
    const { diff, ci } = analyse(data, method, alpha, { seed: mixSeed(seed, docs, tasksPerDoc, s), resamples: options.resamples ?? DEFAULT_RESAMPLES });
    if (options.niMargin !== undefined && nonInferiorityVerdict(ci, options.niMargin) === 'non-inferior') ni++;
    if (options.equivalenceMargin !== undefined && equivalenceVerdict(ci, options.equivalenceMargin) === 'equivalent') eq++;
    if (ci[0] > 0 || ci[1] < 0) dif++;
    sumDiff += diff;
    sumHalf += (ci[1] - ci[0]) / 2;
  }
  const nonInferiority = options.niMargin === undefined ? null : ni / sims;
  const p = nonInferiority ?? dif / sims;
  return {
    docs, tasksPerDoc, units: docs * tasksPerDoc, sims,
    nonInferiority, equivalence: options.equivalenceMargin === undefined ? null : eq / sims, difference: dif / sims,
    mcError: Math.sqrt((p * (1 - p)) / sims), meanDiff: sumDiff / sims, meanHalfWidth: sumHalf / sims,
  };
}

export function powerGrid(model: PowerModel, docsList: readonly number[], tasksList: readonly number[], options: PowerOptions = {}): PowerRow[] {
  return docsList.flatMap((d) => tasksList.map((t) => power(model, d, t, options)));
}

// ---------------------------------------------------------------------------
// Pilot estimates
// ---------------------------------------------------------------------------

export interface PilotEstimate {
  reference: string;
  /** Mean correctness over the reference's units. */
  accuracy: number;
  docs: number;
  units: number;
  /** Mean answers per unit. */
  runs: number;
  /** One-way ANOVA intra-class correlation of the reference's unit scores within documents (observed scale, at least 0). */
  observedIcc: number;
  /** The latent-scale icc whose model-implied observed ICC matches, at the given task icc. */
  icc: number;
  /** True when the observed ICC was above what the model can reach and the latent icc was capped. */
  capped: boolean;
  /** The comparison's mean paired difference, when a comparison condition is given (descriptive only). */
  comparison?: { condition: string; diff: number; units: number };
}

/** One-way ANOVA intra-class correlation of grouped values, truncated at 0. */
export function anovaIcc(groups: readonly number[][]): number {
  const k = groups.length;
  const N = groups.reduce((s, g) => s + g.length, 0);
  if (k < 2 || N <= k) return 0;
  const grand = groups.reduce((s, g) => s + g.reduce((a, b) => a + b, 0), 0) / N;
  let ssb = 0;
  let ssw = 0;
  for (const g of groups) {
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    ssb += g.length * (m - grand) ** 2;
    for (const x of g) ssw += (x - m) ** 2;
  }
  const msb = ssb / (k - 1);
  const msw = ssw / (N - k);
  const n0 = (N - groups.reduce((s, g) => s + g.length * g.length, 0) / N) / (k - 1);
  const denominator = msb + (n0 - 1) * msw;
  if (denominator <= 0) return 0;
  return Math.max(0, (msb - msw) / denominator);
}

/** The observed-scale ICC of unit scores (means of `runs` answers) within documents that the model implies. */
export function impliedObservedIcc(model: Pick<PowerModel, 'accuracy' | 'icc' | 'taskIcc' | 'runs'>): number {
  const sd = latentSds(model);
  const beta = calibrateIntercept(model.accuracy, Math.sqrt(sd.doc * sd.doc + sd.task * sd.task));
  const { z, w } = GRID2;
  const n = z.length;
  const byDoc = new Float64Array(n);
  let mu = 0;
  let second = 0;
  let bernoulli = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < n; j++) {
      const p = expit(beta + sd.doc * z[i] + sd.task * z[j]);
      m += w[j] * p;
      second += w[i] * w[j] * p * p;
      bernoulli += w[i] * w[j] * p * (1 - p);
    }
    byDoc[i] = m;
    mu += w[i] * m;
  }
  let between = 0;
  for (let i = 0; i < n; i++) between += w[i] * (byDoc[i] - mu) ** 2;
  const unitVariance = second - mu * mu + bernoulli / model.runs;
  return unitVariance > 0 ? between / unitVariance : 0;
}

/** The latent icc whose implied observed ICC is `observed`, holding the task share and runs. */
export function latentIccFor(observed: number, model: Pick<PowerModel, 'accuracy' | 'taskIcc' | 'runs'>): { icc: number; capped: boolean } {
  if (observed <= 0) return { icc: 0, capped: false };
  const top = (1 - model.taskIcc) * 0.995;
  if (impliedObservedIcc({ ...model, icc: top }) < observed) return { icc: top, capped: true };
  let lo = 0;
  let hi = top;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (impliedObservedIcc({ ...model, icc: mid }) < observed) lo = mid;
    else hi = mid;
  }
  return { icc: (lo + hi) / 2, capped: false };
}

/**
 * Planning values from a scored pilot (the scorer's outcomes.json): the reference's accuracy and its document ICC,
 * converted to the model's latent scale at the given task share. Answers still waiting for a judge are left out.
 */
export function estimatePilot(outcomes: readonly Outcome[], reference: string, taskIcc: number, comparison?: string): PilotEstimate {
  const units = (condition: string) => {
    const sums = new Map<string, { doc: string; sum: number; n: number }>();
    for (const o of outcomes) {
      if (o.condition !== condition || o.correct === null) continue;
      const key = `${o.doc}\u0000${o.task}`;
      const u = sums.get(key) ?? { doc: o.doc, sum: 0, n: 0 };
      u.sum += o.correct;
      u.n++;
      sums.set(key, u);
    }
    return sums;
  };
  const ref = units(reference);
  if (!ref.size) throw new Error(`the pilot has no scored answers for the reference condition ${reference}`);
  const byDoc = new Map<string, number[]>();
  let total = 0;
  let answers = 0;
  for (const u of ref.values()) {
    byDoc.set(u.doc, [...(byDoc.get(u.doc) ?? []), u.sum / u.n]);
    total += u.sum / u.n;
    answers += u.n;
  }
  const accuracy = total / ref.size;
  const runs = Math.max(1, Math.round(answers / ref.size));
  const observedIcc = anovaIcc([...byDoc.values()]);
  const clamped = Math.min(Math.max(accuracy, 0.001), 0.999);
  const { icc, capped } = latentIccFor(observedIcc, { accuracy: clamped, taskIcc, runs });
  const out: PilotEstimate = { reference, accuracy, docs: byDoc.size, units: ref.size, runs, observedIcc, icc, capped };
  if (comparison) {
    const cmp = units(comparison);
    const shared = [...cmp.keys()].filter((k) => ref.has(k));
    if (!shared.length) throw new Error(`the pilot has no units scored under both ${reference} and ${comparison}`);
    const diff = shared.reduce((s, k) => s + cmp.get(k)!.sum / cmp.get(k)!.n - ref.get(k)!.sum / ref.get(k)!.n, 0) / shared.length;
    out.comparison = { condition: comparison, diff, units: shared.length };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface PowerReport {
  model: PowerModel;
  latent: { docSd: number; taskSd: number; beta: [number, number] };
  settings: { alpha: number; level: number; sims: number; seed: number; method: PowerMethod; resamples?: number; niMargin: number | null; equivalenceMargin: number | null };
  pilot?: PilotEstimate & { file?: string };
  rows: PowerRow[];
}

export function powerReport(model: PowerModel, docsList: readonly number[], tasksList: readonly number[], options: PowerOptions = {}, pilot?: PowerReport['pilot']): PowerReport {
  const prepared = prepare(model);
  const alpha = options.alpha ?? POWER_DEFAULTS.alpha;
  const method = options.method ?? POWER_DEFAULTS.method;
  return {
    model,
    latent: { docSd: prepared.sd.doc, taskSd: prepared.sd.task, beta: prepared.beta },
    settings: {
      alpha, level: 1 - 2 * alpha, sims: options.sims ?? POWER_DEFAULTS.sims, seed: options.seed ?? POWER_DEFAULTS.seed, method,
      ...(method === 'bootstrap' ? { resamples: options.resamples ?? DEFAULT_RESAMPLES } : {}),
      niMargin: options.niMargin ?? null, equivalenceMargin: options.equivalenceMargin ?? null,
    },
    ...(pilot ? { pilot } : {}),
    rows: powerGrid(model, docsList, tasksList, options),
  };
}

const f = (x: number | null, digits = 3) => (x === null ? '-' : x.toFixed(digits));
const pct = (x: number) => `${(x * 100).toFixed(1)} points`;

export function powerText(r: PowerReport): string {
  const { model: m, settings: s } = r;
  const out = ['# Simulated power', ''];
  if (r.pilot) {
    const p = r.pilot;
    out.push(
      `Pilot${p.file ? ` ${p.file}` : ''}: ${p.reference} correct ${f(p.accuracy)} over ${p.units} units in ${p.docs} documents, ${p.runs} answer(s) per unit. `
        + `Observed document ICC ${f(p.observedIcc)}, latent icc ${f(p.icc)} at task icc ${f(m.taskIcc, 2)}${p.capped ? ' (capped: the model cannot reach the observed ICC)' : ''}.`
        + (p.comparison ? ` ${p.comparison.condition} minus ${p.reference}: ${f(p.comparison.diff)} over ${p.comparison.units} units (descriptive; the pilot is not part of the confirmatory analysis).` : ''),
      '',
    );
  }
  out.push(
    `Model: logit-normal, tasks nested in documents. Reference accuracy ${f(m.accuracy)}, true difference ${f(m.diff)} (comparison minus reference), `
      + `icc ${f(m.icc, 2)}, task icc ${f(m.taskIcc, 2)}, doc corr ${f(m.docCorr, 2)}, task corr ${f(m.taskCorr, 2)}, ${m.runs} answer(s) per unit. `
      + `Latent SDs: document ${f(r.latent.docSd)}, task ${f(r.latent.taskSd)}.`,
    `Analysis: ${METHOD_TEXT[s.method]}${s.resamples ? `, ${s.resamples} resamples` : ''}. ${(s.level * 100).toFixed(0)}% interval, alpha ${s.alpha} one-sided per test.`,
    `${s.sims} simulated data sets per row, seed ${s.seed}.`,
    `Non-inferiority margin: ${s.niMargin === null ? 'not set (no non-inferiority power)' : pct(s.niMargin)}. Equivalence margin: ${s.equivalenceMargin === null ? 'not set' : pct(s.equivalenceMargin)}. `
      + 'Margins are planning values until the study owner sets them after the pilot.',
    '',
    'Power is the share of data sets where: non-inferiority, the lower bound is above -margin; equivalence, the interval is inside (-margin, margin); difference, the interval excludes 0. ± is the Monte Carlo standard error.',
    '',
    '| documents | tasks per document | units | non-inferiority | equivalence | difference | mean difference | mean half-width |',
    '|-|-|-|-|-|-|-|-|',
  );
  for (const row of r.rows) {
    const withError = (x: number | null) => (x === null ? '-' : `${f(x)} ± ${f(Math.sqrt((x * (1 - x)) / row.sims))}`);
    out.push(`| ${row.docs} | ${row.tasksPerDoc} | ${row.units} | ${withError(row.nonInferiority)} | ${withError(row.equivalence)} | ${withError(row.difference)} | ${f(row.meanDiff)} | ${f(row.meanHalfWidth)} |`);
  }
  return out.join('\n') + '\n';
}
