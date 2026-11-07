import * as fs from 'node:fs';
import * as path from 'node:path';
import { corpusReader, evidenceLabel, evidencePattern, isSpan, linesOf, normalise, type Corpus, type CorpusDoc } from './corpus';
import { containersOf, expandIncludes } from './markup';
import type { Span } from './types';
import { spanTexts, type ReadInclude } from './validate';

/**
 * `map-spans`: annotators read only `doc.md`, so they record `md` spans. This fills the `smd` spans from them by
 * aligning the lines of `doc.md` with the lines of `doc.smd` without markup (a longest common subsequence of
 * normalised, non-blank lines, the alignment the similarity number counts). Includes are written out first, as
 * `doc.md` writes them, and every included line maps to its `:::include` line.
 */

/** For each line of `doc.md` (zero-based), the zero-based `doc.smd` line it aligns with, or -1. */
export function alignLines(md: string, smd: string, readFile?: ReadInclude): number[] {
  const a = linesOf(md).map(normalise);
  const expanded = expandIncludes(smd, readFile, true);
  const b = expanded.map((l) => normalise(l.text));
  const xs = a.flatMap((t, i) => (t ? [i] : []));
  const ys = b.flatMap((t, j) => (t ? [j] : []));
  const n = xs.length;
  const m = ys.length;
  // dp[i][j]: LCS of xs[i..] and ys[j..], filled from the end so the walk below goes forwards.
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[xs[i]] === b[ys[j]] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const out = new Array<number>(a.length).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[xs[i]] === b[ys[j]]) { out[xs[i]] = expanded[ys[j]].origin; i++; j++; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++;
    else j++;
  }
  return out;
}

/** A document's line alignment, and what mapSpan needs besides it. */
export interface Alignment {
  /** For each `doc.md` line (zero-based), the `doc.smd` line (zero-based) it aligns with, or -1. */
  lines: number[];
  /** Blank `doc.md` lines, which never align and are not reported. */
  blank: Set<number>;
  /** Closing fence line → opening line, for the containers of `doc.smd`. */
  closers: Map<number, number>;
}

export function alignDoc(md: string, smd: string, readFile?: ReadInclude): Alignment {
  const closers = new Map<number, number>();
  for (const c of containersOf(smd)) if (c.close !== undefined) closers.set(c.close, c.open);
  return { lines: alignLines(md, smd, readFile), blank: new Set(linesOf(md).flatMap((l, i) => (normalise(l) ? [] : [i]))), closers };
}

/**
 * The `doc.smd` span of a `doc.md` span: from the first to the last aligned line of its non-blank lines, so fence
 * lines the markup adds inside it are covered. When the span ends on the last line of a container that opens inside
 * it, the container's closing fence is taken in too. No `smd` when no line aligns. `unaligned`: md lines (1-based)
 * with text that no `.smd` line matches.
 */
export function mapSpan(span: Span, al: Alignment): { smd?: Span; unaligned: number[] } {
  const mapped: number[] = [];
  const unaligned: number[] = [];
  for (let i = Math.max(0, span[0] - 1); i <= span[1] - 1 && i < al.lines.length; i++) {
    if (al.lines[i] >= 0) mapped.push(al.lines[i]);
    else if (!al.blank.has(i)) unaligned.push(i + 1);
  }
  if (!mapped.length) return { unaligned };
  const start = Math.min(...mapped);
  let end = Math.max(...mapped);
  for (let open = al.closers.get(end + 1); open !== undefined && open >= start; open = al.closers.get(end + 1)) end++;
  return { smd: [start + 1, end + 1], unaligned };
}

export interface MappedItem {
  id: string;
  md: Span;
  /** The span map-spans gives; absent when no line of the md span aligns. */
  smd?: Span;
  /** The span the file has now, if any. */
  previous?: Span;
  /** md lines (1-based) with text that no `.smd` line matches. */
  unaligned: number[];
  /** Evidence entries not inside the mapped `.smd` span. */
  evidenceOutside: string[];
}

