import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tokenizer } from '../../src/core';
import { loadTokenizer } from '../../src/tokenizer';
import { renderDoc, type Rendered } from './conditions';
import { agreement, agreementText, type PairsFile } from './agreement';
import { compareMarks, marksText } from './marks';
import { DEFAULT_CORPUS, loadCorpus } from './corpus';
import { accountRun, byTaskCsv, tokenReportText } from './accounting';
import { checkAnalysis, defaultDeps, probeSetup, runEval, type RunConfig, type RunDeps } from './runner';
import { judgeAgreement, judgeAgreementText, parseJudged, parsePackets, runJudge, samplePackets, scoringSheet } from './judge';
import { checkMargin, outcomesCsv, parseAnswers, scoreAnswers, summaryText, type JudgedRecord, type Outcome } from './score';
import { DEFAULT_MODEL, estimatePilot, POWER_DEFAULTS, POWER_METHODS, powerReport, powerText, type PowerMethod, type PowerModel, type PowerReport } from './power';
import { mapCorpus, spanReportText, spansOk } from './spans';
import { outlineUse, outlineUseText } from './outlineUse';
import { survival, survivalText } from './survival';
import { validateCorpus, validationText } from './validate';

/**
 * The evaluation harness (see README.md). Only `run` and `judge` call a model, with an explicit config and keys from
 * the environment; every other command sends nothing anywhere.
 *
 *   npm run eval -- validate [corpus] [--json]
 *   npm run eval -- render [corpus] --out <dir> [--tokenizer o200k_base]
 *   npm run eval -- check [corpus] [--json] [--out <dir>]
 *   npm run eval -- map-spans [corpus] [--write] [--json]
 *   npm run eval -- agreement [corpus] --a <file> --b <file> [--pairs <file>] [--json] [--out <dir>]
 *   npm run eval -- compare-marks [corpus] --other <dir> [--json] [--out <dir>]
 *   npm run eval -- run [corpus] --config <run.json> --out <dir> [--dry-run | --setup-probe] [--docs a,b] [--tasks a,b] [--conditions a,b] [--runs n] [--limit n] [--concurrency n]
 *   npm run eval -- tokens <run dir> [--out <dir>] [--scored outcomes.json] [--model <label>] [--seed 1] [--resamples 2000] [--baseline M1] [--json]
 *   npm run eval -- outline-use <run dir> [--out <dir>] [--model <label>] [--json]
 *   npm run eval -- score <corpus> <answers.jsonl> --out <dir> [--seed 1] [--resamples 2000] [--baseline M1] [--judged a.jsonl,b.jsonl] [--model <label>] [--ni-margin 0.05] [--eq-margin 0.05] [--config <run.json>]
 *   npm run eval -- power [--accuracy 0.8] [--diff 0] [--ni-margin 0.05] [--eq-margin 0.05] [--docs 12,24] [--tasks 10] [--runs 1] [--icc 0.1] [--task-icc 0.3] [--doc-corr 0.5] [--task-corr 0.5] [--alpha 0.025] [--sims 1000] [--seed 1] [--method scorer|cluster|bootstrap] [--pilot outcomes.json --reference M1 [--condition S3]] [--out <dir>] [--json]
 *   npm run eval -- judge <judge-packets.jsonl> --config <run.json> --out <dir> [--model <label>] [--dry-run] [--limit n] [--concurrency n]
 *   npm run eval -- sample <judge-packets.jsonl> --out <dir> [--share 0.15 | --count 50] [--seed 1]
 *   npm run eval -- judge-agreement <judge-packets.jsonl> --judged <file> --human <file> [--out <dir>] [--json]
 *
 * The corpus defaults to research/data/corpus/. Relative paths are read from the folder npm was run in.
 */

