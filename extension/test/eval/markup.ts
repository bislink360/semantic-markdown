import { parseFrontMatter, parseSmd, specVersion, CALLOUT_TYPES } from '../../src/core';
import { CONTAINER_CLOSE, CONTAINER_OPEN, closedBy, closerColons, parseContainerInfo } from '../../src/core/containers';
import { containerEnd, findIncludes, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope } from '../../src/core/include';
import { includeSource } from '../../src/core/includeText';
import { literalLines } from '../../src/core/parse';
import { HEADING_ATTRS, sectionsOf, withoutHeadingAttrs, type Section } from '../../src/core/sections';
import { linesOf, normalise } from './corpus';

/**
 * Source rewrites for the ablations, and the `.smd` text without markup for the similarity check. Every rewrite keeps
 * the number of lines, so annotation spans and `[L12]` references stay valid.
 */

/** A container in the source: its name, title, and zero-based opening and closing lines. */
export interface SourceContainer { name: string; title: string; open: number; close?: number }

/** Every container of a document, outside code and display math, with the line that closes it. */
export function containersOf(text: string): SourceContainer[] {
  const lines = linesOf(text);
  const spec = specVersion(parseFrontMatter(text).data);
  const literal = literalLines(text);
  const start = parseFrontMatter(text).bodyStartLine;
  const all: SourceContainer[] = [];
  const stack: Array<{ c: SourceContainer; colons: number }> = [];
  for (let i = start; i < lines.length; i++) {
    if (literal.has(i)) continue;
    const line = lines[i];
    if (CONTAINER_CLOSE.test(line)) {
      const at = closedBy(stack.map((s) => s.colons), closerColons(line), spec);
      if (at < 0) continue;
      for (const s of stack.splice(at)) s.c.close = i;
      continue;
    }
    const open = CONTAINER_OPEN.exec(line);
    const info = open ? parseContainerInfo(open[3] + open[4], spec) : null;
    if (!open || !info) continue;
    const c: SourceContainer = { name: info.name, title: info.title, open: i };
    all.push(c);
    stack.push({ c, colons: open[2].length });
  }
  return all;
}

/** Containers the agent view shows as meaning tags: `:::agent`, callouts (with `:::question`), decisions and risks. */
export const SEMANTIC_BLOCKS: ReadonlySet<string> = new Set(['agent', 'decision', 'risk', ...CALLOUT_TYPES]);

