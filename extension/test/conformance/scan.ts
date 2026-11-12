/**
 * A minimal scanner for the conformance fixtures. It finds the line ranges of headings, fenced containers, CAUTION
 * alerts, tasks with ids and plain paragraphs, and which of them an audience mark hides. It shares no code with the
 * renderer on purpose (view laws, "Definitions"): the oracle decides what a view must hold from the fixture text and
 * the laws, and decides what the view holds from the manifest's source map.
 *
 * It understands only what the fixtures use: front matter, fenced code, `#` headings with `{#id}` and `{agent=skip}`,
 * `:::name{#id key=value}` containers closed by a line of at least as many colons, `> [!CAUTION]` alerts, and task
 * lines with `{#T1}`. Every line number is one-based and inclusive, as in the manifest.
 */

export type Range = [number, number];

export interface ScannedBlock {
  /** The fixture file, relative to the case folder, with `/` between folders. */
  file: string;
  /** A container's name, or `heading`, `caution`, `task` or `paragraph`. */
  kind: string;
  id?: string;
  /** The raw attribute text of a container's opening line, or a heading's `{…}`. */
  attrs: string;
  lines: Range;
  /** The block's lines without the lines of the containers nested in it. */
  own: Range[];
  /** A heading's level and text without its `{…}`. */
  level?: number;
  text?: string;
  /** For a container: the names of the containers it sits in, outermost first. */
  parents: string[];
}

export interface ScannedSection {
  heading: ScannedBlock;
  /** The heading line to the line before the next heading of the same or a higher level. */
  lines: Range;
  skip: boolean;
}

export interface ScannedFile {
  file: string;
  lines: string[];
  /** One-based line after the front matter (1 when there is none). */
  bodyStart: number;
  blocks: ScannedBlock[];
  sections: ScannedSection[];
  /** `:::include{file="…"}` openers: the file named and the opener's line. */
  includes: Array<{ target: string; line: number; block: ScannedBlock }>;
}

/** Containers that only lay content out or carry an audience: not typed blocks for precision. */
export const LAYOUT_CONTAINERS = new Set(['details', 'tabs', 'tab', 'columns', 'column', 'card', 'human', 'include', 'figure', 'note', 'tip', 'warning']);