const USAGE = `Usage:
  npm run eval -- validate [corpus] [--json]
  npm run eval -- render [corpus] --out <dir> [--tokenizer <name>]
  npm run eval -- check [corpus] [--json] [--out <dir>]
  npm run eval -- map-spans [corpus] [--write] [--json]
  npm run eval -- agreement [corpus] --a <file> --b <file> [--pairs <file>] [--json] [--out <dir>]
  npm run eval -- compare-marks [corpus] --other <dir> [--json] [--out <dir>]
  npm run eval -- run [corpus] --config <run.json> --out <dir> [--dry-run | --setup-probe] [--docs <a,b>] [--tasks <a,b>] [--conditions <a,b>] [--runs <n>] [--limit <n>] [--concurrency <n>]
  npm run eval -- score <corpus> <answers.jsonl> --out <dir> [--seed <n>] [--resamples <n>] [--baseline <condition>] [--judged <files>] [--model <label>] [--ni-margin <share>] [--eq-margin <share>] [--config <run.json>]
  npm run eval -- power [--accuracy <0..1>] [--diff <share>] [--ni-margin <share>] [--eq-margin <share>] [--docs <n,n>] [--tasks <n,n>] [--runs <n>] [--icc <0..1>] [--task-icc <0..1>] [--doc-corr <-1..1>] [--task-corr <-1..1>] [--alpha <one-sided>] [--sims <n>] [--seed <n>] [--method scorer|cluster|bootstrap] [--resamples <n>] [--pilot <outcomes.json> [--reference <condition>] [--condition <condition>]] [--out <dir>] [--json]
  npm run eval -- tokens <run dir> [--out <dir>] [--scored <outcomes.json>] [--model <label>] [--seed <n>] [--resamples <n>] [--baseline <condition>] [--json]
  npm run eval -- outline-use <run dir> [--out <dir>] [--model <label>] [--json]
  npm run eval -- judge <judge-packets.jsonl> --config <run.json> --out <dir> [--model <label>] [--dry-run] [--limit <n>] [--concurrency <n>]
  npm run eval -- sample <judge-packets.jsonl> --out <dir> [--share <0..1> | --count <n>] [--seed <n>]
  npm run eval -- judge-agreement <judge-packets.jsonl> --judged <files> --human <files> [--out <dir>] [--json]
`;

const VALUE_FLAGS = new Set([
  '--out', '--tokenizer', '--seed', '--resamples', '--baseline', '--judged', '--model',
  '--a', '--b', '--pairs', '--scored', '--other', '--config', '--docs', '--tasks', '--conditions', '--runs', '--limit', '--concurrency', '--human', '--share', '--count',
  '--ni-margin', '--eq-margin', '--accuracy', '--diff', '--icc', '--task-icc', '--doc-corr', '--task-corr', '--alpha', '--sims', '--method', '--pilot', '--reference', '--condition',
]);

interface Parsed { command?: string; positional: string[]; flags: Map<string, string | true> }

export function parseArgs(args: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(a, v);
    } else if (a.startsWith('--')) flags.set(a, true);
    else positional.push(a);
  }
  return { command: positional.shift(), positional, flags };
}

/** npm runs scripts in extension/; paths are read from where it was started. */
const resolvePath = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

