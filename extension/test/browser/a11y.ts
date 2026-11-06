// Real-browser accessibility checks for the HTML the extension shows: the preview, the Block Editor and exported
// pages (a standalone HTML export and an `smd build` site page). The source assertions in accessibility.test.ts,
// blockEditorWebview.test.ts and contrast.test.ts check the markup and the CSS; these load the pages in an installed
// Chromium-based browser (the one `smd export --to pdf` uses, see src/pdfBrowser.ts) and check what the browser
// makes of them: the accessibility tree, the Tab order, visible focus, the keyboard on tabs, disclosures and task
// boxes, and reduced motion. The agent-view inspector is plain VS Code UI (a read-only text document, a status bar
// item and quick picks), so it has no page of its own to check here.
//
//   npm run test:a11y [-- --json] [-- --require-browser] [-- --keep]
//
// No browser installed: prints "skipped" and exits 0, unless --require-browser is given.
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BlockEditorSession, readEditorMessage, type HostMessage } from '../../src/blockEditorSession';
import { buildSite, renderSmd, renderStandaloneHtml, type RenderOptions } from '../../src/core';
import { renderBlocks, segmentSmd } from '../../src/core/blocks';
import { scanInline } from '../../src/core/inlineEdit';
import { readTable } from '../../src/core/tableEdit';
import { blockTemplates, type Snippet } from '../../src/core/templates';
import { browserArgs, Connection, findInstalledBrowsers, type InstalledBrowser } from '../../src/pdfBrowser';
import { webviewShell } from '../../src/webviewShell';
import { readerFor } from '../../src/workspace';

export const EXTENSION = path.join(__dirname, '..', '..');
export const MEDIA = path.join(EXTENSION, 'media');
export const SAMPLES = path.join(EXTENSION, 'test', 'samples');
/** The documents every page is built from: tabs, details, tasks, decisions, diagrams, math, tables. */
export const SAMPLE_FILES = ['showcase.smd', 'checkout-redesign.smd'];

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export interface A11yArgs {
  json: boolean;
  requireBrowser: boolean;
  /** Keep the temporary folder with the pages (for a look in a browser). */
  keep: boolean;
}

export function parseArgs(argv: readonly string[]): A11yArgs {
  const known = new Set(['--json', '--require-browser', '--keep']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(' ')}. Options: ${[...known].join(' ')}`);
  return { json: argv.includes('--json'), requireBrowser: argv.includes('--require-browser'), keep: argv.includes('--keep') };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Stands in for VS Code's webview API: messages the page posts are kept for the harness to read, state is kept in
 * memory. Also opens closed shadow roots (the Block Editor's controls live in them) so the harness can walk the
 * DOM; the accessibility tree and the Tab order are the same either way.
 */
export const VSCODE_STUB = `(function () {
  'use strict';
  var state;
  window.__smdOutbox = [];
  window.__smdSent = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) { var copy = JSON.parse(JSON.stringify(m)); window.__smdOutbox.push(copy); window.__smdSent.push(copy); },
      getState: function () { return state; },
      setState: function (s) { state = s; },
    };
  };
  var attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { return attach.call(this, Object.assign({}, init, { mode: 'open' })); };
})();
`;

/** Where a page finds its files: the extension's media folder, the stub, and the Block Editor's bundled script. */
export interface PageUrls {
  media(...parts: string[]): string;
  stub: string;
  blockEditorScript?: string;
}

export const fileUrl = (file: string) => pathToFileURL(file).href;

export function localUrls(stub: string, blockEditorScript?: string): PageUrls {
  return { media: (...parts) => fileUrl(path.join(MEDIA, ...parts)), stub: fileUrl(stub), blockEditorScript: blockEditorScript && fileUrl(blockEditorScript) };
}

// These lists mirror the shell() methods of src/preview.ts and src/blockEditor.ts, which need `vscode` and so can't
// be imported here; browserA11y.test.ts fails when they drift apart.
export const PREVIEW_STYLES: readonly string[][] = [['vendor', 'katex', 'katex.min.css'], ['smd.css']];
export const PREVIEW_SCRIPTS: readonly string[][] = [['vendor', 'mermaid.min.js'], ['runtime.js']];
export const BLOCK_EDITOR_STYLES: readonly string[][] = [['vendor', 'katex', 'katex.min.css'], ['smd.css'], ['block-editor.css']];
export const BLOCK_EDITOR_SCRIPTS: readonly string[][] = [['vendor', 'mermaid.min.js'], ['runtime.js']];
/** The webview's resource origin, as the page's CSP names it (VS Code's cspSource). */
const CSP_SOURCE = 'file:';

/** The preview's render options with the default settings (smd.preview.allowHtml, smd.preview.showAgentBlocks). */
export function previewRenderOptions(file: string): RenderOptions {
  return { readFile: readerFor(file), allowHtml: true, agentBlocks: 'collapsed' };
}

/** themePreference() of src/preview.ts with smd.preview.theme at its default ("auto"). */
export function themePref(frontMatter: Record<string, unknown>): string {
  const theme = String(frontMatter.theme).toLowerCase();
  return theme === 'light' || theme === 'dark' ? theme : 'auto';
}

const dirUrl = (file: string) => `${fileUrl(path.dirname(path.resolve(file))).replace(/\/$/, '')}/`;

/** The preview's page for a document, as Preview.shell() builds it, with the stub first. */
export function previewPage(text: string, file: string, urls: PageUrls, nonce?: string): string {
  const result = renderSmd(text, previewRenderOptions(file));
  const sync = { version: 1, since: 1, edits: [] };
  return webviewShell({
    cspSource: CSP_SOURCE,
    nonce,
    lang: result.lang ?? 'en',
    htmlAttributes: { 'data-smd-theme-pref': themePref(result.frontMatter) },
    baseHref: dirUrl(file),
    styles: PREVIEW_STYLES.map((p) => urls.media(...p)),
    bodyClass: 'smd-body',
    body: `<main id="smd-root" data-smd-sync="${escapeAttr(JSON.stringify(sync))}">${result.html}</main>`,
    scripts: [urls.stub, ...PREVIEW_SCRIPTS.map((p) => urls.media(...p))],
  });
}

/** The Block Editor's page, as BlockEditorPanel.shell() builds it, with the stub first. Its content comes from the host. */
export function blockEditorPage(file: string, urls: PageUrls, nonce?: string): string {
  if (!urls.blockEditorScript) throw new Error('The Block Editor page needs its script.');
  const css = urls.media('block-editor.css');
  return webviewShell({
    cspSource: CSP_SOURCE,
    nonce,
    lang: 'en',
    htmlAttributes: { 'data-smd-theme-pref': 'auto' },
    baseHref: dirUrl(file),
    styles: BLOCK_EDITOR_STYLES.map((p) => urls.media(...p)),
    bodyClass: 'smd-body smd-ed-body',
    mode: 'block-editor',
    bodyAttributes: { 'data-smd-ed-css': css },
    body: '<div id="smd-ed-toolbar"></div>\n<main id="smd-root" class="smd-ed-root"></main>',
    scripts: [urls.stub, ...BLOCK_EDITOR_SCRIPTS.map((p) => urls.media(...p)), urls.blockEditorScript],
  });
}

/** Exported HTML loads KaTeX's stylesheet and Mermaid from a CDN; here they come from the extension's own copies. */
export function localizeCdn(html: string, urls: Pick<PageUrls, 'media'>): string {
  return html
    .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[^/"]+\/dist\/katex\.min\.css/g, urls.media('vendor', 'katex', 'katex.min.css'))
    .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@[^/"]+\/dist\/mermaid\.min\.js/g, urls.media('vendor', 'mermaid.min.js'));
}

/** `smd export --to html`: one page with the stylesheet and the runtime inlined. */
export function standalonePage(text: string, file: string, urls: Pick<PageUrls, 'media'>): string {
  const css = fs.readFileSync(path.join(MEDIA, 'smd.css'), 'utf8');
  const runtime = fs.readFileSync(path.join(MEDIA, 'runtime.js'), 'utf8');
  return localizeCdn(renderStandaloneHtml(text, css, runtime, previewRenderOptions(file)), urls);
}

/** The site's own files are filled in by the bundler (empty under tsx): take them from media/. */
const SITE_ASSETS: Readonly<Record<string, string>> = {
  '_smd/smd.css': 'smd.css', '_smd/site.css': 'site.css', '_smd/runtime.js': 'runtime.js', '_smd/site.js': 'site.js',
};

/** `smd build`: every file of the site of the samples, ready to write. */
export function siteFiles(sources: ReadonlyArray<{ path: string; text: string }>, urls: Pick<PageUrls, 'media'>): Array<{ path: string; content: string }> {
  return buildSite([...sources], {}).files.map((f) => {
    const asset = SITE_ASSETS[f.path];
    if (asset) return { path: f.path, content: fs.readFileSync(path.join(MEDIA, asset), 'utf8') };
    return { path: f.path, content: f.path.endsWith('.html') ? localizeCdn(f.content, urls) : f.content };
  });
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** What a page would load from another machine: scripts, images, frames and stylesheets (links to follow don't count). */
export function remoteUrls(html: string): string[] {
  const loaded = [
    ...html.matchAll(/\bsrc="((?:https?:)?\/\/[^"]+)"/g),
    ...html.matchAll(/<link\b[^>]*\bhref="((?:https?:)?\/\/[^"]+)"/g),
  ];
  return [...new Set(loaded.map((m) => m[1]))];
}

// ---------------------------------------------------------------------------
// The accessibility tree (Accessibility.getFullAXTree), analysed
// ---------------------------------------------------------------------------

export interface AXValue { type: string; value?: unknown }
export interface AXProperty { name: string; value: AXValue }
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  properties?: AXProperty[];
  backendDOMNodeId?: number;
  childIds?: string[];
  parentId?: string;
}

/** Roles a person operates; each needs an accessible name (WCAG 4.1.2). Chromium calls <summary> DisclosureTriangle. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'slider', 'spinbutton', 'treeitem', 'DisclosureTriangle', 'PopUpButton',
]);
/** Roles that are a picture; each needs a text alternative (WCAG 1.1.1). */
export const IMAGE_ROLES: ReadonlySet<string> = new Set(['image', 'img', 'graphics-document', 'graphics-symbol', 'Canvas', 'SvgRoot']);
export const LANDMARK_ROLES: ReadonlySet<string> = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search']);

export const roleOf = (n: AXNode) => String(n.role?.value ?? '');
export const nameOf = (n: AXNode) => String(n.name?.value ?? '').trim();
export function property(n: AXNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value.value;
}

/** Controls (interactive roles, not ignored) with no accessible name. */
export function unnamedControls(nodes: readonly AXNode[]): AXNode[] {
  return nodes.filter((n) => !n.ignored && INTERACTIVE_ROLES.has(roleOf(n)) && !nameOf(n));
}

/** Pictures with no text alternative. */
export function unnamedImages(nodes: readonly AXNode[]): AXNode[] {
  return nodes.filter((n) => !n.ignored && IMAGE_ROLES.has(roleOf(n)) && !nameOf(n));
}

/**
 * Other things that can take focus (scroll areas, tab panels, blocks reached with the arrow keys) and would be
 * announced with no name. Advisory: their content is read. Landmarks that take focus from a skip link are left out.
 */
export function unnamedFocusables(nodes: readonly AXNode[]): AXNode[] {
  return nodes.filter((n) => !n.ignored && property(n, 'focusable') === true && roleOf(n) !== 'RootWebArea'
    && !INTERACTIVE_ROLES.has(roleOf(n)) && !LANDMARK_ROLES.has(roleOf(n)) && !nameOf(n));
}

export interface Landmark { role: string; name: string }

export function landmarks(nodes: readonly AXNode[]): Landmark[] {
  return nodes.filter((n) => !n.ignored && LANDMARK_ROLES.has(roleOf(n))).map((n) => ({ role: roleOf(n), name: nameOf(n) }));
}

/** What a page should have: a role, with this name when one is given, and how many (exactly one main by default). */
export interface ExpectedRole { role: string; name?: string; exactly?: number }

/** Expected roles missing from (or repeated in) the tree. `toolbar` and other non-landmark roles are looked up too. */
export function missingRoles(nodes: readonly AXNode[], expected: readonly ExpectedRole[]): string[] {
  const shown = nodes.filter((n) => !n.ignored);
  const problems: string[] = [];
  for (const e of expected) {
    const found = shown.filter((n) => roleOf(n) === e.role && (e.name === undefined || nameOf(n) === e.name));
    const label = e.name === undefined ? e.role : `${e.role} "${e.name}"`;
    if (!found.length) problems.push(`no ${label}`);
    else if (e.exactly !== undefined && found.length !== e.exactly) problems.push(`${found.length} × ${label}, expected ${e.exactly}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// ID references (one tree scope at a time: the document and each shadow root)
