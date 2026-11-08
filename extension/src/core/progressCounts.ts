import type { TaskCount } from './progress';
import type { SpecVersion } from './specVersion';
import { scanTasks } from './taskLines';

const HEADING_LEVEL = /^\s{0,3}(#{1,6})(?:\s|$)/;

/**
 * The tasks each line's section holds, from the source: the section of the nearest heading above the line (or on
 * it), subsections included, or the whole document above the first heading. Tasks are read as every task count
 * reads them (scanTasks), so a bar agrees with `smd tasks`.
 */
export function sectionTaskCounts(text: string, from?: number, spec?: SpecVersion): (line: number) => TaskCount {
  const lines = text.split(/\r?\n/);
  const headings: Array<{ line: number; level: number }> = [];
  const tasks: Array<{ line: number; checked: boolean }> = [];
  for (const item of scanTasks(text, from, spec)) {
    if (item.kind === 'heading') headings.push({ line: item.line, level: HEADING_LEVEL.exec(lines[item.line])?.[1].length ?? 1 });
    else tasks.push({ line: item.line, checked: item.mark !== ' ' });
  }
  return (line) => {
    let at = -1;
    while (at + 1 < headings.length && headings[at + 1].line <= line) at++;
    const start = at < 0 ? -1 : headings[at].line;
    const next = at < 0 ? undefined : headings.slice(at + 1).find((h) => h.level <= headings[at].level);
    const end = at < 0 ? Infinity : next?.line ?? Infinity;
    const inside = tasks.filter((t) => t.line > start && t.line < end);
    return { checked: inside.filter((t) => t.checked).length, total: inside.length };
  };
}