const numberFlag = (flags: Parsed['flags'], name: string) => {
  const v = flags.get(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} needs a whole number`);
  return n;
};

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/** Writes every condition's text and a manifest with token estimates and metadata (no text). */
export function renderCorpus(corpusDir: string, out: string, tokenizer?: Tokenizer): { files: number } {
  const corpus = loadCorpus(corpusDir);
  const manifest: Array<Omit<Rendered, 'text' | 'shown' | 'transcript'> & { file: string }> = [];
  const put = (r: Rendered, rel: string) => {
    write(path.join(out, rel), r.text);
    const { text: _t, shown: _s, transcript: _x, ...rest } = r;
    manifest.push({ ...rest, file: rel.split(path.sep).join('/') });
  };
  for (const doc of corpus.docs) {
    const { doc: views, tasks } = renderDoc(corpus, doc, tokenizer);
    for (const r of views) put(r, path.join(doc.name, `${r.condition}.txt`));
    for (const [task, list] of tasks) for (const r of list) put(r, path.join(doc.name, task, `${r.condition}.txt`));
  }
  write(path.join(out, 'manifest.json'), JSON.stringify({
    corpus: corpus.dir, version: corpus.config.version ?? null, today: corpus.config.today ?? null,
    tokens: tokenizer ? `estimate (≈ characters / 4) and ${tokenizer.name}; neither is provider usage` : 'estimate (≈ characters / 4), not provider usage',
    conditions: manifest,
  }, null, 2) + '\n');
  return { files: manifest.length };
}

const stringFlag = (flags: Parsed['flags'], name: string) => (typeof flags.get(name) === 'string' ? flags.get(name) as string : undefined);
const listFlag = (flags: Parsed['flags'], name: string) => stringFlag(flags, name)?.split(',').map((s) => s.trim()).filter(Boolean);
const readJsonFile = (file: string) => JSON.parse(fs.readFileSync(resolvePath(file), 'utf8').replace(/^﻿/, ''));

/**
 * Runs one command. `run` returns a promise (it waits on the network); the others return the exit code at once.
 * `deps` replaces the runner's network, environment and clock, for tests.
 */
export function main(args: string[], log: (s: string) => void = (s) => process.stdout.write(s), deps?: Partial<RunDeps>): number | Promise<number> {
  const { command, positional, flags } = parseArgs(args);
  const corpusDir = positional[0] ? resolvePath(positional[0]) : DEFAULT_CORPUS;
  const out = typeof flags.get('--out') === 'string' ? resolvePath(flags.get('--out') as string) : undefined;
  switch (command) {
    case 'map-spans': {
      const writeFiles = flags.has('--write');
      const report = mapCorpus(loadCorpus(corpusDir), writeFiles);
      log(flags.has('--json') ? JSON.stringify(report, null, 2) + '\n' : spanReportText(report, writeFiles));
      return spansOk(report) ? 0 : 1;
    }
    case 'agreement': {
      const a = stringFlag(flags, '--a');
      const b = stringFlag(flags, '--b');
      if (!a || !b) throw new Error('agreement needs --a <file> --b <file> (file names inside each document folder)');
      const pairsFile = stringFlag(flags, '--pairs');
      const report = agreement(corpusDir, a, b, pairsFile ? readJsonFile(pairsFile) as PairsFile : undefined, pairsFile);
      const text = agreementText(report);
      if (out) {
        write(path.join(out, 'agreement.json'), JSON.stringify(report, null, 2) + '\n');
        write(path.join(out, 'agreement.md'), text);
      }
      log(flags.has('--json') ? JSON.stringify(report, null, 2) + '\n' : text);
      return 0;
    }
    case 'compare-marks': {
      const other = stringFlag(flags, '--other');
      if (!other) throw new Error('compare-marks needs --other <dir> (a folder of <doc>/doc.smd re-marked from doc.md)');
      const report = compareMarks(corpusDir, resolvePath(other));
      const text = marksText(report);
      if (out) {
        write(path.join(out, 'marker-comparison.json'), JSON.stringify(report, null, 2) + '\n');
        write(path.join(out, 'marker-comparison.md'), text);
      }
      log(flags.has('--json') ? JSON.stringify(report, null, 2) + '\n' : text);
      return 0;
    }
    case 'run': {
      const configFile = stringFlag(flags, '--config');
      if (!configFile || !out) throw new Error('run needs --config <run.json> --out <dir>');
      if (flags.has('--setup-probe')) {
        if (flags.has('--dry-run')) throw new Error('--setup-probe sends requests; it cannot be combined with --dry-run');
        return probeSetup({ corpusDir, config: readJsonFile(configFile) as RunConfig, out, conditions: listFlag(flags, '--conditions') }, { ...defaultDeps(log), ...deps })
          .then((s) => (s.failed ? 1 : 0));
      }
      return runEval({
        corpusDir, config: readJsonFile(configFile) as RunConfig, out, configFile: resolvePath(configFile), dryRun: flags.has('--dry-run'),
        docs: listFlag(flags, '--docs'), tasks: listFlag(flags, '--tasks'), conditions: listFlag(flags, '--conditions'),
        runs: numberFlag(flags, '--runs'), limit: numberFlag(flags, '--limit'), concurrency: numberFlag(flags, '--concurrency'),
      }, { ...defaultDeps(log), ...deps }).then((s) => (s.failed ? 1 : 0));
    }
    case 'validate': {
      const report = validateCorpus(loadCorpus(corpusDir));
      log(flags.has('--json') ? JSON.stringify(report, null, 2) + '\n' : validationText(report));
      return report.ok ? 0 : 1;
    }
    case 'render': {
      if (!out) throw new Error('render needs --out <dir>');
      const name = flags.get('--tokenizer');
      const { files } = renderCorpus(corpusDir, out, typeof name === 'string' ? loadTokenizer(name) : undefined);
      log(`Wrote ${files} condition files and manifest.json to ${out}\n`);
      return 0;
    }
    case 'check': {
      const report = survival(loadCorpus(corpusDir));
      const text = survivalText(report);
      if (out) {
        write(path.join(out, 'survival.json'), JSON.stringify(report, null, 2) + '\n');
        write(path.join(out, 'survival.md'), text);
      }
      log(flags.has('--json') ? JSON.stringify(report, null, 2) + '\n' : text);
      return 0;
    }
    case 'score': {
      const answersFile = positional[1];
      if (!positional[0] || !answersFile || !out) throw new Error('score needs <corpus> <answers.jsonl> --out <dir>');
      const corpus = loadCorpus(corpusDir);
      const parsed = parseAnswers(fs.readFileSync(resolvePath(answersFile), 'utf8'));
      const { problems } = parsed;
      // `run` writes model as "<label>:<model id>"; --model keeps one model's answers.
      const only = stringFlag(flags, '--model');
      const records = only ? parsed.records.filter((r) => r.model === only || r.model?.startsWith(`${only}:`)) : parsed.records;
      const judgedFiles = stringFlag(flags, '--judged');
      const judged = judgedFiles ? readJudged(judgedFiles) : undefined;
      // Flags override the run config's "analysis"; without either, no margin is set and no verdict is given.
      const configFile = stringFlag(flags, '--config');
      const analysis = configFile ? checkAnalysis((readJsonFile(configFile) as RunConfig).analysis) : {};
      const result = scoreAnswers(corpus, records, {
        seed: numberFlag(flags, '--seed'), resamples: numberFlag(flags, '--resamples'),
        baseline: stringFlag(flags, '--baseline') ?? analysis.baseline, judged,
        niMargin: numberValue(flags, '--ni-margin') ?? analysis.niMargin,
        equivalenceMargin: numberValue(flags, '--eq-margin') ?? analysis.equivalenceMargin,
      });
      result.problems.unshift(...problems);
      write(path.join(out, 'outcomes.json'), JSON.stringify(result.outcomes, null, 2) + '\n');
      write(path.join(out, 'outcomes.csv'), outcomesCsv(result.outcomes));
      write(path.join(out, 'summary.json'), JSON.stringify({ settings: result.settings, summary: result.summary, problems: result.problems }, null, 2) + '\n');
      write(path.join(out, 'summary.md'), summaryText(result));
      write(path.join(out, 'judge-packets.jsonl'), jsonl(result.packets));
      write(path.join(out, 'judge-key.jsonl'), jsonl(result.key));
      log(summaryText(result));
      return 0;
    }
    case 'power': {
      const report = powerCommand(flags);
      const text = powerText(report);
      if (out) {
        write(path.join(out, 'power.json'), JSON.stringify(report, null, 2) + '\n');
        write(path.join(out, 'power.md'), text);
      }
      log(flags.has('--json') ? JSON.stringify(report, null, 2) + '\n' : text);
      return 0;
    }
    case 'judge': {
      // The packets file is the first positional argument, not a corpus.
      const configFile = stringFlag(flags, '--config');
      if (!positional[0] || !configFile || !out) throw new Error('judge needs <judge-packets.jsonl> --config <run.json> --out <dir>');
      return runJudge({
        packets: readPackets(positional[0]), config: readJsonFile(configFile) as RunConfig, out, model: stringFlag(flags, '--model'),
        dryRun: flags.has('--dry-run'), limit: numberFlag(flags, '--limit'), concurrency: numberFlag(flags, '--concurrency'),
      }, { ...defaultDeps(log), ...deps }).then((s) => (s.failed ? 1 : 0));
    }
    case 'sample': {
      if (!positional[0] || !out) throw new Error('sample needs <judge-packets.jsonl> --out <dir>');
      const picked = samplePackets(readPackets(positional[0]), { share: numberValue(flags, '--share'), count: numberFlag(flags, '--count'), seed: numberFlag(flags, '--seed') });
      write(path.join(out, 'human-packets.jsonl'), jsonl(picked));
      write(path.join(out, 'human-sheet.md'), scoringSheet(picked));
      log(`Drew ${picked.length} packet(s) for blind human scoring: ${path.join(out, 'human-packets.jsonl')} and human-sheet.md\n`);
      return 0;
    }
    case 'judge-agreement': {
      const judgedFiles = stringFlag(flags, '--judged');
      const humanFiles = stringFlag(flags, '--human');
      if (!positional[0] || !judgedFiles || !humanFiles) throw new Error('judge-agreement needs <judge-packets.jsonl> --judged <file> --human <file>');
      const packets = readPackets(positional[0]);
      const report = judgeAgreement(packets, readJudged(judgedFiles), readJudged(humanFiles));
      const text = judgeAgreementText(report);
      if (out) {
        const rescore = packets.filter((p) => report.rescore.includes(p.task.id));
        write(path.join(out, 'judge-agreement.json'), JSON.stringify(report, null, 2) + '\n');
        write(path.join(out, 'judge-agreement.md'), text);
        write(path.join(out, 'rescore-packets.jsonl'), jsonl(rescore));
        write(path.join(out, 'rescore-sheet.md'), scoringSheet(rescore));
      }
      log(flags.has('--json') ? JSON.stringify(report, null, 2) + '\n' : text);
      return 0;
    }
    case 'tokens': {
      // The run folder is the first positional argument, not a corpus.
      if (!positional[0]) throw new Error('tokens needs <run dir> (the --out folder of run)');
      const runDir = resolvePath(positional[0]);
      const scored = stringFlag(flags, '--scored');
      const report = accountRun(runDir, {
        seed: numberFlag(flags, '--seed'), resamples: numberFlag(flags, '--resamples'), baseline: stringFlag(flags, '--baseline'), model: stringFlag(flags, '--model'),
        outcomes: scored ? readJsonFile(scored) as Outcome[] : undefined,
      });
      const text = tokenReportText(report);
      const dir = out ?? path.join(runDir, 'tokens');
      write(path.join(dir, 'calls.jsonl'), jsonl(report.calls));
      write(path.join(dir, 'episodes.jsonl'), jsonl(report.episodes));
      write(path.join(dir, 'tokens.json'), JSON.stringify({ rules: report.rules, settings: report.settings, conditions: report.conditions, problems: report.problems }, null, 2) + '\n');
      write(path.join(dir, 'tokens.md'), text);
      write(path.join(dir, 'by-task.csv'), byTaskCsv(report));
      log(flags.has('--json') ? JSON.stringify({ conditions: report.conditions, problems: report.problems }, null, 2) + '\n' : text);
      return report.episodes.length ? 0 : 1;
    }
    case 'outline-use': {
      // Study 1 "Outline cost use": what S3 agents read after an outline, against the costs it showed.
      if (!positional[0]) throw new Error('outline-use needs <run dir> (the --out folder of run)');
      const runDir = resolvePath(positional[0]);
      const report = outlineUse(runDir, { model: stringFlag(flags, '--model') });
      const text = outlineUseText(report);
      const dir = out ?? path.join(runDir, 'outline-use');
      write(path.join(dir, 'episodes.jsonl'), jsonl(report.episodes));
      write(path.join(dir, 'outline-use.json'), JSON.stringify({ summary: report.summary, problems: report.problems }, null, 2) + '\n');
      write(path.join(dir, 'outline-use.md'), text);
      log(flags.has('--json') ? JSON.stringify({ summary: report.summary, problems: report.problems }, null, 2) + '\n' : text);
      return report.episodes.length ? 0 : 1;
    }
    default:
      log(USAGE);
      return command ? 1 : 0;
  }
}

export { parseJudged };

/** Reads one or more judged files (comma-separated); for a packet in several, the last file wins. */
function readJudged(files: string): JudgedRecord[] {
  const byPacket = new Map<string, JudgedRecord>();
  for (const f of files.split(',').map((s) => s.trim()).filter(Boolean)) {
    for (const r of parseJudged(fs.readFileSync(resolvePath(f), 'utf8'), f)) byPacket.set(r.packet, r);
  }
  return [...byPacket.values()];
}

const readPackets = (file: string) => parsePackets(fs.readFileSync(resolvePath(file), 'utf8'));

/** Whole numbers from a comma-separated flag. */
const integerList = (flags: Parsed['flags'], name: string, fallback: number[]) => {
  const list = listFlag(flags, name);
  if (!list) return fallback;
  return list.map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} takes whole numbers, e.g. 12,24,36`);
    return n;
  });
};

