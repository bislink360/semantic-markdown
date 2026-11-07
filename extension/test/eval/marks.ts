import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontMatter, specVersion } from '../../src/core';
import { CONTAINER_OPEN, parseContainerInfo } from '../../src/core/containers';
import { literalLines } from '../../src/core/parse';
import { HEADING_ATTRS } from '../../src/core/sections';
import { corpusReader, docFolders, linesOf, loadCorpus } from './corpus';
import { containersOf } from './markup';
import { alignLines } from './spans';
import type { Span } from './types';
import type { ReadInclude } from './validate';

/**
 * `compare-marks`: the marker comparison of the annotation guide. A second marker marks a document again from its
 * `doc.md` without seeing the first marking. Marks are compared on `doc.md` lines, so the two `.smd` files may differ
 * in layout: two marks match exactly when they have the same kind, spans within one line at both ends, and the same
 * status. `:::include` blocks are left out (a re-marker cannot know which passages are shared), and so is inline
 * task syntax.
 */

/** One mark: a container, or a heading marked `{agent=skip}`. */
export interface Mark {
  kind: string;
  /** `status` of a decision, if any. */
  status?: string;
  title: string;
  /** `doc.md` lines (1-based) the mark covers; absent when no line of it aligns. */
  md?: Span;
  /** The line in its own `.smd` file (1-based). */
  line: number;
}

