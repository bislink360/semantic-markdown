/**
 * Markdown as other renderers draw a `.md` file, for the playground's Compare tab. Every piece is an independent
 * open-source renderer, none of Semantic Markdown's own, so the comparison is fair. Two renderers:
 *
 * - renderGithubMarkdown draws it as GitHub does: markdown-it (CommonMark, tables, strikethrough, autolinks),
 * markdown-it-github-alerts (`> [!NOTE]`), @vscode/markdown-it-katex (`$…$` and `$$…$$` math, as in VS Code's
 * Markdown preview), markdown-it-footnote (`[^1]`), markdown-it-emoji (`:rocket:` shortcodes, without `:)`
 * smileys, which GitHub leaves alone) and Mermaid for ```mermaid fences, drawn in the preview frame. Task lists,
 * footnotes and front matter are written as GitHub writes them, raw HTML is filtered as GitHub filters it
 * (githubHtml.ts), and the frame styles the result with github-markdown-css.
 * - renderCommonMark draws it as a plain renderer does, the baseline every Markdown tool supports: markdown-it's
 *   default rules (CommonMark, tables, strikethrough, autolinks) and nothing more. Alerts stay quotes with their
 *   `[!TIP]` line, math stays text, diagrams stay code and task items keep their brackets. Front matter is hidden,
 *   as most renderers hide it, and the frame styles the result plainly (playground/plain-markdown.css).
 *
 * The Compare tab draws two documents with either: the `.smd` text as if the file were renamed to `.md`, and what
 * `smd export --to md` writes.
 */
import MarkdownIt, { type StateCore, type Token } from 'markdown-it';
import githubAlerts from 'markdown-it-github-alerts';
import mathKatex from '@vscode/markdown-it-katex';
import footnotes from 'markdown-it-footnote';
import { full as emoji } from 'markdown-it-emoji';
import { githubHtml } from './githubHtml';
import { parseFrontMatter } from '../core/frontmatter';

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
    // Its own token type, so the HTML filter (which keeps no <input>) leaves GitHub's own checkbox alone.
    const box = new state.Token('github_task_checkbox', '', 0);
    box.meta = { checked: match[1] !== ' ' };
    inline.children.unshift(box);
    tokens[i - 2].attrJoin('class', 'task-list-item');
    const list = listOf(tokens, i - 2);
    if (list && !list.attrGet('class')?.includes('contains-task-list')) list.attrJoin('class', 'contains-task-list');
  }
}

const md = new MarkdownIt('default', { html: true, linkify: true });
md.use(githubAlerts);
md.use(mathKatex, { throwOnError: false, enableFencedBlocks: true });
md.use(footnotes);
md.use(emoji, { shortcuts: {} });
md.core.ruler.push('github_task_lists', taskLists);
md.renderer.rules.github_task_checkbox = (tokens, idx) =>
  `<input type="checkbox" class="task-list-item-checkbox" disabled${tokens[idx].meta?.checked ? ' checked' : ''}> `;

// Raw HTML from the document, filtered as GitHub filters it. Markup the renderers write themselves is not raw HTML.
md.renderer.rules.html_block = (tokens, idx) => githubHtml(tokens[idx].content);
md.renderer.rules.html_inline = (tokens, idx) => githubHtml(tokens[idx].content);

// Footnotes in GitHub's markup: plain numbers, user-content- ids and a "Footnotes" heading for screen readers.
const footnoteNumber = (tokens: Token[], idx: number) => String((tokens[idx].meta?.id ?? 0) + 1);
const footnoteSub = (tokens: Token[], idx: number) => (tokens[idx].meta?.subId > 0 ? `-${tokens[idx].meta.subId + 1}` : '');
md.renderer.rules.footnote_ref = (tokens, idx) => {
  const n = footnoteNumber(tokens, idx);
  return `<sup><a href="#user-content-fn-${n}" id="user-content-fnref-${n}${footnoteSub(tokens, idx)}" data-footnote-ref aria-describedby="footnote-label">${n}</a></sup>`;
};
md.renderer.rules.footnote_block_open = () => '<section data-footnotes class="footnotes"><h2 id="footnote-label" class="sr-only">Footnotes</h2>\n<ol>\n';
md.renderer.rules.footnote_open = (tokens, idx) => `<li id="user-content-fn-${footnoteNumber(tokens, idx)}">`;
md.renderer.rules.footnote_anchor = (tokens, idx) => {
  const n = footnoteNumber(tokens, idx);
  return ` <a href="#user-content-fnref-${n}${footnoteSub(tokens, idx)}" data-footnote-backref aria-label="Back to reference ${n}" class="data-footnote-backref">↩</a>`;
};

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

const plain = new MarkdownIt('default', { html: true, linkify: true });

/** Markdown as a plain renderer draws a `.md` file: the body only, in a `.plain-body` article. */
export function renderCommonMark(text: string): string {
  const fm = parseFrontMatter(text);
  const body = fm.present && fm.bodyStartLine > 0 ? fm.body : text;
  return `<article class="plain-body">\n${plain.render(body)}</article>`;
}
