import * as fs from 'node:fs';
import * as path from 'node:path';
import { docFolders, evidenceLabel, isSpan, normalise, spanLines } from './corpus';
import { ITEM_KINDS, type Evidence, type Span } from './types';

/**
 * `agreement`: inter-annotator agreement on items, as the annotation guide's "Agreement" section asks. Two annotators
 * annotate the same documents into two files per document folder; this matches their items one to one and reports
 * item F1, Cohen's kappa on kinds over matched pairs, and the unmatched items of each side.
 *
 * Matching: two items are candidates when their `doc.md` spans overlap. Candidates are taken greedily, best first, by
 * the Jaccard index of their line sets, ties broken by the Jaccard index of their evidence words, then by file order;
 * an item is matched at most once. The guide also asks that matched evidence describes the same claim, which only a
 * person can confirm: an adjudicator's pairs file (`--pairs`) replaces the automatic matching for its documents.
 */

export interface AgreementItem { id: string; kind: string; md: Span; evidence: Evidence[] }

export interface MatchedPair { a: string; b: string; kindA: string; kindB: string; lineJaccard: number; evidenceJaccard: number }

export interface Unmatched { id: string; kind: string; md: Span; evidence: string[] }

export interface Kappa {
  /** Null when undefined: no matched pairs, or both annotators used one and the same kind for every pair. */
  kappa: number | null;
  observed: number | null;
  expected: number | null;
  note?: string;
}

export interface DocAgreement extends Kappa {
  doc: string;
  /** `automatic`, or `pairs` when an adjudicator's pairs file set the matches. */
  matching: 'automatic' | 'pairs';
  nA: number;
  nB: number;
  matched: number;
  /** 2 × matched / (nA + nB); null when both files are empty. */
  f1: number | null;
  pairs: MatchedPair[];
  unmatchedA: Unmatched[];
  unmatchedB: Unmatched[];
  problems: string[];
}

export interface AgreementReport {
  corpus: string;
  files: { a: string; b: string; pairs?: string };
  docs: DocAgreement[];
  pooled: Kappa & { nA: number; nB: number; matched: number; f1: number | null; confusion: Record<string, Record<string, number>> };
  /** Document folders with only one of the two files. */
  skipped: string[];
}

/** Words of an evidence entry: a phrase's words, or the letters-and-digits runs of a regex. */
function evidenceWords(evidence: Evidence[]): Set<string> {
  const words = new Set<string>();
  for (const e of evidence) {
    const text = typeof e === 'string' ? normalise(e) : e.regex.toLowerCase();
    for (const w of text.match(/[\p{L}\p{N}]+/gu) ?? []) words.add(w);
  }
  return words;
}

const jaccard = <T>(a: Set<T>, b: Set<T>) => {
  if (!a.size && !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
};

const overlap = (a: Span, b: Span) => a[0] <= b[1] && b[0] <= a[1];

/** Greedy one-to-one matching by line Jaccard, then evidence-word Jaccard, then file order. */
export function matchItems(a: AgreementItem[], b: AgreementItem[]): MatchedPair[] {
  const candidates: Array<MatchedPair & { i: number; j: number }> = [];
  a.forEach((x, i) => b.forEach((y, j) => {
    if (!overlap(x.md, y.md)) return;
    candidates.push({
      a: x.id, b: y.id, kindA: x.kind, kindB: y.kind, i, j,
      lineJaccard: jaccard(spanLines([x.md]), spanLines([y.md])), evidenceJaccard: jaccard(evidenceWords(x.evidence), evidenceWords(y.evidence)),
    });
  }));
  candidates.sort((p, q) => q.lineJaccard - p.lineJaccard || q.evidenceJaccard - p.evidenceJaccard || p.i - q.i || p.j - q.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: MatchedPair[] = [];
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    const { i: _i, j: _j, ...pair } = c;
    out.push(pair);
  }
  return out.sort((p, q) => a.findIndex((x) => x.id === p.a) - a.findIndex((x) => x.id === q.a));
}

/**
 * Cohen's kappa on two raters' labels for the same units: (observed − expected) / (1 − expected), expected from each
 * rater's own label shares. Undefined (null) with no units, or when expected agreement is 1 (both raters gave every
 * unit the same single label), since chance alone then explains the agreement.
 */
export function cohensKappa(pairs: Array<[string, string]>): Kappa {
  if (!pairs.length) return { kappa: null, observed: null, expected: null, note: 'no matched pairs' };
  const n = pairs.length;
  const observed = pairs.filter(([x, y]) => x === y).length / n;
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const [x, y] of pairs) {
    countA.set(x, (countA.get(x) ?? 0) + 1);
    countB.set(y, (countB.get(y) ?? 0) + 1);
  }
  let expected = 0;
  for (const [k, c] of countA) expected += (c / n) * ((countB.get(k) ?? 0) / n);
  if (expected >= 1 - 1e-12) return { kappa: null, observed, expected: 1, note: 'undefined: both annotators gave every matched pair the same single kind' };
  return { kappa: (observed - expected) / (1 - expected), observed, expected };
}

