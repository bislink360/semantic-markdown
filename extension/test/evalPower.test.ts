import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './eval/cli';
import { loadCorpus } from './eval/corpus';
import {
  analyse, anovaIcc, DEFAULT_MODEL, estimatePilot, impliedObservedIcc, latentIccFor, normalQuantile, power, powerGrid, simulate, tQuantile, type PowerModel,
} from './eval/power';
import { checkConfig } from './eval/runner';
import { equivalenceVerdict, nonInferiorityVerdict, scoreAnswers, seededRandom, summaryText, type Outcome } from './eval/score';
import type { AnswerRecord, FactLookupTask } from './eval/types';

/** AF34: non-inferiority and equivalence verdicts in the scorer, and simulated power for clustered documents and tasks. */

const fixture = join(__dirname, 'eval', 'fixture');
const model = (extra: Partial<PowerModel> = {}): PowerModel => ({ ...DEFAULT_MODEL, ...extra });

test('AF34: non-inferiority and equivalence verdicts on constructed intervals', () => {
  const m = 0.05;
  assert.equal(nonInferiorityVerdict([-0.04, 0.02], m), 'non-inferior');
  assert.equal(nonInferiorityVerdict([-0.2, -0.06], m), 'inferior');
  assert.equal(nonInferiorityVerdict([-0.08, 0.01], m), 'inconclusive');
  // The boundary itself is not enough: the bound must be strictly above -margin.
  assert.equal(nonInferiorityVerdict([-0.05, 0.01], m), 'inconclusive');
  // Non-inferior and better: superiority is reported by the difference interval, not by this verdict.
  assert.equal(nonInferiorityVerdict([0.01, 0.09], m), 'non-inferior');

  assert.equal(equivalenceVerdict([-0.04, 0.04], m), 'equivalent');
  assert.equal(equivalenceVerdict([-0.04, 0.06], m), 'inconclusive');
  assert.equal(equivalenceVerdict([0.06, 0.2], m), 'not-equivalent');
  assert.equal(equivalenceVerdict([-0.2, -0.06], m), 'not-equivalent');
  // Non-inferior is not equivalent.
  assert.equal(nonInferiorityVerdict([0.01, 0.09], m), 'non-inferior');
  assert.equal(equivalenceVerdict([0.01, 0.09], m), 'inconclusive');
});

/** Fact-lookup answers on the fixture: every condition answers every fact task, right unless `wrong` names it. */
function answers(): AnswerRecord[] {
  const corpus = loadCorpus(fixture);
  const facts = corpus.docs.flatMap((d) => d.tasks.filter((t): t is FactLookupTask => t.type === 'fact-lookup'));
  const plan: Record<string, string[]> = { M1: [], A: [], B: facts.map((t) => t.id), C: [facts[0].id] };
  return Object.entries(plan).flatMap(([condition, wrong]) => facts.flatMap((t) => [1, 2].map((run) => ({
    task: t.id, condition, run, answer: wrong.includes(t.id) ? 'no idea' : t.expected.accepted[0],
  }))));
}