// ---------------------------------------------------------------------------

export interface IdScope {
  scope: string;
  ids: string[];
  refs: Array<{ attr: string; ids: string[]; where: string }>;
}

/** References to ids that are missing or not unique in their scope (WCAG 4.1.2: names, descriptions, relations). */
export function idRefProblems(scopes: readonly IdScope[]): string[] {
  const problems: string[] = [];
  for (const s of scopes) {
    const count = new Map<string, number>();
    for (const id of s.ids) count.set(id, (count.get(id) ?? 0) + 1);
    for (const ref of s.refs) {
      for (const id of ref.ids) {
        const n = count.get(id) ?? 0;
        if (n === 0) problems.push(`${ref.where}: ${ref.attr} → "${id}" is not in the ${s.scope}`);
        else if (n > 1) problems.push(`${ref.where}: ${ref.attr} → "${id}" is used by ${n} elements in the ${s.scope}`);
      }
    }
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------
// Tab order and visible focus
// ---------------------------------------------------------------------------

/** Where one press of Tab left focus. */
export interface TabStep {
  /** Focus went back to the document (past the last control). */
  body: boolean;
  desc?: string;
  /** Position in document order (shadow trees in place), at the time of the step. */
  order?: number;
  /** Index in the list of tabbable elements taken before the walk; -1 when it was not in it. */
  expected?: number;
  outlineStyle?: string;
  outlineWidth?: string;
  boxShadow?: string;
  focusVisible?: boolean;
  inView?: boolean;
  opacity?: number;
}

export interface TabWalk {
  /** Tabbable elements before the walk that focus never reached. */
  unreached: string[];
  /** Steps that went back up the page (other than the wrap past the end). */
  backwards: string[];
  /** Focus stayed on one element, or never got back past the end. */
  trap?: string;
  /** Focused elements with no visible focus indicator, or hidden or off screen when focused. */
  invisible: string[];
  /** Distinct elements focused. */
  reached: number;
}

/**
 * The same stop on every pass: its place in the list of tabbable elements, or its description for one that was not
 * in it (positions in the document can shift when a script adds an element, such as a live region).
 */
export const stepKey = (s: TabStep) => (s.expected !== undefined && s.expected >= 0 ? `#${s.expected}` : `${s.desc}`);

/** A focus ring the browser draws: an outline that is not `none` and has a width, or a box shadow. */
export function hasFocusIndicator(style: Pick<TabStep, 'outlineStyle' | 'outlineWidth' | 'boxShadow'>): boolean {
  const outline = !!style.outlineStyle && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth ?? '0') > 0;
  const shadow = !!style.boxShadow && style.boxShadow !== 'none';
  return outline || shadow;
}

/**
 * Read a Tab walk: every tabbable element reached (WCAG 2.1.1), no trap (2.1.2), document order (2.4.3), and a
 * visible focus indicator on something on screen (2.4.7, 2.4.11). `expected` names the tabbable elements found
 * before the walk; `stillTabbable[i]` says whether element i could still take focus after it (a roving tabindex
 * moves the tab stop as focus moves).
 */
export function analyseTabWalk(expected: readonly string[], steps: readonly TabStep[], stillTabbable: readonly boolean[] = []): TabWalk {
  const seen = new Set<number>();
  const backwards: string[] = [];
  const invisible: string[] = [];
  const reached = new Set<string>();
  let wrapped = false;
  let previous: TabStep | undefined;
  let trap: string | undefined;
  let repeats = 0;
  for (const step of steps) {
    if (step.body) {
      if (previous && !previous.body) wrapped = true;
      previous = step;
      repeats = 0;
      continue;
    }
    if (step.expected !== undefined && step.expected >= 0) seen.add(step.expected);
    const desc = step.desc ?? '?';
    reached.add(stepKey(step));
    if (previous && !previous.body && previous.order !== undefined && step.order !== undefined) {
      if (step.order === previous.order) {
        repeats++;
        if (repeats >= 2) trap ??= `focus stays on ${desc}`;
      } else if (step.order < previous.order) {
        if (step.order <= 1 || reached.size >= expected.length) wrapped = true;
        else backwards.push(`${previous.desc} → ${desc}`);
        repeats = 0;
      } else {
        repeats = 0;
      }
    }
    if (!hasFocusIndicator(step)) invisible.push(`${desc}: no outline or box-shadow`);
    else if (step.inView === false) invisible.push(`${desc}: off screen when focused`);
    else if ((step.opacity ?? 1) < 0.5) invisible.push(`${desc}: opacity ${step.opacity} when focused`);
    previous = step;
  }
  if (!wrapped && !trap && steps.length) trap = 'focus never came back round past the last control';
  const unreached = expected.filter((_, i) => !seen.has(i) && stillTabbable[i] !== false);
  return { unreached, backwards, trap, invisible: [...new Set(invisible)], reached: reached.size };
}

// ---------------------------------------------------------------------------
// WAI-ARIA tabs
// ---------------------------------------------------------------------------

export interface TabsState {
  focused: number;
  selected: Array<string | null>;
  tabindex: Array<string | null>;
  /** Whether each tab's panel (aria-controls) is shown; null when the tab controls nothing found. */
  panels: Array<boolean | null>;
}

/** Problems with a tab list after a key that should have selected tab `want`. */
export function tabsProblems(want: number, state: TabsState): string[] {
  const problems: string[] = [];
  if (state.focused !== want) problems.push(`focus on tab ${state.focused + 1}, expected ${want + 1}`);
  state.selected.forEach((s, i) => {
    if (s !== String(i === want)) problems.push(`tab ${i + 1} aria-selected=${s}`);
  });
  state.tabindex.forEach((t, i) => {
    if (t !== (i === want ? '0' : '-1')) problems.push(`tab ${i + 1} tabindex=${t}`);
  });
  state.panels.forEach((shown, i) => {
    if (shown === null) problems.push(`tab ${i + 1} controls no panel`);
    else if (shown !== (i === want)) problems.push(`panel ${i + 1} ${shown ? 'shown' : 'hidden'}`);
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** "0s, .15s, 200ms" in seconds. */
export function seconds(list: string | undefined): number[] {
  return (list ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s.endsWith('ms') ? parseFloat(s) / 1000 : parseFloat(s)) || 0);
}

export interface MotionStyle {
  desc: string;
  transitionProperty: string;
  transitionDuration: string;
  animationName: string;
  animationDuration: string;
}

/** The longest transition or animation an element has, in seconds (a transition of `none` or an animation of `none` counts as 0). */
export function longestMotion(style: MotionStyle): number {
  const transition = style.transitionProperty === 'none' ? 0 : Math.max(0, ...seconds(style.transitionDuration));
  const animation = style.animationName === 'none' ? 0 : Math.max(0, ...seconds(style.animationDuration));
  return Math.max(transition, animation);
}

/** Longer than this still moves under prefers-reduced-motion: reduce (WCAG 2.3.3). */
export const MOTION_LIMIT = 0.01;

/**
 * The CSS a page uses: its <style> blocks and the stylesheets it links (resolved against <base href>, as the browser
 * does). Read from disk, because a file:// page can't read its own stylesheets' rules.
 */
export function pageCss(html: string, pageUrl: string, read: (url: string) => string | undefined): string[] {
  const base = /<base href="([^"]+)"/.exec(html)?.[1] ?? pageUrl;
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const linked = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => read(new URL(m[1].replace(/&amp;/g, '&'), base).href));
  return [...inline, ...linked.filter((css): css is string => css !== undefined)];
}

