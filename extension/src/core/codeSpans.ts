import { idList } from './spec';

/**
 * Inline code spans on one line, read as CommonMark reads them, so scanners that look for syntax in a line's text
 * (`:depends[…]`, footnote references, rule comments) never read the inside of code. A span opens on a run of
 * backticks that is not backslash-escaped and closes on the next run of exactly the same length. A run with no
 * closing run is plain text.
 */

/** The `[start, end)` columns of each code span on the line, backticks included. */
export function codeSpans(line: string): Array<[start: number, end: number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    if (tick < 0) break;
    // A backslash-escaped backtick is text, and the run, if any, starts after it.
    if (escaped(line, tick)) { i = tick + 1; continue; }
    const run = runEnd(line, tick);
    const close = closingRun(line, run, run - tick);
    if (close < 0) { i = run; continue; }
    spans.push([tick, close]);
    i = close;
  }
  return spans;
}

/** The line with its inline code spans blanked out (same length, so columns still match the source). */
export function maskCodeSpans(line: string): string {
  let out = '';
  let at = 0;
  for (const [start, end] of codeSpans(line)) {
    out += line.slice(at, start) + ' '.repeat(end - start);
    at = end;
  }
  return out + line.slice(at);
}

/** Whether the backtick at `i` follows an odd number of backslashes. */
function escaped(line: string, i: number): boolean {
  let n = 0;
  while (i - n - 1 >= 0 && line[i - n - 1] === '\\') n++;
  return n % 2 === 1;
}

const runEnd = (line: string, i: number): number => {
  let j = i;
  while (line[j] === '`') j++;
  return j;
};

/** The end of the next run of exactly `length` backticks from `from`, or -1. Inside code a backslash is text. */
function closingRun(line: string, from: number, length: number): number {
  for (let i = line.indexOf('`', from); i >= 0; i = line.indexOf('`', i)) {
    const end = runEnd(line, i);
    if (end - i === length) return end;
    i = end;
  }
  return -1;
}

/** `:depends[…]` after a line start, space, bracket, quote or emphasis mark, in any case (spec v2). */
const DEPENDS = /(^|[\s([{>*_~"'-]):depends\[([^\]\n]*)\]/gi;

/** One `:depends[…]` on a line: its raw list and the column where that list starts in the source line. */
export interface DependsList { list: string; column: number }

/** Each `:depends[…]` on a line outside code spans, with columns in the original line. */
export function dependsLists(line: string): DependsList[] {
  return [...maskCodeSpans(line).matchAll(DEPENDS)].map((m) => {
    const column = m.index + m[1].length + ':depends['.length;
    return { list: line.slice(column, column + m[2].length), column };
  });
}

/** The ids the `:depends[…]` lists on a line name, outside code spans, in order and without repeats. */
export function dependsOnLine(line: string): string[] {
  return [...new Set(dependsLists(line).flatMap((d) => idList(d.list)))];
}