test('AF34: the scorer gives a verdict only when a margin is set, from the paired difference against the baseline', () => {
  const corpus = loadCorpus(fixture);
  const none = scoreAnswers(corpus, answers(), { resamples: 400 });
  assert.equal(none.settings.niMargin, null);
  assert.equal(none.settings.equivalenceMargin, null);
  assert.ok(none.summary.every((c) => c.nonInferiority === undefined && c.equivalence === undefined));
  assert.match(summaryText(none), /No margin set, so no verdict\. The study owner sets it after the pilot/);

  const r = scoreAnswers(corpus, answers(), { resamples: 400, niMargin: 0.1, equivalenceMargin: 0.1 });
  const by = (c: string) => r.summary.find((s) => s.condition === c)!;
  // The reference has no comparison of its own.
  assert.equal(by('M1').nonInferiority, undefined);
  // The same answers: a zero difference, non-inferior and equivalent.
  assert.deepEqual(by('A').vsBaseline!.ci, [0, 0]);
  assert.deepEqual([by('A').nonInferiority!.verdict, by('A').equivalence!.verdict], ['non-inferior', 'equivalent']);
  // Wrong everywhere: inferior and not equivalent.
  assert.deepEqual(by('B').vsBaseline!.ci, [-1, -1]);
  assert.deepEqual([by('B').nonInferiority!.verdict, by('B').equivalence!.verdict], ['inferior', 'not-equivalent']);
  // Wrong on one of four units: the interval holds -margin, so neither claim can be made.
  const c = by('C');
  assert.equal(c.vsBaseline!.mean, -0.25);
  assert.ok(c.vsBaseline!.ci[0] < -0.1 && c.vsBaseline!.ci[1] >= -0.1);
  assert.deepEqual([c.nonInferiority!.verdict, c.equivalence!.verdict], ['inconclusive', 'inconclusive']);
  assert.deepEqual(c.nonInferiority!.ci, c.vsBaseline!.ci);
  // Superiority and difference reporting are unchanged: vsBaseline is still there, with or without margins.
  assert.deepEqual(c.vsBaseline, none.summary.find((s) => s.condition === 'C')!.vsBaseline);

  const text = summaryText(r);
  assert.match(text, /Non-inferiority margin: 10\.0 points\. Equivalence margin: 10\.0 points\./);
  assert.match(text, /^\| B \| -1\.000 \[-1\.000, -1\.000\] n=4 \| inferior \| not-equivalent \|$/m);
  assert.match(text, /^\| C \| -0\.250 .* \| inconclusive \| inconclusive \|$/m);
  assert.throws(() => scoreAnswers(corpus, answers(), { niMargin: 5 }), /share between 0 and 1/);
});

test('AF34: score takes the margins from flags or from "analysis" in a run config, flags first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-eval-ni-'));
  try {
    const file = join(dir, 'answers.jsonl');
    writeFileSync(file, answers().map((a) => JSON.stringify(a)).join('\n') + '\n');
    const config = join(dir, 'run.json');
    const base = { models: [{ label: 'm', model: 'x', baseUrl: 'https://api.example.test/v1', apiKeyEnv: 'K' }] };
    writeFileSync(config, JSON.stringify({ ...base, analysis: { niMargin: 0.1, equivalenceMargin: 0.2 } }));
    const quiet = () => {};
    const settings = (out: string) => JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).settings;

    assert.equal(main(['score', fixture, file, '--out', join(dir, 'a'), '--resamples', '100'], quiet), 0);
    assert.deepEqual([settings(join(dir, 'a')).niMargin, settings(join(dir, 'a')).equivalenceMargin], [null, null]);

    assert.equal(main(['score', fixture, file, '--out', join(dir, 'b'), '--resamples', '100', '--config', config], quiet), 0);
    assert.deepEqual([settings(join(dir, 'b')).niMargin, settings(join(dir, 'b')).equivalenceMargin], [0.1, 0.2]);

    assert.equal(main(['score', fixture, file, '--out', join(dir, 'c'), '--resamples', '100', '--config', config, '--ni-margin', '0.05'], quiet), 0);
    assert.deepEqual([settings(join(dir, 'c')).niMargin, settings(join(dir, 'c')).equivalenceMargin], [0.05, 0.2]);
    assert.match(readFileSync(join(dir, 'c', 'summary.md'), 'utf8'), /Non-inferiority margin: 5\.0 points/);

    // A run config with a bad analysis section is refused, by score and by run's own check.
    writeFileSync(config, JSON.stringify({ ...base, analysis: { niMargin: 5 } }));
    assert.throws(() => main(['score', fixture, file, '--out', join(dir, 'd'), '--config', config], quiet), /analysis\.niMargin must be a share/);
    assert.throws(() => checkConfig({ ...base, analysis: { margin: 0.1 } } as never), /analysis\.margin is not a setting/);
    assert.doesNotThrow(() => checkConfig({ ...base, analysis: { niMargin: 0.05, baseline: 'M1' } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AF34: quantiles', () => {
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normalQuantile(0.025) + 1.959964) < 1e-5);
  assert.ok(Math.abs(tQuantile(0.975, 23) - 2.068658) < 1e-4);
  assert.ok(Math.abs(tQuantile(0.95, 5) - 2.015048) < 1e-4);
});