export const claimsReducedMotion = (css: readonly string[]) => css.some((text) => /@media[^{]*prefers-reduced-motion:\s*reduce/.test(text));

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type Status = 'pass' | 'fail' | 'known' | 'warn' | 'skip';

export interface CheckResult {
  page: string;
  check: string;
  status: Status;
  detail: string;
  items?: string[];
}

/**
 * Accessibility bugs found by these checks and not fixed yet. A failure whose page, check and one of whose items
 * match is reported as `known` (listed, not failing the run); one that no longer shows up is reported, so the entry
 * can go.
 */
export interface KnownFailure {
  page: RegExp;
  check: string;
  item: RegExp;
  /** What fails, where, and the WCAG success criterion. */
  note: string;
}

export const KNOWN_FAILURES: readonly KnownFailure[] = [
  {
    page: /./,
    check: 'image text',
    item: /^graphics-document: <svg id="smd-mermaid-\d+"/,
    note: 'Mermaid diagrams (every page): a diagram without accTitle/accDescr becomes an <svg role="graphics-document"> with no '
      + 'accessible name or description, and media/runtime.js replaces the diagram source, its only text version, with the SVG '
      + '(WCAG 1.1.1 Non-text Content). Mermaid names the SVG when the source has accTitle:/accDescr: lines; nothing warns '
      + 'when they are missing, and the figure caption or the source is not used instead.',
  },
];

/** Failures matched by known failures become `known` when every item is known; the rest stay `fail`. */
export function applyKnown(results: readonly CheckResult[], known: readonly KnownFailure[]): { results: CheckResult[]; unseen: KnownFailure[] } {
  const used = new Set<KnownFailure>();
  const out = results.map((r) => {
    if (r.status !== 'fail') return r;
    const matching = known.filter((k) => k.page.test(r.page) && k.check === r.check);
    if (!matching.length) return r;
    const items = r.items?.length ? r.items : [r.detail];
    const unknown = items.filter((item) => {
      const k = matching.find((m) => m.item.test(item));
      if (k) used.add(k);
      return !k;
    });
    if (unknown.length) return { ...r, items: unknown, detail: `${r.detail} (${items.length - unknown.length} known)` };
    return { ...r, status: 'known' as const };
  });
  return { results: out, unseen: known.filter((k) => !used.has(k)) };
}

/** The results as a table with fixed columns; items under their row. */
export function formatTable(results: readonly CheckResult[], maxItems = 8): string {
  const head = ['Page', 'Check', 'Result', 'Detail'];
  const rows = results.map((r) => [r.page, r.check, r.status.toUpperCase(), r.detail]);
  const width = (i: number) => Math.max(head[i].length, ...rows.map((r) => r[i].length));
  const line = (cells: string[]) => cells.map((c, i) => (i < 3 ? c.padEnd(width(i)) : c)).join('  ').trimEnd();
  const out = [line(head), line(head.map((_, i) => '-'.repeat(i < 3 ? width(i) : 6)))];
  results.forEach((r, i) => {
    out.push(line(rows[i]));
    if (r.status === 'pass' || r.status === 'skip' || !r.items?.length) return;
    const indent = ' '.repeat(width(0) + 2);
    for (const item of r.items.slice(0, maxItems)) out.push(`${indent}- ${item}`);
    if (r.items.length > maxItems) out.push(`${indent}- … and ${r.items.length - maxItems} more`);
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The browser, over the DevTools pipe (src/pdfBrowser.ts)
// ---------------------------------------------------------------------------

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** Reads the events the harness wants from the same pipe as the Connection: console errors, exceptions, requests. */
class EventTap {
  readonly errors: string[] = [];
  readonly requests: string[] = [];
  private buffer = Buffer.alloc(0);

  constructor(input: Readable) {
    input.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end: number;
      while ((end = this.buffer.indexOf(0)) >= 0) {
        const text = this.buffer.subarray(0, end).toString('utf8');
        this.buffer = this.buffer.subarray(end + 1);
        if (text) this.event(JSON.parse(text) as { method?: string; params?: Record<string, unknown> });
      }
    });
  }

  clear(): void {
    this.errors.length = 0;
    this.requests.length = 0;
  }

  private event(m: { method?: string; params?: Record<string, unknown> }): void {
    const p = m.params ?? {};
    if (m.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails as { text?: string; exception?: { description?: string } };
      this.errors.push(`exception: ${d.exception?.description?.split('\n')[0] ?? d.text}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      const args = (p.args as Array<{ value?: unknown; description?: string }>).map((a) => String(a.value ?? a.description ?? ''));
      this.errors.push(`console.error: ${args.join(' ').slice(0, 200)}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = p.entry as { level: string; text: string; url?: string };
      if (e.level === 'error') this.errors.push(`${e.text}${e.url ? ` (${e.url})` : ''}`.slice(0, 240));
    } else if (m.method === 'Network.requestWillBeSent') {
      const url = String((p.request as { url: string }).url);
      if (!/^(file|data|blob|about):/.test(url)) this.requests.push(url);
    }
  }
}

interface Launched {
  browser: InstalledBrowser;
  version: string;
  connection: Connection;
  tap: EventTap;
  close(): Promise<void>;
}

const START_TIMEOUT = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000} s ${what}.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start the first installed browser that runs headless, with a throwaway profile under `tmp`. */
async function launch(browsers: readonly InstalledBrowser[], tmp: string): Promise<Launched> {
  const failures: string[] = [];
  for (const browser of browsers) {
    const profile = fs.mkdtempSync(path.join(tmp, 'profile-'));
    const child: ChildProcess = spawn(browser.path, browserArgs(profile), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    const connection = new Connection(child.stdio[3] as Writable, child.stdio[4] as Readable);
    const tap = new EventTap(child.stdio[4] as Readable);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        connection.dispose(new Error(`the browser exited (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        resolve();
      });
      child.once('error', (err) => {
        connection.dispose(err);
        resolve();
      });
    });
    const close = async () => {
      await withTimeout(connection.send('Browser.close'), 5000, 'Browser.close').catch(() => undefined);
      await withTimeout(exited, 5000, 'exit').catch(() => child.kill());
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    };
    try {
      const version = await withTimeout(connection.send('Browser.getVersion'), START_TIMEOUT, 'starting the browser') as { product: string };
      return { browser, version: version.product, connection, tap, close };
    } catch (err) {
      failures.push(`${browser.name}: ${err instanceof Error ? err.message : String(err)}`);
      await close();
    }
  }
  throw new Error(`No installed browser would start headless:\n  ${failures.join('\n  ')}`);
}

/** One tab: commands, script evaluation, keys. */
class Page {
  constructor(readonly send: Send, private readonly connection: Connection, private readonly sessionId: string) {}

  static async open(b: Launched): Promise<Page> {
    const { targetId } = await b.connection.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
    const { sessionId } = await b.connection.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const page = new Page((method, params = {}) => b.connection.send(method, params, sessionId), b.connection, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Network.enable');
    // Nothing leaves the machine: the pages are local, and anything remote they ask for fails.
    await page.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*', 'ftp://*'] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    // Headless pages have no focused window unless told to; :focus-visible and focus events need one.
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.send('Accessibility.enable');
    return page;
  }

  async goto(url: string): Promise<void> {
    const loaded = this.connection.waitForEvent('Page.loadEventFired', this.sessionId);
    const result = await this.send('Page.navigate', { url }) as { errorText?: string };
    if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`);
    await withTimeout(loaded, 30_000, `loading ${url}`);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed');
    return result.result?.value as T;
  }

  /** The accessibility node of the element an expression returns. */
  async axOf(expression: string): Promise<AXNode | undefined> {
    const { result } = await this.send('Runtime.evaluate', { expression, returnByValue: false }) as { result: { objectId?: string } };
    if (!result.objectId) return undefined;
    const { nodes } = await this.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false }) as { nodes: AXNode[] };
    await this.send('Runtime.releaseObject', { objectId: result.objectId });
    return nodes.find((n) => !n.ignored) ?? nodes[0];
  }

  async waitFor(expression: string, timeout = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(expression).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  }

  /** Press and release a key; `modifiers` as DevTools counts them (2 Ctrl, 8 Shift). */
  async press(name: keyof typeof KEYS, modifiers = 0): Promise<void> {
    const k = KEYS[name];
    const common = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    const text = 'text' in k && !(modifiers & 2) ? k.text : undefined;
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...common, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  async close(b: Launched): Promise<void> {
    const { targetInfos } = await b.connection.send('Target.getTargets') as { targetInfos: Array<{ targetId: string; type: string }> };
    for (const t of targetInfos.filter((i) => i.type === 'page')) await b.connection.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
  }
}

const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Slash: { key: '/', code: 'Slash', keyCode: 191, text: '/' },
} as const;

const CTRL = 2;

// ---------------------------------------------------------------------------
// In the page: helpers the checks call (plain JavaScript, evaluated once per page)
// ---------------------------------------------------------------------------

const PAGE_HELPERS = String.raw`(() => {
  if (window.__a11y) return true;
  const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, audio[controls], video[controls], [tabindex], [contenteditable]:not([contenteditable="false"])';
  const REF_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto', 'for', 'headers', 'list'];
  function* walk(root) {
    for (const el of Array.from(root.children)) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
      yield* walk(el);
    }
  }
  const all = () => Array.from(walk(document));
  const parentOf = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  function rendered(el) {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false;
    return el.getClientRects().length > 0;
  }
  function inClosedDetails(el) {
    const d = el.closest('details:not([open])');
    if (!d) return false;
    const summary = d.querySelector(':scope > summary');
    return !(summary && summary.contains(el));
  }
  function tabbable(el) {
    if (!el.matches(FOCUSABLE) || el.tabIndex < 0 || el.disabled) return false;
    if (el.tagName === 'SUMMARY' && !(el.parentElement && el.parentElement.tagName === 'DETAILS' && el.parentElement.querySelector(':scope > summary') === el)) return false;
    if (el.closest('[inert]') || inClosedDetails(el)) return false;
    return rendered(el);
  }
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  function desc(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    const role = el.getAttribute('role');
    if (role) s += '[role=' + role + ']';
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
    if (label) s += ' "' + label.slice(0, 40) + (label.length > 40 ? '…' : '') + '"';
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) s = desc(root.host).split(' "')[0] + ' >> ' + s;
    return s;
  }
  function byId(el, id) {
    const root = el.getRootNode();
    return root.getElementById ? root.getElementById(id) : document.getElementById(id);
  }
  let expected = [];
  let tablists = [];
  let summaries = [];
  let boxes = [];
  window.__a11y = {
    tabbableNow() {
      expected = all().filter(tabbable);
      return expected.map(desc);
    },
    stillTabbable() { return expected.map((el) => el.isConnected && tabbable(el)); },
    resetFocus() {
      const a = deepActive();
      if (a && a.blur) a.blur();
      window.scrollTo(0, 0);
      return true;
    },
    step() {
      const el = deepActive();
      if (!el || el === document.body || el === document.documentElement) return { body: true };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      let opacity = 1;
      for (let p = el; p; p = parentOf(p)) opacity = Math.min(opacity, Number(getComputedStyle(p).opacity));
      return {
        body: false, desc: desc(el), order: all().indexOf(el), expected: expected.indexOf(el),
        outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow,
        focusVisible: el.matches(':focus-visible'), opacity,
        inView: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
      };
    },
    idScopes() {
      const roots = [document, ...all().filter((e) => e.shadowRoot).map((e) => e.shadowRoot)];
      return roots.map((root) => {
        const els = Array.from(root.querySelectorAll('*'));
        // References from hidden elements (a closed popover waiting for its content) reach no one.
        return {
          scope: root === document ? 'document' : 'shadow root of ' + desc(root.host).split(' "')[0],
          ids: els.filter((e) => e.id).map((e) => e.id),
          refs: els.filter(rendered).flatMap((e) => REF_ATTRS.filter((a) => e.hasAttribute(a)).map((a) => ({ attr: a, ids: e.getAttribute(a).trim().split(/\s+/).filter(Boolean), where: desc(e) }))),
        };
      });
    },
    tablists() {
      tablists = all().filter((e) => e.getAttribute('role') === 'tablist' && rendered(e));
      return tablists.map((t) => Array.from(t.querySelectorAll('[role="tab"]')).map((b) => b.textContent.trim()));
    },
    tab(i, j) { return tablists[i].querySelectorAll('[role="tab"]')[j]; },
    tabsState(i) {
      const tabs = Array.from(tablists[i].querySelectorAll('[role="tab"]'));
      return {
        focused: tabs.indexOf(deepActive()),
        selected: tabs.map((t) => t.getAttribute('aria-selected')),
        tabindex: tabs.map((t) => t.getAttribute('tabindex')),
        panels: tabs.map((t) => { const p = byId(t, t.getAttribute('aria-controls') || ''); return p ? rendered(p) : null; }),
      };
    },
    summaries() {
      summaries = all().filter((e) => e.tagName === 'SUMMARY' && tabbable(e));
      return summaries.map(desc);
    },
    summary(i) { return summaries[i]; },
    open(i) { return summaries[i].parentElement.open; },
    boxes() {
      boxes = all().filter((e) => e.matches('input[type="checkbox"].smd-task-box') && tabbable(e));
      return boxes.map((b) => ({ desc: desc(b), line: Number(b.getAttribute('data-task-line')) }));
    },
    box(i) { return boxes[i]; },
    checked(i) { return boxes[i].checked; },
    deepActive,
    desc,
    motion() {
      const out = [];
      for (const el of [document.documentElement, ...all()]) {
        for (const pseudo of [null, '::before', '::after']) {
          const cs = getComputedStyle(el, pseudo);
          if (pseudo && (cs.content === 'none' || cs.content === 'normal')) continue;
          const moving = (cs.transitionProperty !== 'none' && /[1-9]/.test(cs.transitionDuration)) || (cs.animationName !== 'none' && /[1-9]/.test(cs.animationDuration));
          if (!moving) continue;
          out.push({ desc: desc(el) + (pseudo || ''), transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration, animationName: cs.animationName, animationDuration: cs.animationDuration });
        }
      }
      return out;
    },
  };
  return true;
})()`;

// ---------------------------------------------------------------------------
// The Block Editor's host: a BlockEditorSession on the sample, wired to the page through the stub
// ---------------------------------------------------------------------------

const SNIPPETS = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'snippets', 'smd.json'), 'utf8')) as Record<string, Snippet>;