/** The power command's model and settings from its flags, with pilot estimates where a flag does not set the value. */
function powerCommand(flags: Parsed['flags']): PowerReport {
  const method = (stringFlag(flags, '--method') ?? POWER_DEFAULTS.method) as PowerMethod;
  if (!POWER_METHODS.includes(method)) throw new Error(`--method is one of ${POWER_METHODS.join(', ')}`);
  const taskIcc = numberValue(flags, '--task-icc') ?? DEFAULT_MODEL.taskIcc;
  const pilotFile = stringFlag(flags, '--pilot');
  const pilot = pilotFile
    ? { ...estimatePilot(readJsonFile(pilotFile) as Outcome[], stringFlag(flags, '--reference') ?? 'M1', taskIcc, stringFlag(flags, '--condition')), file: pilotFile }
    : undefined;
  const model: PowerModel = {
    accuracy: numberValue(flags, '--accuracy') ?? pilot?.accuracy ?? DEFAULT_MODEL.accuracy,
    diff: numberValue(flags, '--diff') ?? DEFAULT_MODEL.diff,
    icc: numberValue(flags, '--icc') ?? pilot?.icc ?? DEFAULT_MODEL.icc,
    taskIcc,
    docCorr: numberValue(flags, '--doc-corr') ?? DEFAULT_MODEL.docCorr,
    taskCorr: numberValue(flags, '--task-corr') ?? DEFAULT_MODEL.taskCorr,
    runs: numberFlag(flags, '--runs') ?? DEFAULT_MODEL.runs,
  };
  const niMargin = numberValue(flags, '--ni-margin');
  const equivalenceMargin = numberValue(flags, '--eq-margin');
  return powerReport(model, integerList(flags, '--docs', [12, 24, 36]), integerList(flags, '--tasks', [10]), {
    niMargin: niMargin === undefined ? undefined : checkMargin(niMargin, '--ni-margin'),
    equivalenceMargin: equivalenceMargin === undefined ? undefined : checkMargin(equivalenceMargin, '--eq-margin'),
    alpha: numberValue(flags, '--alpha'), sims: numberFlag(flags, '--sims'), seed: numberFlag(flags, '--seed'), method,
    resamples: numberFlag(flags, '--resamples'),
  }, pilot);
}

const numberValue = (flags: Parsed['flags'], name: string) => {
  const v = stringFlag(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} needs a number`);
  return n;
};

if (require.main === module) {
  const fail = (e: unknown) => {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    process.exitCode = 1;
  };
  try {
    Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; }, fail);
  } catch (e) {
    fail(e);
  }
}