export interface MappedTask { id: string; md: Span[]; smd?: Span[]; previous?: Span[]; unmapped: number }

export interface DocSpanReport { doc: string; items: MappedItem[]; tasks: MappedTask[]; problems: string[] }

export interface SpanReport { corpus: string; docs: DocSpanReport[]; written: string[] }

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

/** Maps one document's annotation items and edit-plan spans; with `write`, rewrites annotations.json and tasks.json. */
export function mapDoc(doc: CorpusDoc, readFile: ReadInclude | undefined, write = false): DocSpanReport & { written: string[] } {
  const alignment = alignDoc(doc.md, doc.smd, readFile);
  const problems: string[] = [];
  const written: string[] = [];
  const annFile = path.join(doc.dir, 'annotations.json');
  const taskFile = path.join(doc.dir, 'tasks.json');
  // Raw JSON, so items without an `smd` field load and the file keeps its other fields.
  const ann = readJson(annFile);
  const rawItems: any[] = Array.isArray(ann.items) ? ann.items : [];
  const items: MappedItem[] = [];
  const newItems = rawItems.map((raw) => {
    if (!isSpan(raw.md)) { problems.push(`item ${raw.id ?? '(no id)'}: md span must be [start, end]`); return raw; }
    const { smd, unaligned } = mapSpan(raw.md, alignment);
    const evidenceOutside: string[] = [];
    if (smd) {
      const { inside } = spanTexts(doc, 'smd', smd, readFile);
      for (const e of Array.isArray(raw.evidence) ? raw.evidence : []) {
        try { if (!evidencePattern(e).test(inside)) evidenceOutside.push(evidenceLabel(e)); } catch { evidenceOutside.push(`${evidenceLabel(e)} (not a valid regex)`); }
      }
    }
    items.push({ id: raw.id, md: raw.md, ...(smd ? { smd } : {}), ...(isSpan(raw.smd) ? { previous: raw.smd } : {}), unaligned, evidenceOutside });
    return smd ? orderedItem({ ...raw, smd }) : raw;
  });
  const taskJson = readJson(taskFile);
  const rawTasks: any[] = Array.isArray(taskJson.tasks) ? taskJson.tasks : [];
  const tasks: MappedTask[] = [];
  let tasksChanged = false;
  const newTasks = rawTasks.map((raw) => {
    if (raw.type !== 'edit-plan' || !raw.expected || !Array.isArray(raw.expected.md)) return raw;
    const spans = (raw.expected.md as unknown[]).filter(isSpan) as Span[];
    const mapped = spans.map((s) => mapSpan(s, alignment).smd);
    const unmapped = mapped.filter((s) => !s).length + raw.expected.md.length - spans.length;
    const smd = mapped.filter((s): s is Span => !!s);
    tasks.push({ id: raw.id, md: spans, ...(unmapped ? {} : { smd }), ...(Array.isArray(raw.expected.smd) ? { previous: raw.expected.smd } : {}), unmapped });
    if (unmapped) return raw;
    tasksChanged = true;
    const { md, smd: _old, ...rest } = raw.expected;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    let seenMd = false;
    for (const k of Object.keys(raw.expected)) {
      if (k === 'md') { seenMd = true; continue; }
      if (k === 'smd') continue;
      (seenMd ? after : before)[k] = rest[k];
    }
    return { ...raw, expected: { ...before, md, smd, ...after } };
  });
  if (write) {
    if (rawItems.length) {
      fs.writeFileSync(annFile, formatJson({ ...ann, items: newItems }, 2));
      written.push(annFile);
    }
    if (tasksChanged) {
      fs.writeFileSync(taskFile, formatJson({ ...taskJson, tasks: newTasks }, 3));
      written.push(taskFile);
    }
  }
  return { doc: doc.name, items, tasks, problems, written };
}

const ITEM_KEYS = ['id', 'kind', 'md', 'smd', 'evidence', 'annotator', 'notes'];