const OPENER = /^(:{3,})([A-Za-z][\w-]*)(.*)$/;
const CLOSER = /^(:{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const CAUTION = /^>\s*\[!CAUTION\]/i;
const TASK = /^\s*[-*]\s+\[[ xX]\]\s/;

export function idOf(attrs: string): string | undefined {
  // `#id` right after `{` or a space, so `depends-on=other.smd#R7` is not taken for an id.
  return /\{(?:[^}]*?\s)?#([\w.-]+)/.exec(attrs)?.[1];
}

function subtract(range: Range, holes: Range[]): Range[] {
  let parts: Range[] = [range];
  for (const [a, b] of holes) {
    parts = parts.flatMap(([x, y]): Range[] => {
      if (b < x || a > y) return [[x, y]];
      const out: Range[] = [];
      if (a > x) out.push([x, a - 1]);
      if (b < y) out.push([b + 1, y]);
      return out;
    });
  }
  return parts;
}

export function scan(file: string, text: string): ScannedFile {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let bodyStart = 1;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) bodyStart = end + 2;
  }
  const blocks: ScannedBlock[] = [];
  const headings: ScannedBlock[] = [];
  const includes: ScannedFile['includes'] = [];
  const stack: Array<{ colons: number; block: ScannedBlock; children: Range[] }> = [];
  let fence: string | null = null;
  for (let i = bodyStart - 1; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const close = CLOSER.exec(line);
    if (close) {
      const top = stack.at(-1);
      if (top && close[1].length >= top.colons) {
        stack.pop();
        top.block.lines = [top.block.lines[0], n];
        top.block.own = subtract(top.block.lines, top.children);
        stack.at(-1)?.children.push(top.block.lines);
      }
      continue;
    }
    const open = OPENER.exec(line);
    if (open) {
      const block: ScannedBlock = {
        file, kind: open[2], id: idOf(open[3]), attrs: open[3], lines: [n, n], own: [], parents: stack.map((s) => s.block.kind),
      };
      blocks.push(block);
      stack.push({ colons: open[1].length, block, children: [] });
      if (block.kind === 'include') {
        const target = /file="([^"]+)"/.exec(open[3])?.[1];
        if (target) includes.push({ target, line: n, block });
      }
      continue;
    }
    if (stack.length === 0) {
      const h = HEADING.exec(line);
      if (h) {
        const attrs = /\s*(\{[^}]*\})\s*$/.exec(h[2])?.[1] ?? '';
        const block: ScannedBlock = {
          file, kind: 'heading', id: idOf(attrs), attrs, lines: [n, n], own: [[n, n]], level: h[1].length,
          text: attrs ? h[2].slice(0, h[2].length - attrs.length).trim() : h[2], parents: [],
        };
        blocks.push(block);
        headings.push(block);
        continue;
      }
    }
    if (CAUTION.test(line)) {
      let end = n;
      while (end < lines.length && lines[end].startsWith('>')) end++;
      blocks.push({ file, kind: 'caution', attrs: '', lines: [n, end], own: [[n, end]], parents: stack.map((s) => s.block.kind) });
      stack.at(-1)?.children.push([n, end]);
      i = end - 1;
      continue;
    }
    if (TASK.test(line)) {
      const id = /\{#([\w.-]+)\}\s*$/.exec(line)?.[1];
      blocks.push({ file, kind: 'task', id, attrs: '', lines: [n, n], own: [[n, n]], parents: stack.map((s) => s.block.kind) });
      stack.at(-1)?.children.push([n, n]);
    }
  }
  if (stack.length) throw new Error(`${file}: container "${stack.at(-1)!.block.kind}" at line ${stack.at(-1)!.block.lines[0]} is never closed`);
  const sections: ScannedSection[] = headings.map((heading, k) => {
    const next = headings.slice(k + 1).find((h) => h.level! <= heading.level!);
    return { heading, lines: [heading.lines[0], next ? next.lines[0] - 1 : lines.length], skip: /agent=skip/.test(heading.attrs) };
  });
  return { file, lines, bodyStart, blocks, sections, includes };
}

/** The innermost container or alert holding `line`, else the paragraph around it (contiguous non-blank lines). */
export function blockAt(scanned: ScannedFile, line: number): ScannedBlock {
  const holders = scanned.blocks
    .filter((b) => b.kind !== 'heading' && b.kind !== 'task' && b.lines[0] <= line && line <= b.lines[1])
    .sort((x, y) => (x.lines[1] - x.lines[0]) - (y.lines[1] - y.lines[0]));
  const task = scanned.blocks.find((b) => b.kind === 'task' && b.lines[0] === line);
  if (task) return task;
  const inner = holders[0];
  if (inner && !LAYOUT_CONTAINERS.has(inner.kind)) return inner;
  // A paragraph: stop at blank lines, headings and container fences.
  const plain = (n: number) => {
    const t = scanned.lines[n - 1];
    return t !== undefined && t.trim() !== '' && !HEADING.test(t) && !OPENER.test(t) && !CLOSER.test(t);
  };
  let a = line;
  let b = line;
  while (a - 1 >= scanned.bodyStart && plain(a - 1)) a--;
  while (plain(b + 1)) b++;
  return { file: scanned.file, kind: 'paragraph', attrs: '', lines: [a, b], own: [[a, b]], parents: inner ? [inner.kind] : [] };
}

/** The section a line sits in, innermost first. */
export function sectionsAround(scanned: ScannedFile, line: number): ScannedSection[] {
  return scanned.sections.filter((s) => s.lines[0] <= line && line <= s.lines[1]).reverse();
}

/**
 * Is a block hidden from agents in this request? It is when it sits in a `:::human` container or in an
 * `{agent=skip}` section the caller did not name (view laws, "Blocks and eligibility").
 */
export function hidden(scanned: ScannedFile, block: ScannedBlock, named: (s: ScannedSection) => boolean): boolean {
  if (block.parents.includes('human') || block.kind === 'human') return true;
  return sectionsAround(scanned, block.lines[0]).some((s) => s.skip && !named(s));
}