test('AF34: the simulation hits the requested accuracies and difference on average', () => {
  const random = seededRandom(11);
  const m = model({ accuracy: 0.7, diff: -0.1, runs: 2 });
  let ref = 0;
  let cmp = 0;
  let n = 0;
  for (let s = 0; s < 200; s++) {
    const data = simulate(m, 20, 10, random);
    data.reference.forEach((doc, d) => doc.forEach((x, t) => { ref += x; cmp += data.comparison[d][t]; n++; }));
  }
  assert.ok(Math.abs(ref / n - 0.7) < 0.01, `reference ${ref / n}`);
  assert.ok(Math.abs((cmp - ref) / n + 0.1) < 0.01, `difference ${(cmp - ref) / n}`);
});

test('AF34: at the margin boundary, non-inferiority power is about alpha (cluster method), and the scorer\'s method is not above it', () => {
  const m = model({ diff: -0.05 });
  const sims = 4000;
  const se = Math.sqrt((0.025 * 0.975) / sims);
  const cluster = power(m, 24, 10, { niMargin: 0.05, sims, method: 'cluster', seed: 3 });
  assert.ok(Math.abs(cluster.nonInferiority! - 0.025) < 3 * se + 0.002, `cluster ${cluster.nonInferiority}`);
  // The scorer's two-stage bootstrap counts within-document variance twice, so it is conservative here.
  const scorer = power(m, 24, 10, { niMargin: 0.05, sims, method: 'scorer', seed: 3 });
  assert.ok(scorer.nonInferiority! < 0.025 + 3 * se, `scorer ${scorer.nonInferiority}`);
  assert.ok(scorer.meanHalfWidth > cluster.meanHalfWidth);
});

test('AF34: power grows with the number of documents and tasks', () => {
  const rows = powerGrid(model({ diff: 0, runs: 3 }), [6, 12, 24, 48], [10], { niMargin: 0.1, sims: 400 });
  const ni = rows.map((r) => r.nonInferiority!);
  for (let i = 1; i < ni.length; i++) assert.ok(ni[i] > ni[i - 1], `power by documents: ${ni.join(', ')}`);
  const widths = rows.map((r) => r.meanHalfWidth);
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] < widths[i - 1]);
  const tasks = powerGrid(model({ diff: 0, runs: 3 }), [12], [5, 20], { niMargin: 0.1, sims: 400 });
  assert.ok(tasks[1].nonInferiority! > tasks[0].nonInferiority!);
});

test('AF34: document clustering reduces the effective sample size', () => {
  // The same 240 units: a higher ICC widens the interval.
  const width = (icc: number) => power(model({ icc, diff: 0, runs: 3 }), 24, 10, { niMargin: 0.1, sims: 600, seed: 5 }).meanHalfWidth;
  const widths = [0, 0.2, 0.4].map(width);
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `widths ${widths.join(', ')}`);
  // With strong clustering, spreading the same units over more documents buys more power than more tasks per document.
  const clustered = model({ icc: 0.4, diff: 0, runs: 3 });
  const many = power(clustered, 48, 5, { niMargin: 0.1, sims: 600 });
  const few = power(clustered, 8, 30, { niMargin: 0.1, sims: 600 });
  assert.ok(many.nonInferiority! > few.nonInferiority! + 0.1, `48x5 ${many.nonInferiority} vs 8x30 ${few.nonInferiority}`);
});