/** What VS Code would do for the page: answer its messages with a session on the document (src/blockEditor.ts). */
class EditorHost {
  readonly actions: unknown[] = [];
  private readonly session: BlockEditorSession;
  private readonly outgoing: HostMessage[] = [];
  private running = true;
  private loop: Promise<void> | undefined;
  constructor(private readonly page: Page, text: string, file: string) {
    const options = previewRenderOptions(file);
    // The document never changes: the checks send no edits, and the stand-in refuses any.
    const port = { getText: () => text, version: 1, eol: (text.includes('\r\n') ? '\r\n' : '\n') as '\n' | '\r\n', applyEdits: () => false };
    this.session = new BlockEditorSession(port, {
      render: (t) => renderBlocks(t, { ...options, inlineIndex: true }),
      scan: (lines, spec) => scanInline(lines, { allowHtml: options.allowHtml, spec }),
      table: (lines) => readTable(lines, { allowHtml: options.allowHtml }),
      segment: (t) => segmentSmd(t, options),
      templates: blockTemplates(SNIPPETS),
      post: (message) => this.outgoing.push(message),
      diagnostics: () => [],
      themePref,
      title: path.basename(file, path.extname(file)),
    });
  }

  start(): void {
    this.loop = (async () => {
      while (this.running) {
        await this.pump().catch(() => undefined);
        await sleep(50);
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** Messages from the page to the session (or kept, for what VS Code itself does), and the session's answers back. */
  private async pump(): Promise<void> {
    const inbox = await this.page.evaluate<unknown[]>('window.__smdOutbox ? window.__smdOutbox.splice(0) : []');
    for (const raw of inbox ?? []) {
      const message = readEditorMessage(raw);
      if (!message) continue;
      if (message.type === 'toggleTask' || message.type === 'openLink' || message.type === 'revealLine') this.actions.push(message);
      else await this.session.handle(message);
    }
    while (this.outgoing.length) {
      const message = this.outgoing.shift();
      await this.page.evaluate(`window.postMessage(${JSON.stringify(message)}, '*'), true`);
    }
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface PageSpec {
  /** "preview: showcase.smd" */
  name: string;
  kind: 'preview' | 'block-editor' | 'standalone' | 'site';
  url: string;
  /** The sample's text and path (the Block Editor's host needs them). */
  text: string;
  file: string;
  expectedRoles: ExpectedRole[];
  /** A <title> is expected (exported pages; webviews get theirs from the editor tab). */
  title: boolean;
}

function result(page: string, check: string, problems: string[], passDetail: string, failDetail = `${problems.length} problem(s)`, status: Status = 'fail'): CheckResult {
  return problems.length ? { page, check, status, detail: failDetail, items: problems } : { page, check, status: 'pass', detail: passDetail };
}

function describe(n: AXNode): string {
  return `${roleOf(n)} (DOM node ${n.backendDOMNodeId ?? '?'})`;
}

/** A readable description of an accessibility node's element. */
async function describeNode(page: Page, n: AXNode): Promise<string> {
  if (n.backendDOMNodeId === undefined) return describe(n);
  try {
    const { object } = await page.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId }) as { object: { objectId: string } };
    const { result: r } = await page.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { const el = this.nodeType === 1 ? this : this.parentElement; return el ? el.outerHTML.replace(/\\s+/g, " ").slice(0, 140) : String(this.nodeName); }',
      returnByValue: true,
    }) as { result: { value: string } };
    await page.send('Runtime.releaseObject', { objectId: object.objectId });
    return `${roleOf(n)}: ${r.value}`;
  } catch {
    return describe(n);
  }
}

async function checkTree(page: Page, spec: PageSpec): Promise<CheckResult[]> {
  await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodes } = await page.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };
  const controls = nodes.filter((n) => !n.ignored && INTERACTIVE_ROLES.has(roleOf(n)));
  const unnamed = await Promise.all(unnamedControls(nodes).map((n) => describeNode(page, n)));
  const images = await Promise.all(unnamedImages(nodes).map((n) => describeNode(page, n)));
  const focusables = await Promise.all(unnamedFocusables(nodes).map((n) => describeNode(page, n)));
  const scopes = await page.evaluate<IdScope[]>('window.__a11y.idScopes()');
  const refs = scopes.reduce((sum, s) => sum + s.refs.length, 0);
  const roleProblems = missingRoles(nodes, spec.expectedRoles);
  const lang = await page.evaluate<string>('document.documentElement.lang');
  if (!lang) roleProblems.push('<html> has no lang (WCAG 3.1.1)');
  if (spec.title && !(await page.evaluate<string>('document.title')).trim()) roleProblems.push('no <title> (WCAG 2.4.2)');
  const found = landmarks(nodes).map((l) => (l.name ? `${l.role} "${l.name}"` : l.role));
  return [
    result(spec.name, 'names', unnamed, `${controls.length} controls, all named`, `${unnamed.length} of ${controls.length} controls have no name (WCAG 4.1.2)`),
    result(spec.name, 'image text', images, 'every image has a text alternative', `${images.length} image(s) with no text alternative (WCAG 1.1.1)`),
    result(spec.name, 'focusable names', focusables, 'every other focusable element is named', `${focusables.length} focusable element(s) announced with no name`, 'warn'),
    result(spec.name, 'id references', idRefProblems(scopes), `${refs} references, ${scopes.length} tree scope(s), all resolve to one element`),
    result(spec.name, 'landmarks', roleProblems, `lang="${lang}"; ${found.join(', ') || 'none'}`),
  ];
}