/** The marks of a `.smd` file, placed on `doc.md` lines through a line alignment. */
export function marksOf(md: string, smd: string, readFile?: ReadInclude): { status?: string; marks: Mark[] } {
  const fm = parseFrontMatter(smd);
  const spec = specVersion(fm.data);
  const lines = linesOf(smd);
  const toMd = new Map<number, number[]>();
  alignLines(md, smd, readFile).forEach((j, i) => { if (j >= 0) (toMd.get(j) ?? toMd.set(j, []).get(j)!).push(i + 1); });
  const mdSpan = (from: number, to: number): Span | undefined => {
    const hit: number[] = [];
    for (let j = from; j <= to; j++) hit.push(...(toMd.get(j) ?? []));
    return hit.length ? [Math.min(...hit), Math.max(...hit)] : undefined;
  };
  const marks: Mark[] = [];
  for (const c of containersOf(smd)) {
    if (c.name === 'include') continue;
    const open = CONTAINER_OPEN.exec(lines[c.open]);
    const info = open ? parseContainerInfo(open[3] + open[4], spec) : null;
    const status = info?.attrs.values.status;
    marks.push({ kind: c.name, ...(status ? { status: String(status) } : {}), title: c.title, md: mdSpan(c.open, c.close ?? c.open), line: c.open + 1 });
  }
  const literal = literalLines(smd);
  lines.forEach((line, i) => {
    if (i < fm.bodyStartLine || literal.has(i) || !/^\s{0,3}#{1,6}\s/.test(line)) return;
    const m = HEADING_ATTRS.exec(line);
    if (m && /\bagent\s*=\s*["']?skip\b/.test(m[1])) marks.push({ kind: 'skip', title: line.slice(0, m.index).replace(/^\s*#+\s*/, '').trim(), md: mdSpan(i, i), line: i + 1 });
  });
  const status = fm.data && typeof fm.data === 'object' ? (fm.data as Record<string, unknown>).status : undefined;
  return { ...(status !== undefined ? { status: String(status) } : {}), marks: marks.sort((a, b) => a.line - b.line) };
}

export interface MarkPair { a: Mark; b: Mark; exact: boolean }

export interface DocMarks {
  doc: string;
  marksA: number;
  marksB: number;
  /** Same kind and spans within one line. */
  matched: number;
  /** Matched and the same status. */
  exact: number;
  /** 2 × exact / (marksA + marksB): the share of marks that match exactly. */
  share: number | null;
  statusA?: string;
  statusB?: string;
  /** Matched pairs whose status differs. */
  statusDiffers: MarkPair[];
  onlyA: Mark[];
  onlyB: Mark[];
  problems: string[];
}

export interface MarksReport { corpus: string; other: string; docs: DocMarks[]; pooled: Omit<DocMarks, 'doc' | 'statusA' | 'statusB' | 'statusDiffers' | 'onlyA' | 'onlyB' | 'problems'> }

const near = (a: Span, b: Span, tolerance: number) => Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;

/** One-to-one matching of two mark lists: same kind, spans within `tolerance` lines at both ends, closest first. */
export function matchMarks(a: Mark[], b: Mark[], tolerance = 1): MarkPair[] {
  const candidates: Array<{ i: number; j: number; d: number }> = [];
  a.forEach((x, i) => b.forEach((y, j) => {
    if (x.kind === y.kind && x.md && y.md && near(x.md, y.md, tolerance)) candidates.push({ i, j, d: Math.abs(x.md[0] - y.md[0]) + Math.abs(x.md[1] - y.md[1]) });
  }));
  candidates.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: MarkPair[] = [];
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i); usedB.add(c.j);
    pairs.push({ a: a[c.i], b: b[c.j], exact: (a[c.i].status ?? '') === (b[c.j].status ?? '') });
  }
  return pairs.sort((p, q) => p.a.line - q.a.line);
}

const shareOf = (exact: number, a: number, b: number) => (a + b ? (2 * exact) / (a + b) : null);

/** Compares the corpus marking (A) of each document with the marking in `<otherDir>/<doc>/doc.smd` (B). */
export function compareMarks(corpusDir: string, otherDir: string): MarksReport {
  const corpus = loadCorpus(corpusDir);
  const docs: DocMarks[] = [];
  for (const name of docFolders(otherDir)) {
    const file = path.join(otherDir, name, 'doc.smd');
    if (!fs.existsSync(file)) continue;
    const doc = corpus.docs.find((d) => d.name === name);
    const problems: string[] = [];
    if (!doc) { docs.push({ doc: name, marksA: 0, marksB: 0, matched: 0, exact: 0, share: null, statusDiffers: [], onlyA: [], onlyB: [], problems: ['not in the corpus'] }); continue; }
    const a = marksOf(doc.md, doc.smd, corpusReader(corpus.dir, doc.dir));
    const b = marksOf(doc.md, fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    for (const [side, m] of [['A', a], ['B', b]] as const) for (const x of m.marks) if (!x.md) problems.push(`${side} L${x.line} ${x.kind}: no doc.md line aligns`);
    const pairs = matchMarks(a.marks, b.marks);
    const inA = new Set(pairs.map((p) => p.a));
    const inB = new Set(pairs.map((p) => p.b));
    const exact = pairs.filter((p) => p.exact).length;
    docs.push({
      doc: name, marksA: a.marks.length, marksB: b.marks.length, matched: pairs.length, exact, share: shareOf(exact, a.marks.length, b.marks.length),
      ...(a.status !== undefined ? { statusA: a.status } : {}), ...(b.status !== undefined ? { statusB: b.status } : {}),
      statusDiffers: pairs.filter((p) => !p.exact), onlyA: a.marks.filter((m) => !inA.has(m)), onlyB: b.marks.filter((m) => !inB.has(m)), problems,
    });
  }
  const sum = (k: 'marksA' | 'marksB' | 'matched' | 'exact') => docs.reduce((n, d) => n + d[k], 0);
  const pooled = { marksA: sum('marksA'), marksB: sum('marksB'), matched: sum('matched'), exact: sum('exact'), share: shareOf(sum('exact'), sum('marksA'), sum('marksB')) };
  return { corpus: corpus.dir, other: path.resolve(otherDir), docs, pooled };
}

const fmt = (x: number | null) => (x === null ? '-' : x.toFixed(3));
const label = (m: Mark) => `${m.kind}${m.status ? `{status=${m.status}}` : ''} md ${m.md ? `L${m.md[0]}-${m.md[1]}` : '-'} "${m.title}"`;

export function marksText(r: MarksReport): string {
  const out = [
    'Marker comparison: A is the corpus marking, B the independent re-marking. A mark matches exactly with the same kind, doc.md spans within one line at both ends, and the same status. Share = 2 x exact / (A + B).',
    '',
    '| document | A marks | B marks | matched | exact | share | front matter status A / B |',
    '|-|-|-|-|-|-|-|',
    ...r.docs.map((d) => `| ${d.doc} | ${d.marksA} | ${d.marksB} | ${d.matched} | ${d.exact} | ${fmt(d.share)} | ${d.statusA ?? '-'} / ${d.statusB ?? '-'} |`),
    `| pooled | ${r.pooled.marksA} | ${r.pooled.marksB} | ${r.pooled.matched} | ${r.pooled.exact} | ${fmt(r.pooled.share)} | |`,
  ];
  for (const d of r.docs) {
    if (!d.statusDiffers.length && !d.onlyA.length && !d.onlyB.length && !d.problems.length) continue;
    out.push('', `## ${d.doc}`);
    for (const p of d.statusDiffers) out.push(`- status differs: A ${label(p.a)} / B ${label(p.b)}`);
    for (const m of d.onlyA) out.push(`- only A: ${label(m)}`);
    for (const m of d.onlyB) out.push(`- only B: ${label(m)}`);
    for (const p of d.problems) out.push(`- problem: ${p}`);
  }
  return out.join('\n') + '\n';
}