test('AF34: power is deterministic for a seed', () => {
  const run = (seed: number) => powerGrid(model({ diff: -0.02 }), [8, 16], [6], { niMargin: 0.05, equivalenceMargin: 0.05, sims: 150, seed });
  assert.deepEqual(run(9), run(9));
  assert.notDeepEqual(run(9), run(10));
  // A row does not depend on which other rows the grid has.
  assert.deepEqual(run(9)[1], powerGrid(model({ diff: -0.02 }), [16], [6], { niMargin: 0.05, equivalenceMargin: 0.05, sims: 150, seed: 9 })[0]);
});

test('AF34: the scorer method matches the scorer\'s own bootstrap interval on simulated data', () => {
  const random = seededRandom(21);
  for (const [docs, tasks, m] of [[12, 10, model({ runs: 1 })], [24, 5, model({ runs: 3, icc: 0.3 })], [8, 20, model({ diff: -0.1 })]] as const) {
    for (let s = 0; s < 3; s++) {
      const data = simulate(m, docs, tasks, random);
      const fast = analyse(data, 'scorer', 0.025);
      const boot = analyse(data, 'bootstrap', 0.025, { seed: 1, resamples: 4000 });
      assert.ok(Math.abs(fast.diff - boot.diff) < 1e-12);
      assert.ok(Math.abs(fast.ci[0] - boot.ci[0]) < 0.015 && Math.abs(fast.ci[1] - boot.ci[1]) < 0.015, `${docs}x${tasks}: ${fast.ci} vs ${boot.ci}`);
    }
  }
  // And the power agrees within Monte Carlo error on a small setting.
  const opts = { niMargin: 0.05, sims: 150, seed: 2 };
  const a = power(model({ diff: 0, runs: 3 }), 12, 8, { ...opts, method: 'scorer' }).nonInferiority!;
  const b = power(model({ diff: 0, runs: 3 }), 12, 8, { ...opts, method: 'bootstrap', resamples: 1000 }).nonInferiority!;
  assert.ok(Math.abs(a - b) < 0.06, `scorer ${a} vs bootstrap ${b}`);
});

test('AF34: ICC estimates from a pilot', () => {
  assert.equal(anovaIcc([[1, 1], [0, 0], [1, 1]]), 1);
  assert.equal(anovaIcc([[1, 0], [1, 0], [0, 1]]), 0);
  assert.equal(anovaIcc([[1]]), 0);
  // The latent icc is the inverse of the observed ICC the model implies.
  const at = { accuracy: 0.75, taskIcc: 0.3, runs: 3 };
  const observed = impliedObservedIcc({ ...at, icc: 0.15 });
  // Averaging runs removes answer-level noise, so the ICC of unit scores grows with runs.
  assert.ok(observed > 0 && observed > impliedObservedIcc({ ...at, runs: 1, icc: 0.15 }));
  assert.ok(Math.abs(latentIccFor(observed, at).icc - 0.15) < 1e-3);
  assert.deepEqual(latentIccFor(0, at), { icc: 0, capped: false });

  // A pilot simulated from a known model: the estimates come back near it.
  const truth = model({ accuracy: 0.75, icc: 0.2, runs: 1 });
  const data = simulate(truth, 200, 10, seededRandom(4));
  const outcomes: Outcome[] = [];
  const outcome = (doc: number, task: number, condition: string, correct: number) => ({ doc: `d${doc}`, task: `t${task}`, condition, run: '1', correct } as Outcome);
  data.reference.forEach((doc, d) => doc.forEach((x, t) => {
    outcomes.push(outcome(d, t, 'M1', x), outcome(d, t, 'S3', data.comparison[d][t]));
  }));
  outcomes.push({ ...outcome(0, 0, 'M1', 0), correct: null });
  const pilot = estimatePilot(outcomes, 'M1', 0.3, 'S3');
  assert.ok(Math.abs(pilot.accuracy - 0.75) < 0.03, `accuracy ${pilot.accuracy}`);
  assert.equal(pilot.docs, 200);
  assert.equal(pilot.runs, 1);
  assert.ok(Math.abs(pilot.observedIcc - impliedObservedIcc(truth)) < 0.04, `observed ${pilot.observedIcc} vs ${impliedObservedIcc(truth)}`);
  assert.ok(Math.abs(pilot.icc - 0.2) < 0.08, `latent ${pilot.icc}`);
  assert.ok(Math.abs(pilot.comparison!.diff) < 0.03);
  assert.throws(() => estimatePilot(outcomes, 'S9', 0.3), /no scored answers for the reference condition S9/);
});