async function checkTabOrder(page: Page, spec: PageSpec): Promise<CheckResult[]> {
  const expected = await page.evaluate<string[]>('window.__a11y.tabbableNow()');
  await page.evaluate('window.__a11y.resetFocus()');
  // Tab from wherever focus starts (a page may focus something as it loads), past the end of the page, and on
  // round to the first stop again, so every stop is passed once whatever the starting point.
  const steps: TabStep[] = [];
  const limit = 2 * expected.length + 15;
  const key = stepKey;
  let first: string | undefined;
  let pastEnd = false;
  for (let i = 0; i < limit; i++) {
    await page.press('Tab');
    let step = await page.evaluate<TabStep>('window.__a11y.step()');
    // Controls that fade in on focus (the copy button) get their transition's time; headless frames can be slow.
    for (let wait = 0; !step.body && (step.opacity ?? 1) < 0.5 && wait < 10; wait++) {
      await sleep(100);
      step = await page.evaluate<TabStep>('window.__a11y.step()');
    }
    steps.push(step);
    if (step.body) {
      pastEnd = true;
      continue;
    }
    if (first === undefined) first = key(step);
    else if (pastEnd && key(step) === first) break;
  }
  const still = await page.evaluate<boolean[]>('window.__a11y.stillTabbable()');
  const walk = analyseTabWalk(expected, steps, still);
  const order = [...walk.unreached.map((u) => `not reached: ${u}`), ...walk.backwards.map((b) => `went back: ${b}`), ...(walk.trap ? [`trap: ${walk.trap}`] : [])];
  return [
    result(spec.name, 'tab order', order, `${walk.reached} stops in ${steps.length} Tabs, document order, no trap`, `${order.length} problem(s) (WCAG 2.1.1, 2.1.2, 2.4.3)`),
    result(spec.name, 'focus visible', walk.invisible, `a focus ring on all ${walk.reached} stops`, `${walk.invisible.length} stop(s) without visible focus (WCAG 2.4.7)`),
  ];
}

