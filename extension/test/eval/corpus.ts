import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AnnotationFile, AnnotationItem, CorpusConfig, Evidence, Span, Task, TaskFile } from './types';

/** Loading a corpus folder, and the text helpers the validator, the check and the scorer share. */

export const DOC_FILES = ['doc.md', 'doc.smd', 'annotations.json', 'tasks.json'] as const;

/** `research/data/corpus/` in the repository. */
export const DEFAULT_CORPUS = path.join(__dirname, '..', '..', '..', 'research', 'data', 'corpus');

/** Used when corpus.json gives no `today`. */
export const DEFAULT_TODAY = '2026-01-01';

export interface CorpusDoc {
  /** The folder name. */
  name: string;
  dir: string;
  md: string;
  smd: string;
  annotations: AnnotationFile;
  tasks: Task[];
}

export interface Corpus {
  dir: string;
  config: CorpusConfig;
  docs: CorpusDoc[];
  /** Problems found while loading: a missing file, JSON that does not parse. */
  problems: Array<{ doc: string; message: string }>;
}

/** The document folders of a corpus, sorted; folders starting with `.` or `_` are left out. */
export function docFolders(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

const readText = (file: string) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

export function loadCorpus(dir: string): Corpus {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a corpus folder: ${dir}`);
  const problems: Corpus['problems'] = [];
  const configFile = path.join(root, 'corpus.json');
  let config: CorpusConfig = {};
  if (fs.existsSync(configFile)) {
    try { config = JSON.parse(readText(configFile)) as CorpusConfig; } catch (e) { problems.push({ doc: 'corpus.json', message: `JSON: ${(e as Error).message}` }); }
  }
  const docs: CorpusDoc[] = [];
  for (const name of docFolders(root)) {
    const docDir = path.join(root, name);
    const missing = DOC_FILES.filter((f) => !fs.existsSync(path.join(docDir, f)));
    if (missing.length) { problems.push({ doc: name, message: `missing ${missing.join(', ')}` }); continue; }
    try {
      const annotations = JSON.parse(readText(path.join(docDir, 'annotations.json'))) as AnnotationFile;
      const tasks = (JSON.parse(readText(path.join(docDir, 'tasks.json'))) as TaskFile).tasks;
      docs.push({
        name, dir: docDir, md: readText(path.join(docDir, 'doc.md')), smd: readText(path.join(docDir, 'doc.smd')),
        annotations: { ...annotations, items: Array.isArray(annotations.items) ? annotations.items : [] }, tasks: Array.isArray(tasks) ? tasks : [],
      });
    } catch (e) {
      problems.push({ doc: name, message: `JSON: ${(e as Error).message}` });
    }
  }
  return { dir: root, config, docs, problems };
}

/** Reads includes and code embeds relative to a document, only inside the corpus folder. */
export function corpusReader(corpusDir: string, docDir: string): (rel: string) => string | undefined {
  const root = path.resolve(corpusDir);
  return (rel) => {
    const target = path.resolve(docDir, rel);
    const inside = path.relative(root, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
    return fs.existsSync(target) && fs.statSync(target).isFile() ? readText(target) : undefined;
  };
}

export const linesOf = (text: string) => text.split(/\r?\n/);

/** The text of a 1-based inclusive span. */
export function spanText(text: string, [start, end]: Span): string {
  return linesOf(text).slice(start - 1, end).join('\n');
}

/**
 * Lower case, emphasis and code marks removed, quotes and dashes unified, the spaces around a table cell's `|` dropped
 * (the agent view writes table rows without cell padding; 4.1.0), whitespace collapsed.
 */
export function normalise(s: string): string {
  return s.normalize('NFKC').toLowerCase()
    .replace(/[‘’]/g, '\'').replace(/[“”]/g, '"').replace(/[‐-―−]/g, '-')
    .replace(/[*_`~]+/g, '')
    .replace(/[ \t]*\|[ \t]*/g, '|')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A label for one evidence entry, for reports. */
export const evidenceLabel = (e: Evidence) => (typeof e === 'string' ? `"${e}"` : `/${e.regex}/${e.flags ?? 'i'}`);

/** A regex for one evidence entry; throws if it does not compile. */
export function evidencePattern(e: Evidence): RegExp {
  if (typeof e === 'string') return new RegExp(normalise(e).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // No `g` or `y`: they make test() depend on the previous call.
  return new RegExp(e.regex, (e.flags ?? 'i').replace(/[gy]/g, ''));
}

/** Whether one evidence entry appears in already normalised text. */
export function hasEvidence(normalised: string, e: Evidence): boolean {
  return evidencePattern(e).test(normalised);
}

/** Which evidence entries of an item appear in a text (normalised here). */
export function evidenceFound(text: string, item: Pick<AnnotationItem, 'evidence'>): boolean[] {
  const n = normalise(text);
  return item.evidence.map((e) => hasEvidence(n, e));
}

/** The lines of a list of spans, as a set. */
export function spanLines(spans: Span[]): Set<number> {
  const out = new Set<number>();
  for (const [a, b] of spans) for (let i = a; i <= b; i++) out.add(i);
  return out;
}

export const overlaps = (a: Span, b: Span) => a[0] <= b[1] && b[0] <= a[1];

export const isSpan = (s: unknown): s is Span =>
  Array.isArray(s) && s.length === 2 && s.every((n) => Number.isInteger(n)) && (s[0] as number) >= 1 && (s[0] as number) <= (s[1] as number);

/** Estimated tokens (≈ characters / 4), as the tool estimates them. */
export const estimate = (text: string) => Math.ceil(text.length / 4);
