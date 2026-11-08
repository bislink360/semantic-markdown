import type { StateCore, Token } from 'markdown-it';
import { renderInlineDirective } from './markdownItHtml';
import type { DirectiveMeta, TaskBoxMeta } from './markdownItRules';
import type { SmdContext } from './markdownItSetup';
import { countsTasks, type TaskCount } from './progress';
import { specEnv } from './specVersion';

/**
 * `:progress{basis=tasks}` (research AF25): once every task has its checkbox, count the checked tasks of the bar's
 * section (the nearest heading above it, subsections included; the whole document above the first heading) and
 * render the bar again with the counts. The counts go on the token's meta too, for exports.
 */
export function progressTasks(state: StateCore, ctx: SmdContext): void {
  const tokens = state.tokens;
  const headings: Array<{ at: number; level: number }> = [];
  const tasks: Array<{ at: number; checked: boolean }> = [];
  const bars: Array<{ at: number; token: Token }> = [];
  tokens.forEach((t, at) => {
    if (t.type === 'heading_open') headings.push({ at, level: Number(t.tag.slice(1)) || 1 });
    if (t.type !== 'inline') return;
    for (const child of t.children ?? []) {
      const meta = child.meta as (Partial<TaskBoxMeta> & Partial<DirectiveMeta>) | null;
      if (meta?.taskBox) tasks.push({ at, checked: !!meta.checked });
      else if (child.type === 'html_inline' && meta?.directive === 'progress' && countsTasks(meta.values ?? {})) bars.push({ at, token: child });
    }
  });
  if (!bars.length) return;
  const { today } = ctx.options(state.env);
  const m = ctx.messages(state.env);
  const spec = specEnv(state.env);
  for (const bar of bars) {
    let h = -1;
    while (h + 1 < headings.length && headings[h + 1].at <= bar.at) h++;
    const start = h < 0 ? -1 : headings[h].at;
    const next = h < 0 ? undefined : headings.slice(h + 1).find((x) => x.level <= headings[h].level);
    const end = next?.at ?? tokens.length;
    const inside = tasks.filter((t) => t.at > start && t.at < end);
    const counts: TaskCount = { checked: inside.filter((t) => t.checked).length, total: inside.length };
    const meta = bar.token.meta as DirectiveMeta;
    meta.progress = counts;
    bar.token.content = renderInlineDirective(state.md, 'progress', meta.content, meta.values, today, m, spec, counts);
  }
}