async function checkTabs(page: Page, spec: PageSpec): Promise<CheckResult> {
  const lists = await page.evaluate<string[][]>('window.__a11y.tablists()');
  if (!lists.length) return { page: spec.name, check: 'tabs keys', status: 'skip', detail: 'no tab list on the page' };
  const problems: string[] = [];
  for (let i = 0; i < lists.length; i++) {
    const n = lists[i].length;
    const label = `tab list ${i + 1} (${lists[i].join(' | ')})`;
    const start = (await page.evaluate<TabsState>(`window.__a11y.tabsState(${i})`)).selected.indexOf('true');
    await page.evaluate(`window.__a11y.tab(${i}, ${Math.max(0, start)}).focus(), true`);
    let at = Math.max(0, start);
    const moves: Array<[keyof typeof KEYS, (a: number) => number]> = [
      ['ArrowRight', (a) => (a + 1) % n], ['ArrowRight', (a) => (a + 1) % n], ['ArrowLeft', (a) => (a - 1 + n) % n],
      ['End', () => n - 1], ['Home', () => 0], ['ArrowLeft', () => n - 1],
    ];
    for (const [key, next] of moves) {
      await page.press(key);
      at = next(at);
      const state = await page.evaluate<TabsState>(`window.__a11y.tabsState(${i})`);
      problems.push(...tabsProblems(at, state).map((p) => `${label}, after ${key}: ${p}`));
    }
    const ax = await page.axOf(`window.__a11y.tab(${i}, ${at})`);
    if (ax && property(ax, 'selected') !== true) problems.push(`${label}: the accessibility tree does not report tab ${at + 1} as selected`);
    // Put it back as it was.
    await page.evaluate(`window.__a11y.tab(${i}, ${Math.max(0, start)}).click(), true`);
  }
  return result(spec.name, 'tabs keys', problems, `${lists.length} tab list(s): arrows, Home, End move focus, aria-selected and the shown panel`, `${problems.length} problem(s) (WAI-ARIA tabs, WCAG 2.1.1, 4.1.2)`);
}

async function checkDisclosures(page: Page, spec: PageSpec): Promise<CheckResult> {
  const summaries = await page.evaluate<string[]>('window.__a11y.summaries()');
  if (!summaries.length) return { page: spec.name, check: 'disclosure keys', status: 'skip', detail: 'no <details> on the page' };
  const problems: string[] = [];
  for (let i = 0; i < summaries.length; i++) {
    await page.evaluate(`window.__a11y.summary(${i}).focus(), true`);
    const before = await page.evaluate<boolean>(`window.__a11y.open(${i})`);
    for (const key of ['Enter', 'Space'] as const) {
      const was = await page.evaluate<boolean>(`window.__a11y.open(${i})`);
      await page.press(key);
      await sleep(30);
      const now = await page.evaluate<boolean>(`window.__a11y.open(${i})`);
      if (now === was) problems.push(`${summaries[i]}: ${key} did not ${was ? 'close' : 'open'} it`);
      const ax = await page.axOf(`window.__a11y.summary(${i})`);
      if (ax && property(ax, 'expanded') !== now) problems.push(`${summaries[i]}: after ${key} the tree says expanded=${String(property(ax, 'expanded'))}, open=${now}`);
    }
    if ((await page.evaluate<boolean>(`window.__a11y.open(${i})`)) !== before) await page.evaluate(`window.__a11y.summary(${i}).click(), true`);
  }
  return result(spec.name, 'disclosure keys', problems, `${summaries.length} <details>: Enter and Space open and close, expanded state follows`, `${problems.length} problem(s) (WCAG 2.1.1, 4.1.2)`);
}

