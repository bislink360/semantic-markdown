import type { TaskInfo } from './meta';
import { SMD_VERSION } from './spec';
import { orderByPrerequisites, taskPrerequisites } from './taskOrder';

/**
 * Task export: CSV for spreadsheets and a Mermaid Gantt chart of tasks with due dates, from the
 * rows `extractTasks` returns (with the file each came from, as `smd tasks` lists them).
 */
export type TaskExportRow = TaskInfo & { file?: string };

/** CSV columns, in order. `line` is 1-based (as `smd tasks` prints it); `extractTasks` and `--json` are zero-based. */
export const TASK_CSV_COLUMNS = ['file', 'line', 'done', 'text', 'owners', 'priority', 'due', 'overdue', 'section'] as const;

/**
 * RFC 4180 CSV with a header row and CRLF line endings, UTF-8 without a byte order mark. Owners are
 * joined with `;`. Fields with a comma, quote or line break are quoted (quotes doubled). A field that
 * starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so spreadsheets
 * don't run it as a formula; this includes owners (`'@maya;@li`), since Excel reads `@maya` as one.
 */
export function tasksToCsv(rows: TaskExportRow[]): string {
  const lines = [TASK_CSV_COLUMNS.join(','), ...rows.map((r) => csvRecord(r).map(csvField).join(','))];
  return lines.map((l) => l + '\r\n').join('');
}

function csvRecord(r: TaskExportRow): string[] {
  return [
    r.file ?? '', String(r.line + 1), String(r.done), r.text, r.assignees.join(';'),
    r.priority ?? '', r.due ?? '', String(r.overdue ?? false), r.section ?? '',
  ];
}

/** Characters that make a spreadsheet treat a cell as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface GanttOptions {
  /** Chart title (default "Tasks"). */
  title?: string;
}

/**
 * A Mermaid `gantt` chart: one section per file (in path order), one milestone per task with a
 * valid YYYY-MM-DD due date (by date, then line), named by its text and owners. Done tasks are
 * marked `done`, overdue ones `crit`. Tasks without a due date are left out (see `ganttDate`).
 *
 * A task whose `:depends[…]` names charted tasks of its file comes after them (semantic tags R49). When they are all
 * due no later than it, it is a bar that starts `after` them and ends on its own due date, so the chart shows what it
 * waits for. A chart without such dependencies is the same as before.
 */
export function tasksToGantt(rows: TaskExportRow[], options: GanttOptions = {}): string {
  const out = ['gantt', `  title ${ganttText(options.title?.trim() || 'Tasks')}`, '  dateFormat YYYY-MM-DD'];
  const sections = groupByFile(rows.filter((r) => ganttDate(r.due))).map(([file, tasks]) => [file, orderByPrerequisites(tasks)] as const);
  // Ids are numbered in chart order.
  const links = ganttLinks(sections.flatMap(([, tasks]) => tasks));
  for (const [file, tasks] of sections) {
    out.push(`  section ${ganttText(file || 'Tasks')}`);
    for (const t of tasks) out.push(`    ${ganttTask(t, links)}`);
  }
  return out.join('\n') + '\n';
}

/** The Mermaid id of each charted task another one depends on, and each task's charted prerequisites. */
interface GanttLinks { ids: Map<TaskExportRow, string>; before: Map<TaskExportRow, TaskExportRow[]> }

/** Words Mermaid reads in a task's data as a tag or a start, so they can't be ids. */
const GANTT_WORDS = new Set(['after', 'until', 'active', 'done', 'crit', 'milestone', 'vert']);

/** A task's own id when Mermaid can read it in `after` and no other charted task has it, else `task-N`. */
function ganttLinks(rows: TaskExportRow[]): GanttLinks {
  const before = new Map<TaskExportRow, TaskExportRow[]>();
  taskPrerequisites(rows).forEach((p, i) => { if (p.length) before.set(rows[i], p.map((j) => rows[j])); });
  const position = new Map(rows.map((r, i) => [r, i]));
  const needed = [...new Set([...before.values()].flat())].sort((a, b) => position.get(a)! - position.get(b)!);
  const count = new Map<string, number>();
  for (const r of rows) if (r.id) count.set(r.id.toLowerCase(), (count.get(r.id.toLowerCase()) ?? 0) + 1);
  const ids = new Map<TaskExportRow, string>();
  const taken = new Set<string>();
  for (const r of needed) {
    const own = r.id && /^[a-z][\w-]*$/i.test(r.id) && !GANTT_WORDS.has(r.id.toLowerCase()) && count.get(r.id.toLowerCase()) === 1;
    if (own) { ids.set(r, r.id!); taken.add(r.id!.toLowerCase()); }
  }
  let n = 0;
  for (const r of needed) {
    if (ids.has(r)) continue;
    let id: string;
    do id = `task-${++n}`; while (taken.has(id));
    ids.set(r, id);
  }
  return { ids, before };
}

