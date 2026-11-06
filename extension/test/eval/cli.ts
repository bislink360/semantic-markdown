import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tokenizer } from '../../src/core';
import { loadTokenizer } from '../../src/tokenizer';
import { renderDoc, type Rendered } from './conditions';
import { DEFAULT_CORPUS, loadCorpus } from './corpus';
import { outcomesCsv, parseAnswers, scoreAnswers, summaryText, type JudgedRecord } from './score';
import { survival, survivalText } from './survival';
import { validateCorpus, validationText } from './validate';

/**
 * The evaluation harness (see README.md). No model is called and nothing leaves the machine.
 *
 *   npm run eval -- validate [corpus] [--json]
 *   npm run eval -- render [corpus] --out <dir> [--tokenizer o200k_base]
 *   npm run eval -- check [corpus] [--json] [--out <dir>]
 *   npm run eval -- score <corpus> <answers.jsonl> --out <dir> [--seed 1] [--resamples 2000] [--baseline M1] [--judged judged.jsonl]
 *
 * The corpus defaults to research/corpus/. Relative paths are read from the folder npm was run in.
 */

const USAGE = `Usage:
  npm run eval -- validate [corpus] [--json]
  npm run eval -- render [corpus] --out <dir> [--tokenizer <name>]
  npm run eval -- check [corpus] [--json] [--out <dir>]
  npm run eval -- score <corpus> <answers.jsonl> --out <dir> [--seed <n>] [--resamples <n>] [--baseline <condition>] [--judged <file>]
`;

const VALUE_FLAGS = new Set(['--out', '--tokenizer', '--seed', '--resamples', '--baseline', '--judged']);

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

export function main(args: string[], log: (s: string) => void = (s) => process.stdout.write(s)): number {
  const { command, positional, flags } = parseArgs(args);
  const corpusDir = positional[0] ? resolvePath(positional[0]) : DEFAULT_CORPUS;
  const out = typeof flags.get('--out') === 'string' ? resolvePath(flags.get('--out') as string) : undefined;
  switch (command) {
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
      const { records, problems } = parseAnswers(fs.readFileSync(resolvePath(answersFile), 'utf8'));
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
    default:
      log(USAGE);
      return command ? 1 : 0;
  }
}

export function parseJudged(text: string): JudgedRecord[] {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as JudgedRecord);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    process.exitCode = 1;
  }
}
