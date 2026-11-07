import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tokenizer } from '../../src/core';
import { loadTokenizer } from '../../src/tokenizer';
import { renderDoc, type Rendered } from './conditions';
import { agreement, agreementText, type PairsFile } from './agreement';
import { compareMarks, marksText } from './marks';
import { DEFAULT_CORPUS, loadCorpus } from './corpus';
import { accountRun, byTaskCsv, tokenReportText } from './accounting';
import { defaultDeps, probeSetup, runEval, type RunConfig, type RunDeps } from './runner';
import { outcomesCsv, parseAnswers, scoreAnswers, summaryText, type JudgedRecord, type Outcome } from './score';
import { mapCorpus, spanReportText, spansOk } from './spans';
import { survival, survivalText } from './survival';
import { validateCorpus, validationText } from './validate';

/**
 * The evaluation harness (see README.md). Only `run` calls a model, with an explicit config and keys from the
 * environment; every other command sends nothing anywhere.
 *
 *   npm run eval -- validate [corpus] [--json]
 *   npm run eval -- render [corpus] --out <dir> [--tokenizer o200k_base]
 *   npm run eval -- check [corpus] [--json] [--out <dir>]
 *   npm run eval -- map-spans [corpus] [--write] [--json]
 *   npm run eval -- agreement [corpus] --a <file> --b <file> [--pairs <file>] [--json] [--out <dir>]
 *   npm run eval -- compare-marks [corpus] --other <dir> [--json] [--out <dir>]
 *   npm run eval -- run [corpus] --config <run.json> --out <dir> [--dry-run | --setup-probe] [--docs a,b] [--tasks a,b] [--conditions a,b] [--runs n] [--limit n] [--concurrency n]
 *   npm run eval -- tokens <run dir> [--out <dir>] [--scored outcomes.json] [--model <label>] [--seed 1] [--resamples 2000] [--baseline M1] [--json]
 *   npm run eval -- score <corpus> <answers.jsonl> --out <dir> [--seed 1] [--resamples 2000] [--baseline M1] [--judged judged.jsonl] [--model <label>]
 *
 * The corpus defaults to research/corpus/. Relative paths are read from the folder npm was run in.
 */

const USAGE = `Usage:
  npm run eval -- validate [corpus] [--json]
  npm run eval -- render [corpus] --out <dir> [--tokenizer <name>]
  npm run eval -- check [corpus] [--json] [--out <dir>]
  npm run eval -- map-spans [corpus] [--write] [--json]
  npm run eval -- agreement [corpus] --a <file> --b <file> [--pairs <file>] [--json] [--out <dir>]
  npm run eval -- compare-marks [corpus] --other <dir> [--json] [--out <dir>]
  npm run eval -- run [corpus] --config <run.json> --out <dir> [--dry-run | --setup-probe] [--docs <a,b>] [--tasks <a,b>] [--conditions <a,b>] [--runs <n>] [--limit <n>] [--concurrency <n>]
  npm run eval -- score <corpus> <answers.jsonl> --out <dir> [--seed <n>] [--resamples <n>] [--baseline <condition>] [--judged <file>] [--model <label>]
  npm run eval -- tokens <run dir> [--out <dir>] [--scored <outcomes.json>] [--model <label>] [--seed <n>] [--resamples <n>] [--baseline <condition>] [--json]
`;

const VALUE_FLAGS = new Set([
  '--out', '--tokenizer', '--seed', '--resamples', '--baseline', '--judged', '--model',
  '--a', '--b', '--pairs', '--scored', '--other', '--config', '--docs', '--tasks', '--conditions', '--runs', '--limit', '--concurrency',
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
      const judgedFile = flags.get('--judged');
      const judged = typeof judgedFile === 'string' ? (parseJudged(fs.readFileSync(resolvePath(judgedFile), 'utf8'))) : undefined;
      const result = scoreAnswers(corpus, records, {
        seed: numberFlag(flags, '--seed'), resamples: numberFlag(flags, '--resamples'),
        baseline: typeof flags.get('--baseline') === 'string' ? flags.get('--baseline') as string : undefined, judged,
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
    default:
      log(USAGE);
      return command ? 1 : 0;
  }
}

export function parseJudged(text: string): JudgedRecord[] {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as JudgedRecord);
}

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