/**
 * `Ship it @maya :crit, milestone, 2026-10-01, 0d`, with its id when another task depends on it, and
 * `Write it :after spec, 2026-10-05` for a task that waits for charted tasks due no later than it.
 */
function ganttTask(t: TaskExportRow, links: GanttLinks): string {
  const name = [t.text, ...t.assignees].filter(Boolean).join(' ') || `Task on line ${t.line + 1}`;
  const id = links.ids.get(t);
  const before = links.before.get(t) ?? [];
  const after = before.length && before.every((p) => p.due! <= t.due!) ? `after ${before.map((p) => links.ids.get(p)).join(' ')}` : '';
  const tags = [t.done ? 'done' : '', t.overdue ? 'crit' : '', after ? '' : 'milestone'].filter(Boolean);
  const data = [...tags, ...(id ? [id] : []), ...(after ? [after, t.due!] : [t.due!, '0d'])];
  return `${ganttTaskName(name)} :${data.join(', ')}`;
}

/** The chart wrapped in a small `.smd` document with a `mermaid` fence, for `smd render`. */
export function ganttDocument(chart: string, title = 'Tasks'): string {
  const name = title.replace(/\s+/g, ' ').trim() || 'Tasks';
  const quoted = JSON.stringify(name);
  return `---\nsmd: ${SMD_VERSION}\ntitle: ${quoted}\n---\n\n# ${name}\n\n\`\`\`mermaid\n${chart.trimEnd()}\n\`\`\`\n`;
}

/** The due date when it is a real calendar date in YYYY-MM-DD form, as the Gantt chart needs. */
export function ganttDate(due: string | undefined): string | undefined {
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return undefined;
  const time = Date.parse(due);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(due) ? due : undefined;
}

function groupByFile(rows: TaskExportRow[]): Array<[string, TaskExportRow[]]> {
  const groups = new Map<string, TaskExportRow[]>();
  for (const r of rows) {
    const file = r.file ?? '';
    const list = groups.get(file);
    if (list) list.push(r);
    else groups.set(file, [r]);
  }
  const byDate = (a: TaskExportRow, b: TaskExportRow) => a.due!.localeCompare(b.due!) || a.line - b.line;
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, tasks]) => [file, [...tasks].sort(byDate)]);
}

/**
 * Words that start a statement when a Gantt line begins with them (Mermaid's lexer ignores case
 * and tries them before task names), and dates, which would be read as one.
 */
const GANTT_KEYWORDS = new Set([
  'gantt', 'dateformat', 'inclusiveenddates', 'topaxis', 'axisformat', 'tickinterval', 'includes', 'excludes', 'todaymarker',
  'weekday', 'weekend', 'title', 'accdescription', 'accdescr', 'acctitle', 'section', 'click', 'call', 'href',
]);

/** A task name: `ganttText`, and a leading keyword's first letter as an entity code (`#84;itle page`). */
function ganttTaskName(name: string): string {
  const text = ganttText(name);
  const word = /^[a-z]+/i.exec(text)?.[0].toLowerCase() ?? '';
  const statement = GANTT_KEYWORDS.has(word) || /^\d{4}-\d\d-\d\d/.test(text);
  return statement ? entity(text[0]) + text.slice(1) : text;
}

/**
 * One line of Gantt text. `:` ends a task name, `#` and `;` end its data, `%` starts a comment, and
 * `#…;` is Mermaid's entity syntax, so all four become entity codes (`#58;`), which Mermaid shows as
 * the character itself. Line breaks become spaces.
 */
function ganttText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[:#;%]/g, entity).trim();
}

function entity(ch: string): string {
  return `#${ch.codePointAt(0)};`;
}