/** An item's keys in the guide's order (`id, kind, md, smd, evidence, annotator, notes`), any others after them. */
export function orderedItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ITEM_KEYS) if (k in item) out[k] = item[k];
  for (const k of Object.keys(item)) if (!(k in out)) out[k] = item[k];
  return out;
}

/** One line of JSON with a space after `:` and `,` and inside braces, as the fixture files are written. */
function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.length ? `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(value);
}

/** 2-space JSON down to `depth` levels, each value below that on one line (so one item or one span per line). */
export function formatJson(value: unknown, depth: number, indent = ''): string {
  const inner = `${indent}  `;
  if (depth <= 0 || !value || typeof value !== 'object') return indent ? inlineJson(value) : `${inlineJson(value)}\n`;
  let text: string;
  if (Array.isArray(value)) {
    text = value.length ? `[\n${value.map((v) => inner + formatJson(v, depth - 1, inner)).join(',\n')}\n${indent}]` : '[]';
  } else {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    text = entries.length ? `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, depth - 1, inner)}`).join(',\n')}\n${indent}}` : '{}';
  }
  return indent ? text : `${text}\n`;
}

export function mapCorpus(corpus: Corpus, write = false): SpanReport {
  const docs: DocSpanReport[] = [];
  const written: string[] = [];
  for (const doc of corpus.docs) {
    const r = mapDoc(doc, corpusReader(corpus.dir, doc.dir), write);
    written.push(...r.written);
    const { written: _w, ...rest } = r;
    docs.push(rest);
  }
  return { corpus: corpus.dir, docs, written };
}

const fmtSpan = (s: Span | undefined) => (s ? `[${s[0]}, ${s[1]}]` : '-');
const sameSpans = (a: Span[] | undefined, b: Span[] | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The items that need a look: not mapped, evidence outside, lines that did not align, or a span that changed. */
export function spanReportText(r: SpanReport, write: boolean): string {
  const out = [`Corpus ${r.corpus}: smd spans from md spans (${write ? 'written' : 'report only; --write writes them'})`];
  let unmapped = 0;
  let outside = 0;
  for (const d of r.docs) {
    const lines: string[] = [];
    for (const p of d.problems) lines.push(`  error: ${p}`);
    for (const i of d.items) {
      if (!i.smd) { unmapped++; lines.push(`  not mapped: ${i.id} md ${fmtSpan(i.md)} (no line aligns)`); continue; }
      if (i.evidenceOutside.length) { outside++; lines.push(`  evidence outside: ${i.id} md ${fmtSpan(i.md)} → smd ${fmtSpan(i.smd)}: ${i.evidenceOutside.join(', ')}`); }
      if (i.unaligned.length) lines.push(`  partly aligned: ${i.id} md lines ${i.unaligned.join(', ')} match no .smd line`);
      if (i.previous && !sameSpans([i.previous], [i.smd])) lines.push(`  changed: ${i.id} smd ${fmtSpan(i.previous)} → ${fmtSpan(i.smd)}`);
    }
    for (const t of d.tasks) {
      if (t.unmapped) { unmapped++; lines.push(`  not mapped: task ${t.id} expected.md has ${t.unmapped} span(s) that do not map`); continue; }
      if (t.previous && !sameSpans(t.previous, t.smd)) lines.push(`  changed: task ${t.id} expected.smd ${JSON.stringify(t.previous)} → ${JSON.stringify(t.smd)}`);
    }
    out.push(`${d.doc}: ${d.items.filter((i) => i.smd).length}/${d.items.length} items mapped, ${d.tasks.length} edit plan(s)`, ...lines);
  }
  for (const f of r.written) out.push(`wrote ${f}`);
  out.push(unmapped || outside ? `${unmapped} not mapped, ${outside} with evidence outside the mapped span` : 'OK');
  return out.join('\n') + '\n';
}

/** Whether map-spans found nothing it could not map. */
export const spansOk = (r: SpanReport) =>
  r.docs.every((d) => !d.problems.length && d.items.every((i) => i.smd && !i.evidenceOutside.length) && d.tasks.every((t) => !t.unmapped));