test('AF34: the power command prints a table, writes power.json and reads a pilot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-eval-power-'));
  try {
    let log = '';
    const capture = (s: string) => { log += s; };
    assert.equal(main(['power', '--docs', '6,12', '--tasks', '5', '--sims', '50', '--ni-margin', '0.05', '--diff', '-0.02', '--out', join(dir, 'p')], capture), 0);
    assert.match(log, /^# Simulated power/);
    assert.match(log, /^\| 6 \| 5 \| 30 \| \d\.\d{3} ± \d\.\d{3} \| - \| /m);
    assert.match(log, /^\| 12 \| 5 \| 60 \| /m);
    assert.match(log, /Non-inferiority margin: 5\.0 points\. Equivalence margin: not set\./);
    const report = JSON.parse(readFileSync(join(dir, 'p', 'power.json'), 'utf8'));
    assert.equal(report.rows.length, 2);
    assert.equal(report.settings.method, 'scorer');
    assert.equal(report.settings.level, 0.95);
    assert.ok(existsSync(join(dir, 'p', 'power.md')));

    // Without a margin there is no non-inferiority power, only the difference column.
    log = '';
    assert.equal(main(['power', '--docs', '6', '--tasks', '5', '--sims', '20'], capture), 0);
    assert.match(log, /Non-inferiority margin: not set \(no non-inferiority power\)/);

    // Pilot outcomes (as score writes them) set the accuracy and icc unless flags do.
    const outcomes: Outcome[] = [];
    for (let d = 0; d < 4; d++) for (let t = 0; t < 5; t++) for (const run of ['1', '2', '3']) outcomes.push({ doc: `d${d}`, task: `t${t}`, condition: 'M1', run, correct: d < 2 ? 1 : (t + Number(run)) % 2 } as Outcome);
    const pilotFile = join(dir, 'outcomes.json');
    writeFileSync(pilotFile, JSON.stringify(outcomes));
    log = '';
    assert.equal(main(['power', '--pilot', pilotFile, '--docs', '6', '--tasks', '5', '--sims', '20', '--json'], capture), 0);
    const json = JSON.parse(log);
    assert.equal(json.pilot.reference, 'M1');
    assert.equal(json.pilot.runs, 3);
    assert.equal(json.model.accuracy, json.pilot.accuracy);
    assert.equal(json.model.icc, json.pilot.icc);
    assert.ok(json.pilot.observedIcc > 0);
    log = '';
    assert.equal(main(['power', '--pilot', pilotFile, '--accuracy', '0.9', '--docs', '6', '--tasks', '5', '--sims', '20', '--json'], capture), 0);
    assert.equal(JSON.parse(log).model.accuracy, 0.9);

    assert.throws(() => main(['power', '--method', 'magic'], capture), /--method is one of/);
    assert.throws(() => main(['power', '--accuracy', '0.98', '--diff', '0.05'], capture), /must be between 0 and 1/);
    assert.throws(() => main(['power', '--icc', '0.6', '--task-icc', '0.5'], capture), /icc \+ task icc must be below 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