/** Headings marked `{agent=skip}` lose the mark, so the agent view shows their sections. */
export function withoutSkipMarks(text: string): string {
  const literal = literalLines(text);
  return linesOf(text).map((line, i) => {
    if (literal.has(i) || !/^\s{0,3}#{1,6}\s/.test(line)) return line;
    const m = HEADING_ATTRS.exec(line);
    if (!m || !/\bagent\s*=\s*["']?skip\b/.test(m[1])) return line;
    const rest = m[1].replace(/\s*\bagent\s*=\s*["']?skip["']?/, '').trim();
    return line.slice(0, m.index) + (rest ? ` {${rest}}` : '');
  }).join('\n');
}

/** Semantic blocks become plain text: the opening line becomes its title (or a blank line), the closing line blank. */
export function plainBlocks(text: string): string {
  const lines = linesOf(text);
  const containers = containersOf(text);
  const closers = new Map<number, SourceContainer[]>();
  for (const c of containers) if (c.close !== undefined) closers.set(c.close, [...(closers.get(c.close) ?? []), c]);
  for (const c of containers) if (SEMANTIC_BLOCKS.has(c.name)) lines[c.open] = c.title;
  for (const [line, closed] of closers) if (closed.every((c) => SEMANTIC_BLOCKS.has(c.name))) lines[line] = '';
  return lines.join('\n');
}

/** `:::agent` blocks blanked out, all of them or those `drop` picks by opening line. */
export function withoutAgentBlocks(text: string, drop: (openLine: number) => boolean = () => true): string {
  const lines = linesOf(text);
  for (const c of containersOf(text)) {
    if (c.name !== 'agent' || !drop(c.open)) continue;
    const end = c.close ?? lines.length - 1;
    for (let i = c.open; i <= end; i++) lines[i] = '';
  }
  return lines.join('\n');
}

/** The sections of a document (zero-based, inclusive ranges). */
export function documentSections(text: string): Section[] {
  return sectionsOf(parseSmd(text).headings, linesOf(text).length);
}

/**
 * The smallest section that holds a 1-based span, or, when none holds all of it, every innermost section it overlaps.
 * Empty when the span is above the first heading.
 */
export function sectionsHolding(sections: Section[], [start, end]: [number, number]): Section[] {
  const a = start - 1;
  const b = end - 1;
  const holding = sections.filter((s) => s.start <= a && s.end >= b);
  if (holding.length) return [holding.reduce((x, y) => (y.end - y.start < x.end - x.start ? y : x))];
  const touched = sections.filter((s) => s.start <= b && s.end >= a);
  return touched.filter((s) => !touched.some((t) => t !== s && t.start >= s.start && t.end <= s.end));
}

/** Inline markup to its words: `:name[content]{…}` → content, `[text]{…}` → text, `==mark==` → mark. */
function plainInline(line: string): string {
  return line
    .replace(/(^|[\s([{>*_~"'-]):[A-Za-z][\w-]*\[([^\]]*)\](?:\{[^{}\n]*\})?/g, '$1$2')
    .replace(/(^|[\s([{>*_~"'-]):[A-Za-z][\w-]*\{[^{}\n]*\}/g, '$1')
    .replace(/(?<!!)\[([^\]]*)\]\{[^{}\n]*\}/g, '$1')
    .replace(/==(?=\S)([^=]+?)(?<=\S)==/g, '$1');
}

/** The `.smd` text without markup: no front matter, container lines as their titles, no attribute lists or inline markup. */
export function withoutMarkup(smd: string): string {
  const lines = linesOf(smd);
  const fm = parseFrontMatter(smd);
  const spec = specVersion(fm.data);
  const literal = literalLines(smd);
  const containers = containersOf(smd);
  const opens = new Map(containers.map((c) => [c.open, c]));
  const closes = new Set(containers.map((c) => c.close).filter((n) => n !== undefined));
  return lines.map((line, i) => {
    if (i < fm.bodyStartLine) return '';
    if (literal.has(i)) return line;
    const c = opens.get(i);
    if (c) return c.title;
    if (closes.has(i)) return '';
    const h = /^(\s{0,3}#{1,6}\s+)(.*)$/.exec(line);
    return plainInline(h ? h[1] + withoutHeadingAttrs(h[2], spec) : line);
  }).join('\n');
}

/** One line of a document with its includes written out, and the zero-based line of the document it stands for. */
export interface ExpandedLine { text: string; origin: number }

/**
 * A `.smd` document with every `:::include` block (opening line to closing line) replaced by the included lines, as
 * `doc.md` writes them out. Each included line has the `:::include` opening line as its origin, so a span that covers
 * that line covers the whole included passage. Nested includes are written out too. An include that cannot be read
 * stays as it is. `plain`: every line without markup (see withoutMarkup), for comparing with `doc.md`.
 */
export function expandIncludes(text: string, readFile: ((rel: string) => string | undefined) | undefined, plain = false): ExpandedLine[] {
  const source = includeSource(readFile);
  const out: ExpandedLine[] = [];
  const walk = (lines: string[], view: string[], from: number, to: number, scope: IncludeScope, origin?: number) => {
    const spec = scope.spec ?? 1;
    const blocks = new Map(findIncludes(lines, from, to, spec).map((b) => [b.line, b]));
    for (let i = from; i <= to && i < lines.length; i++) {
      const block = blocks.get(i);
      const request = block && includeRequest(block.info.attrs.values);
      const result = request && loadInclude(request, scope, source);
      if (!block || !result || !result.ok) { out.push({ text: view[i], origin: origin ?? i }); continue; }
      const inc = result.include;
      const incView = plain ? linesOf(withoutMarkup(inc.lines.join('\n'))) : inc.lines;
      walk(inc.lines, incView, inc.start, inc.end, innerScope(scope, inc), origin ?? i);
      i = Math.min(to, containerEnd(lines, i, spec, from));
    }
  };
  const lines = linesOf(text);
  walk(lines, plain ? linesOf(withoutMarkup(text)) : lines, 0, lines.length - 1, rootScope(text));
  return out;
}

/** Whether a document has an `:::include` block. */
export const hasIncludeBlocks = (text: string) => findIncludes(linesOf(text), 0, undefined, specVersion(text)).length > 0;

/** Normalised lines that are not blank, front matter left out. */
function comparableLines(text: string): string[] {
  const start = parseFrontMatter(text).bodyStartLine;
  return linesOf(text).slice(start).map(normalise).filter(Boolean);
}

/** How close two texts are, by lines: 2 × longest common subsequence / (lines of a + lines of b), 1 when equal. */
export function lineSimilarity(a: string, b: string): number {
  const x = comparableLines(a);
  const y = comparableLines(b);
  if (!x.length && !y.length) return 1;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (const xi of x) {
    const row = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) row[j] = xi === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return (2 * prev[y.length]) / (x.length + y.length);
}

/** How close the `.smd` text without markup is to the plain Markdown. */
export const markupSimilarity = (md: string, smd: string) => lineSimilarity(md, withoutMarkup(smd));
