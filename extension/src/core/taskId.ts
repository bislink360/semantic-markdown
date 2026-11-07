/** The `{#id}` a task's line may end with (see splitTaskId). */
const TASK_ID = /^\{#([A-Za-z0-9_-]+)\}$/;

/**
 * A task's text without its id, and the id, when it has one: a trailing `{#id}` on the line after a space, the form
 * headings use (`- [ ] Ship it {#ship}`), so the line stays a GitHub task in plain Markdown. Only an id is read there:
 * a list with other items (`{#ship .x}`), braces right after text (`:badge[x]{#y}`) or `\{#ship}` stay text.
 */
export function splitTaskId(body: string): { text: string; id?: string } {
  const end = body.trimEnd();
  const open = end.lastIndexOf('{');
  if (open < 1 || !/\s/.test(end[open - 1])) return { text: body };
  const m = TASK_ID.exec(end.slice(open));
  return m ? { text: end.slice(0, open).trimEnd(), id: m[1] } : { text: body };
}