async function checkTasks(page: Page, spec: PageSpec, sent: () => Promise<unknown[]>): Promise<CheckResult> {
  const boxes = await page.evaluate<Array<{ desc: string; line: number }>>('window.__a11y.boxes()');
  if (!boxes.length) return { page: spec.name, check: 'task boxes', status: 'skip', detail: 'no task check boxes on the page' };
  const problems: string[] = [];
  const tried = boxes.slice(0, 4);
  for (let i = 0; i < tried.length; i++) {
    const box = tried[i];
    await page.evaluate(`window.__a11y.box(${i}).focus(), true`);
    const before = await page.evaluate<boolean>(`window.__a11y.checked(${i})`);
    const axBefore = await page.axOf(`window.__a11y.box(${i})`);
    if (axBefore && property(axBefore, 'checked') !== String(before)) problems.push(`${box.desc}: the tree says checked=${String(property(axBefore, 'checked'))}, the box is ${before}`);
    const count = (await sent()).length;
    await page.press('Space');
    await sleep(120);
    const after = await page.evaluate<boolean>(`window.__a11y.checked(${i})`);
    if (after === before) problems.push(`${box.desc}: Space did not toggle it`);
    const axAfter = await page.axOf(`window.__a11y.box(${i})`);
    if (axAfter && property(axAfter, 'checked') !== String(after)) problems.push(`${box.desc}: after Space the tree says checked=${String(property(axAfter, 'checked'))}`);
    const messages = (await sent()).slice(count) as Array<{ type?: string; line?: number }>;
    if (!messages.some((m) => m.type === 'toggleTask' && m.line === box.line)) problems.push(`${box.desc}: Space sent no toggleTask for line ${box.line}, so the document would not change`);
    if (after !== before) {
      await page.press('Space');
      await sleep(60);
    }
  }
  return result(spec.name, 'task boxes', problems, `${tried.length} of ${boxes.length} boxes: Space toggles, checked state exposed, the edit is asked for`, `${problems.length} problem(s) (WCAG 2.1.1, 4.1.2)`);
}

/** Where focus is, for the Block Editor's flows. */
interface Focus { desc: string; tag: string; item: boolean; role: string | null; tabindex: string | null }

const FOCUS = `(() => { const el = window.__a11y.deepActive(); const s = window.__a11y.step();
  return { desc: s.desc || 'body', tag: el ? el.tagName : '', item: !!(el && el.classList && el.classList.contains('smd-ed-item')),
    role: el && el.getAttribute ? el.getAttribute('role') : null, tabindex: el && el.getAttribute ? el.getAttribute('tabindex') : null }; })()`;

/**
 * The Block Editor's own keyboard model: the arrow keys move between blocks (one tab stop), Enter opens a block's
 * source in a labelled text area and Escape brings focus back, Ctrl+/ opens the insert menu of menu items, and the
 * toolbar is one tab stop whose buttons the arrow keys move between.
 */
async function checkBlockEditorKeys(page: Page, spec: PageSpec): Promise<CheckResult> {
  const problems: string[] = [];
  const focus = () => page.evaluate<Focus>(FOCUS);
  await page.evaluate('document.querySelector(".smd-ed-item[tabindex=\\"0\\"]").focus(), true');
  const start = await focus();
  if (!start.item) problems.push(`the current block did not take focus (${start.desc})`);
  await page.press('ArrowDown');
  const next = await focus();
  if (!next.item || next.desc === start.desc) problems.push(`ArrowDown did not move to the next block (${next.desc})`);
  else if (next.tabindex !== '0') problems.push(`the block ArrowDown moved to has tabindex=${next.tabindex}, so Tab would not come back to it`);
  const stops = await page.evaluate<number>('document.querySelectorAll(".smd-ed-item[tabindex=\\"0\\"]").length');
  if (stops !== 1) problems.push(`${stops} blocks are in the tab order, expected 1`);
  await page.press('Home');
  const home = await focus();
  const firstBlock = await page.evaluate<string>('window.__a11y.desc(Array.from(document.querySelectorAll(".smd-ed-item")).find((el) => el.getClientRects().length))');
  if (home.desc !== firstBlock) problems.push(`Home went to ${home.desc}, not the first block`);

  // Enter: the source editor, labelled; Escape: back to the block.
  await page.evaluate('document.querySelector(".smd-ed-item[tabindex=\\"0\\"]").focus(), true');
  await page.press('Enter');
  await page.waitFor('window.__a11y.deepActive() && window.__a11y.deepActive().tagName === "TEXTAREA"', 3000);
  const editor = await focus();
  if (editor.tag !== 'TEXTAREA') problems.push(`Enter on a block did not put focus in its source editor (${editor.desc})`);
  else {
    const ax = await page.axOf('window.__a11y.deepActive()');
    if (!ax || !nameOf(ax)) problems.push('the source editor has no accessible name');
    await page.press('Escape');
    await page.waitFor('window.__a11y.deepActive() && window.__a11y.deepActive().classList.contains("smd-ed-item")', 3000);
    const back = await focus();
    if (!back.item) problems.push(`Escape in the source editor left focus on ${back.desc}, not the block`);
  }

  // Ctrl+/: the insert menu.
  await page.evaluate('document.querySelector(".smd-ed-item[tabindex=\\"0\\"]").focus(), true');
  const before = await focus();
  await page.press('Slash', CTRL);
  await page.waitFor('window.__a11y.deepActive() && window.__a11y.deepActive().getAttribute("role") === "menuitem"', 3000);
  const menu = await focus();
  if (menu.role !== 'menuitem') problems.push(`Ctrl+/ did not put focus in the insert menu (${menu.desc})`);
  else {
    await page.press('ArrowDown');
    const second = await focus();
    if (second.role !== 'menuitem' || second.desc === menu.desc) problems.push(`ArrowDown in the menu did not move to the next item (${second.desc})`);
    await page.press('Escape');
    await sleep(50);
    const back = await focus();
    if (back.desc !== before.desc) problems.push(`Escape in the menu left focus on ${back.desc}, not ${before.desc}`);
  }

  // The toolbar: one tab stop, the arrow keys move along it.
  const barStops = await page.evaluate<number>('Array.from(document.getElementById("smd-ed-toolbar").shadowRoot.querySelectorAll("[role=toolbar] button")).filter((b) => b.tabIndex >= 0 && !b.hidden).length');
  if (barStops !== 1) problems.push(`${barStops} toolbar buttons are in the tab order, expected 1`);
  await page.evaluate('Array.from(document.getElementById("smd-ed-toolbar").shadowRoot.querySelectorAll("[role=toolbar] button")).find((b) => b.tabIndex >= 0).focus(), true');
  const firstButton = await focus();
  await page.press('ArrowRight');
  const nextButton = await focus();
  if (nextButton.tag !== 'BUTTON' || nextButton.desc === firstButton.desc) problems.push(`ArrowRight in the toolbar did not move to the next button (${nextButton.desc})`);
  else if (nextButton.tabindex !== '0') problems.push('the toolbar button ArrowRight moved to is not the tab stop now');
  await page.press('Home');
  return result(spec.name, 'editor keys', problems, 'arrows move between blocks (one tab stop); Enter opens a labelled source editor, Escape returns; Ctrl+/ menu; toolbar arrows', `${problems.length} problem(s) (WCAG 2.1.1, 2.4.3, 4.1.2)`);
}

async function checkMotion(page: Page, spec: PageSpec): Promise<CheckResult> {
  const readUrl = (url: string) => {
    try {
      return url.startsWith('file:') ? fs.readFileSync(fileURLToPath(url), 'utf8') : undefined;
    } catch {
      return undefined;
    }
  };
  const claims = claimsReducedMotion(pageCss(readUrl(spec.url) ?? '', spec.url, readUrl));
  const moving = (await page.evaluate<MotionStyle[]>('window.__a11y.motion()')).filter((m) => longestMotion(m) > MOTION_LIMIT);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(50);
  const still = (await page.evaluate<MotionStyle[]>('window.__a11y.motion()')).filter((m) => longestMotion(m) > MOTION_LIMIT);
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  const items = still.map((m) => `${m.desc}: ${m.transitionProperty} ${m.transitionDuration}${m.animationName !== 'none' ? `, animation ${m.animationName} ${m.animationDuration}` : ''}`);
  const rule = claims ? 'the CSS has a prefers-reduced-motion rule' : 'no prefers-reduced-motion rule';
  return result(spec.name, 'reduced motion', items, `${moving.length} moving element(s) normally, none with reduced motion (${rule})`, `${still.length} element(s) still move with reduced motion (WCAG 2.3.3; ${rule})`);
}

