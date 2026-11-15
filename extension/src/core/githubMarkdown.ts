/**
 * Markdown drawn the way GitHub draws a `.md` file, for the playground's Compare tab. Every piece is an independent
 * open-source renderer, none of Semantic Markdown's own: markdown-it (CommonMark, tables, strikethrough, autolinks),
 * markdown-it-github-alerts (`> [!NOTE]`), @vscode/markdown-it-katex (`$…$` and `$$…$$` math, as in VS Code's
 * Markdown preview), and Mermaid for ```mermaid fences, drawn in the preview frame. Task lists and front matter are
 * written as GitHub writes them, and the frame styles the result with github-markdown-css.
 *
 * The Compare tab draws two things with it: the `.smd` text as if the file were renamed to `.md`, and what
 * `smd export --to md` writes. Neither depends on how Semantic Markdown renders, so the comparison is fair.
 */
import MarkdownIt, { type StateCore, type Token } from 'markdown-it';
import githubAlerts from 'markdown-it-github-alerts';
import mathKatex from '@vscode/markdown-it-katex';
import { parseFrontMatter } from './frontmatter';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** One front matter value as a table cell's content: lists and mappings become nested tables, as on GitHub. */
function valueHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return `<table><tbody><tr>${value.map((v) => `<td>${valueHtml(v)}</td>`).join('')}</tr></tbody></table>`;
  }
  if (typeof value === 'object') return frontMatterTable(value as Record<string, unknown>);
  return escapeHtml(String(value));
}

function frontMatterTable(data: Record<string, unknown>): string {
  const keys = Object.keys(data);
  const head = keys.map((k) => `<th>${escapeHtml(k)}</th>`).join('');
  const row = keys.map((k) => `<td>${valueHtml(data[k])}</td>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody><tr>${row}</tr></tbody></table>\n`;
}

const TASK = /^\[([ xX])\][ \t]/;

/** The list that holds the item opened at `item`. */
function listOf(tokens: Token[], item: number): Token | undefined {
  for (let i = item - 1; i >= 0; i--) {
    const t = tokens[i];
    if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === tokens[item].level - 1) return t;
  }
  return undefined;
}

/** `- [ ]` and `- [x]` items become disabled checkboxes, with the classes GitHub gives them. */
function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const first = inline.children?.[0];
    const match = first?.type === 'text' ? TASK.exec(first.content) : null;
    if (!first || !match || !inline.children) continue;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${match[1] === ' ' ? '' : ' checked'}> `;
    inline.children.unshift(box);
    tokens[i - 2].attrJoin('class', 'task-list-item');
    const list = listOf(tokens, i - 2);
    if (list && !list.attrGet('class')?.includes('contains-task-list')) list.attrJoin('class', 'contains-task-list');
  }
}

const md = new MarkdownIt('default', { html: true, linkify: true });
md.use(githubAlerts);
md.use(mathKatex, { throwOnError: false, enableFencedBlocks: true });
md.core.ruler.push('github_task_lists', taskLists);

// ```mermaid fences become the markup the preview frame's runtime draws with Mermaid; other fences stay code.
const fence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = tokens[idx].info.trim().split(/\s+/)[0]?.toLowerCase();
  if (info === 'mermaid') return `<div class="smd-diagram"><pre class="smd-mermaid">${escapeHtml(tokens[idx].content)}</pre></div>\n`;
  return fence ? fence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

/** Markdown as GitHub draws a `.md` file: front matter as a table, then the body, in a `.markdown-body` article. */
export function renderGithubMarkdown(text: string): string {
  const fm = parseFrontMatter(text);
  let head = '';
  let body = text;
  if (fm.present && fm.bodyStartLine > 0) {
    body = fm.body;
    // GitHub shows front matter it can't read as an error; this shows it as YAML so it isn't lost.
    head = fm.error ? md.render(`\`\`\`yaml\n${text.split(/\r?\n/).slice(1, fm.bodyStartLine - 1).join('\n')}\n\`\`\`\n`) : frontMatterTable(fm.data);
  }
  return `<article class="markdown-body">\n${head}${md.render(body)}</article>`;
}