const asUnmatched = (i: AgreementItem): Unmatched => ({ id: i.id, kind: i.kind, md: i.md, evidence: i.evidence.map(evidenceLabel) });

function loadItems(file: string, problems: string[], side: string): AgreementItem[] {
  let json: { items?: unknown };
  try { json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { problems.push(`${side}: ${(e as Error).message}`); return []; }
  const items = Array.isArray(json.items) ? json.items as Array<Record<string, unknown>> : [];
  const out: AgreementItem[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const id = String(raw.id ?? '');
    if (!id || seen.has(id)) { problems.push(`${side}: item ${id || '(no id)'} has no id or repeats one`); continue; }
    seen.add(id);
    if (!isSpan(raw.md)) { problems.push(`${side}: item ${id} has no md span; left out`); continue; }
    if (!ITEM_KINDS.includes(raw.kind as never)) problems.push(`${side}: item ${id} has unknown kind ${String(raw.kind)}`);
    out.push({ id, kind: String(raw.kind), md: raw.md, evidence: Array.isArray(raw.evidence) ? raw.evidence as Evidence[] : [] });
  }
  return out;
}

/** An adjudicator's confirmed pairs: `{ "<doc>": [["idA", "idB"], …] }`. */
export type PairsFile = Record<string, Array<[string, string]>>;

export function docAgreement(doc: string, a: AgreementItem[], b: AgreementItem[], confirmed?: Array<[string, string]>, problems: string[] = []): DocAgreement {
  let pairs: MatchedPair[];
  if (confirmed) {
    const byA = new Map(a.map((x) => [x.id, x]));
    const byB = new Map(b.map((y) => [y.id, y]));
    const usedA = new Set<string>();
    const usedB = new Set<string>();
    pairs = [];
    for (const [ia, ib] of confirmed) {
      const x = byA.get(ia);
      const y = byB.get(ib);
      if (!x || !y) { problems.push(`pairs: ${ia} / ${ib}: ${!x ? `no item ${ia} in A` : `no item ${ib} in B`}`); continue; }
      if (usedA.has(ia) || usedB.has(ib)) { problems.push(`pairs: ${ia} / ${ib}: an item is paired twice; later pair left out`); continue; }
      usedA.add(ia);
      usedB.add(ib);
      pairs.push({
        a: ia, b: ib, kindA: x.kind, kindB: y.kind,
        lineJaccard: jaccard(spanLines([x.md]), spanLines([y.md])), evidenceJaccard: jaccard(evidenceWords(x.evidence), evidenceWords(y.evidence)),
      });
    }
  } else {
    pairs = matchItems(a, b);
  }
  const matchedA = new Set(pairs.map((p) => p.a));
  const matchedB = new Set(pairs.map((p) => p.b));
  return {
    doc, matching: confirmed ? 'pairs' : 'automatic', nA: a.length, nB: b.length, matched: pairs.length,
    f1: a.length + b.length ? (2 * pairs.length) / (a.length + b.length) : null,
    ...cohensKappa(pairs.map((p) => [p.kindA, p.kindB])),
    pairs, unmatchedA: a.filter((x) => !matchedA.has(x.id)).map(asUnmatched), unmatchedB: b.filter((y) => !matchedB.has(y.id)).map(asUnmatched), problems,
  };
}

export function agreement(corpusDir: string, fileA: string, fileB: string, pairs?: PairsFile, pairsFile?: string): AgreementReport {
  const docs: DocAgreement[] = [];
  const skipped: string[] = [];
  for (const name of docFolders(corpusDir)) {
    const fa = path.join(corpusDir, name, fileA);
    const fb = path.join(corpusDir, name, fileB);
    const hasA = fs.existsSync(fa);
    const hasB = fs.existsSync(fb);
    if (!hasA && !hasB) continue;
    if (!hasA || !hasB) { skipped.push(name); continue; }
    const problems: string[] = [];
    const a = loadItems(fa, problems, 'A');
    const b = loadItems(fb, problems, 'B');
    docs.push(docAgreement(name, a, b, pairs?.[name], problems));
  }
  for (const doc of Object.keys(pairs ?? {})) if (!docs.some((d) => d.doc === doc)) skipped.push(`${doc} (in the pairs file, no pair of files)`);
  const all = docs.flatMap((d) => d.pairs);
  const nA = docs.reduce((s, d) => s + d.nA, 0);
  const nB = docs.reduce((s, d) => s + d.nB, 0);
  const confusion: Record<string, Record<string, number>> = {};
  for (const p of all) (confusion[p.kindA] ??= {})[p.kindB] = (confusion[p.kindA]?.[p.kindB] ?? 0) + 1;
  return {
    corpus: corpusDir, files: { a: fileA, b: fileB, ...(pairsFile ? { pairs: pairsFile } : {}) }, docs, skipped,
    pooled: { nA, nB, matched: all.length, f1: nA + nB ? (2 * all.length) / (nA + nB) : null, ...cohensKappa(all.map((p) => [p.kindA, p.kindB])), confusion },
  };
}

const num = (x: number | null, digits = 3) => (x === null ? '-' : x.toFixed(digits));
const span = (s: Span) => `L${s[0]}-${s[1]}`;

export function agreementText(r: AgreementReport): string {
  const out = [
    '# Inter-annotator agreement', '',
    `Corpus ${r.corpus}. A = \`${r.files.a}\`, B = \`${r.files.b}\`${r.files.pairs ? `, adjudicated pairs from \`${r.files.pairs}\`` : ''}.`,
    'Automatic matching: items whose doc.md spans overlap, one to one, greedily by line Jaccard, then evidence-word Jaccard. A person still confirms that each pair states the same claim.',
    'F1 = 2 × matched / (nA + nB). Kappa: Cohen\'s kappa on kinds over matched pairs.', '',
    '| document | matching | nA | nB | matched | item F1 | kind kappa | observed | expected |',
    '|-|-|-|-|-|-|-|-|-|',
    ...r.docs.map((d) => `| ${d.doc} | ${d.matching} | ${d.nA} | ${d.nB} | ${d.matched} | ${num(d.f1)} | ${num(d.kappa)} | ${num(d.observed)} | ${num(d.expected)} |`),
    `| **pooled** | | ${r.pooled.nA} | ${r.pooled.nB} | ${r.pooled.matched} | ${num(r.pooled.f1)} | ${num(r.pooled.kappa)} | ${num(r.pooled.observed)} | ${num(r.pooled.expected)} |`,
  ];
  if (r.pooled.note) out.push('', `Pooled kappa: ${r.pooled.note}.`);
  const kinds = ITEM_KINDS.filter((k) => r.pooled.confusion[k] || Object.values(r.pooled.confusion).some((row) => row[k]));
  if (kinds.length) {
    out.push('', '## Kinds of matched pairs (rows A, columns B)', '', `| A \\ B | ${kinds.join(' | ')} |`, `|-|${kinds.map(() => '-').join('|')}|`);
    for (const k of kinds) out.push(`| ${k} | ${kinds.map((c) => String(r.pooled.confusion[k]?.[c] ?? 0)).join(' | ')} |`);
  }
  for (const d of r.docs) {
    out.push('', `## ${d.doc}`, '');
    if (d.note) out.push(`Kappa: ${d.note}.`, '');
    for (const p of d.problems) out.push(`- problem: ${p}`);
    const differ = d.pairs.filter((p) => p.kindA !== p.kindB);
    if (differ.length) out.push('Matched with different kinds:', ...differ.map((p) => `- ${p.a} (${p.kindA}) / ${p.b} (${p.kindB})`), '');
    const list = (side: string, items: Unmatched[]) => {
      out.push(`Unmatched in ${side} (${items.length}):`);
      for (const i of items) out.push(`- ${i.id} (${i.kind}) ${span(i.md)}: ${i.evidence.join(', ')}`);
      out.push('');
    };
    list('A', d.unmatchedA);
    list('B', d.unmatchedB);
  }
  if (r.skipped.length) out.push('', `Skipped (only one of the two files): ${r.skipped.join(', ')}`);
  return out.join('\n').replace(/\n+$/, '') + '\n';
}