async function checkPage(b: Launched, spec: PageSpec): Promise<CheckResult[]> {
  b.tap.clear();
  const page = await Page.open(b);
  let host: EditorHost | undefined;
  try {
    await page.goto(spec.url);
    if (spec.kind === 'block-editor') {
      host = new EditorHost(page, spec.text, spec.file);
      host.start();
      await page.waitFor('document.querySelectorAll(".smd-ed-item").length > 0');
    }
    const ready = await page.waitFor('document.documentElement.dataset.smdReady === "true"');
    await page.waitFor('!document.querySelector(".smd-diagram-pending")', 10_000);
    await sleep(300);
    await page.evaluate(PAGE_HELPERS);
    const loads: CheckResult = {
      page: spec.name, check: 'loads', status: 'pass',
      detail: `${await page.evaluate<number>('document.querySelectorAll(".smd-diagram svg").length')} diagram(s), ${await page.evaluate<number>('document.querySelectorAll(".katex").length')} math, ${await page.evaluate<number>('document.querySelectorAll(".smd-tabs.smd-js").length')} tab group(s)${spec.kind === 'block-editor' ? `, ${await page.evaluate<number>('document.querySelectorAll(".smd-ed-item").length')} blocks` : ''}`,
    };
    const results: CheckResult[] = [loads];
    results.push(...await checkTabOrder(page, spec));
    results.push(...await checkTree(page, spec));
    results.push(await checkTabs(page, spec));
    results.push(await checkDisclosures(page, spec));
    const sent = () => page.evaluate<unknown[]>('window.__smdSent || []');
    results.push(spec.kind === 'preview' || spec.kind === 'block-editor'
      ? await checkTasks(page, spec, sent)
      : { page: spec.name, check: 'task boxes', status: 'skip', detail: 'not checked: a toggle in an exported page changes no document' });
    if (spec.kind === 'block-editor') results.push(await checkBlockEditorKeys(page, spec));
    results.push(await checkMotion(page, spec));
    const problems = [...(ready ? [] : ['the page never set data-smd-ready']), ...b.tap.errors, ...b.tap.requests.map((u) => `asked for a remote URL (blocked): ${u}`)];
    if (problems.length) Object.assign(loads, { status: 'fail', detail: `${problems.length} problem(s) while loading`, items: [...new Set(problems)] });
    return results;
  } finally {
    await host?.stop();
    await page.close(b);
  }
}

// ---------------------------------------------------------------------------
// Building the pages and running everything
// ---------------------------------------------------------------------------

const PREVIEW_ROLES: ExpectedRole[] = [{ role: 'main', exactly: 1 }];
const BLOCK_EDITOR_ROLES: ExpectedRole[] = [{ role: 'main', exactly: 1 }, { role: 'toolbar', name: 'Block editor', exactly: 1 }];
const SITE_ROLES: ExpectedRole[] = [
  { role: 'banner', exactly: 1 }, { role: 'main', exactly: 1 }, { role: 'search' },
  { role: 'navigation', name: 'Documents' }, { role: 'navigation', name: 'Breadcrumb' },
];

/** The Block Editor's page script, bundled from src/webview/blockEditor.ts as scripts/build.mjs does (no dist/ needed). */
async function bundleBlockEditor(outfile: string): Promise<void> {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(EXTENSION, 'src', 'webview', 'blockEditor.ts')],
    outfile, bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], legalComments: 'none', logLevel: 'warning',
  });
}

export async function buildPages(dir: string): Promise<PageSpec[]> {
  const stub = path.join(dir, 'vscode-stub.js');
  fs.writeFileSync(stub, VSCODE_STUB);
  const script = path.join(dir, 'block-editor.js');
  await bundleBlockEditor(script);
  const urls = localUrls(stub, script);
  const sources = SAMPLE_FILES.map((name) => ({ name, file: path.join(SAMPLES, name), text: fs.readFileSync(path.join(SAMPLES, name), 'utf8') }));
  const specs: PageSpec[] = [];
  const write = (name: string, html: string) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    return fileUrl(file);
  };
  for (const s of sources) {
    const base = s.name.replace(/\.smd$/, '');
    specs.push({ name: `preview: ${s.name}`, kind: 'preview', url: write(`preview-${base}.html`, previewPage(s.text, s.file, urls)), text: s.text, file: s.file, expectedRoles: PREVIEW_ROLES, title: false });
    specs.push({ name: `block editor: ${s.name}`, kind: 'block-editor', url: write(`block-editor-${base}.html`, blockEditorPage(s.file, urls)), text: s.text, file: s.file, expectedRoles: BLOCK_EDITOR_ROLES, title: false });
  }
  const first = sources[0];
  specs.push({ name: `export html: ${first.name}`, kind: 'standalone', url: write('export.html', standalonePage(first.text, first.file, urls)), text: first.text, file: first.file, expectedRoles: PREVIEW_ROLES, title: true });
  const site = siteFiles(sources.map((s) => ({ path: s.name, text: s.text })), urls);
  for (const f of site) write(path.join('site', f.path), f.content);
  const page = site.find((f) => f.path === sources[1].name.replace(/\.smd$/, '.html'))!;
  specs.push({ name: `site page: ${page.path}`, kind: 'site', url: fileUrl(path.join(dir, 'site', page.path)), text: sources[1].text, file: sources[1].file, expectedRoles: SITE_ROLES, title: true });
  return specs;
}

export interface RunReport {
  browser: string | null;
  version: string | null;
  date: string;
  skipped?: string;
  results: CheckResult[];
  knownFailures: Array<{ page: string; check: string; note: string }>;
  knownNotSeen: string[];
}

async function run(args: A11yArgs): Promise<number> {
  const date = new Date().toISOString();
  const browsers = findInstalledBrowsers();
  if (!browsers.length) {
    const report: RunReport = { browser: null, version: null, date, skipped: 'no browser', results: [], knownFailures: [], knownNotSeen: [] };
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`skipped: no browser (install Chrome, Edge, Chromium or Brave to run the real-browser accessibility checks)${args.requireBrowser ? '; --require-browser makes this a failure' : ''}`);
    return args.requireBrowser ? 1 : 0;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-a11y-'));
  let b: Launched | undefined;
  try {
    const specs = await buildPages(tmp);
    b = await launch(browsers, tmp);
    const raw: CheckResult[] = [];
    for (const spec of specs) {
      try {
        raw.push(...await checkPage(b, spec));
      } catch (err) {
        raw.push({ page: spec.name, check: 'loads', status: 'fail', detail: err instanceof Error ? err.message.split('\n')[0] : String(err) });
      }
    }
    const { results, unseen } = applyKnown(raw, KNOWN_FAILURES);
    const report: RunReport = {
      browser: b.browser.name, version: b.version, date, results,
      knownFailures: KNOWN_FAILURES.map((k) => ({ page: k.page.source, check: k.check, note: k.note })),
      knownNotSeen: unseen.map((k) => k.note),
    };
    const failed = results.filter((r) => r.status === 'fail').length;
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Accessibility in a real browser: ${b.browser.name} (${b.version}), ${date.slice(0, 10)}\n`);
      console.log(formatTable(results));
      const known = results.filter((r) => r.status === 'known');
      if (known.length) {
        console.log('\nKnown failures (listed in KNOWN_FAILURES in test/browser/a11y.ts, not failing the run):');
        for (const k of KNOWN_FAILURES) console.log(`  - ${k.note}`);
      }
      for (const note of report.knownNotSeen) console.log(`\nA known failure did not show up; remove it from KNOWN_FAILURES if it is fixed: ${note}`);
      const count = (s: Status) => results.filter((r) => r.status === s).length;
      console.log(`\n${count('pass')} passed, ${failed} failed, ${count('known')} known, ${count('warn')} warnings, ${count('skip')} skipped.`);
      if (args.keep) console.log(`Pages kept in ${tmp}`);
    }
    return failed ? 1 : 0;
  } finally {
    await b?.close();
    if (!args.keep) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (require.main === module) {
  let args: A11yArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  run(args).then((code) => process.exit(code), (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
