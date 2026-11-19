/**
 * The playground page: wires the editor, tabs and buttons to the pure modules. Kept thin; the logic it calls is
 * tested in Node (extension/test/playground.test.ts).
 *
 * Document text never becomes markup in this page: the output panes are set through textContent, and the rendered
 * preview only exists inside the sandboxed frame (see frame.ts).
 */
import STARTER from '../starter.smd';
import { canShare, documentFromHash, fragmentPayload, shareFragment, shareLinkWarning } from './codec';
import { indent, lineNumbers, offsetOf, outdent, type Edit } from './editor';
import { previewTheme, resolvedTheme, type FrameAssets, type ThemeSetting } from './frame';
import { compareNote, diagnosticsSummary, renderPanes, type CompareMode, type MarkdownRenderer, type Panes } from './panes';
import { PreviewFrame } from './previewFrame';
import {
  COMPARE_KEY, DRAFT_KEY, RENDERER_KEY, THEME_KEY, compareMode, markdownRenderer, readStored, themeSetting, writeStored,
} from './storage';
import { changedRange } from '../../extension/src/core/sourceEdit';
import type { Diagnostic } from '../../extension/src/core/validate';

// Embedded by scripts/build-playground.mjs.
declare const __PLAYGROUND_FRAME__: Omit<FrameAssets, 'mermaid'>;
/** Set by vendor/mermaid-source.js: Mermaid's source text, inlined into the frame for documents with diagrams. */
declare global {
  var SMD_PLAYGROUND_MERMAID: string | undefined;
}

const RENDER_DELAY = 200;
const DRAFT_DELAY = 500;
const assets: FrameAssets = { ...__PLAYGROUND_FRAME__ };

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as T;
}

const source = byId<HTMLTextAreaElement>('source');
const gutter = byId<HTMLPreElement>('gutter');
const layout = byId<HTMLElement>('layout');
const agentOut = byId<HTMLPreElement>('agent');
const agentMeta = byId<HTMLParagraphElement>('agent-meta');
const agentCount = byId<HTMLSpanElement>('agent-tokens');
const diagnosticsList = byId<HTMLUListElement>('diagnostics');
const diagnosticsCount = byId<HTMLSpanElement>('diagnostics-count');
const markdownOut = byId<HTMLPreElement>('markdown');
const notice = byId<HTMLParagraphElement>('notice');
const themeSelect = byId<HTMLSelectElement>('theme');

const compareSelect = byId<HTMLSelectElement>('compare-mode');
const rendererSelect = byId<HTMLSelectElement>('compare-renderer');
const compareNoteOut = byId<HTMLParagraphElement>('compare-note');
let mode: CompareMode = compareMode(readStored(COMPARE_KEY));
let renderer: MarkdownRenderer = markdownRenderer(readStored(RENDERER_KEY));

/** Each sandboxed frame, the panel it sits in, and which pane it shows. */
const frames = [
  { frame: new PreviewFrame(byId<HTMLIFrameElement>('preview'), assets), panel: byId('panel-preview'), pane: (p: Panes) => p.preview },
  { frame: new PreviewFrame(byId<HTMLIFrameElement>('compare-smd'), assets), panel: byId('panel-compare'), pane: (p: Panes) => p.preview },
  { frame: new PreviewFrame(byId<HTMLIFrameElement>('compare-md'), assets), panel: byId('panel-compare'), pane: (p: Panes) => p.compare[renderer][mode] },
];

let theme: ThemeSetting = themeSetting(readStored(THEME_KEY));
let latest: Panes | undefined;
let loadedFromLink = false;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let draftTimer: ReturnType<typeof setTimeout> | undefined;

function showNotice(message: string, kind: 'info' | 'warning' = 'info'): void {
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = !message;
}

function applyTheme(setting: ThemeSetting): void {
  theme = setting;
  document.documentElement.dataset.theme = setting;
  themeSelect.value = setting;
  showPreviews();
}

let mermaidRequested = false;

/** Loads Mermaid's source (3.5 MB) the first time a document has a diagram, then rebuilds the frame with it. */
function requestMermaid(): void {
  if (mermaidRequested) return;
  mermaidRequested = true;
  const script = document.createElement('script');
  script.src = 'vendor/mermaid-source.js';
  script.addEventListener('load', () => {
    assets.mermaid = globalThis.SMD_PLAYGROUND_MERMAID;
    showPreviews();
  });
  document.head.append(script);
}

/**
 * Sends the latest panes to the frames that are on screen. Hidden frames catch up when their tab is selected, so
 * typing doesn't re-render previews nobody is looking at.
 */
const systemDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)');

function showPreviews(): void {
  if (!latest) return;
  // "System" is resolved here rather than in each frame: a frame reads prefers-color-scheme from its <iframe>
  // element, and Chromium can report light for a frame that loads right after its panel is unhidden.
  const pref = resolvedTheme(previewTheme(theme, latest.preview), Boolean(systemDark?.matches));
  if (latest.preview.mermaid && !assets.mermaid) requestMermaid();
  for (const { frame, panel, pane } of frames) {
    if (!panel.hidden) frame.show(pane(latest), pref);
  }
}

function diagnosticItem(text: string, d: Diagnostic): HTMLLIElement {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `diagnostic diagnostic-${d.severity}`;
  const where = document.createElement('span');
  where.className = 'where';
  where.textContent = `${d.line + 1}:${d.column + 1}`;
  const severity = document.createElement('span');
  severity.className = 'severity';
  severity.textContent = d.severity;
  const message = document.createElement('span');
  message.className = 'message';
  message.textContent = d.message;
  const code = document.createElement('code');
  code.textContent = d.code;
  button.append(where, severity, message, code);
  button.addEventListener('click', () => revealRange(text, d));
  item.append(button);
  return item;
}

function showDiagnostics(text: string, diagnostics: Diagnostic[]): void {
  const items = diagnostics.map((d) => diagnosticItem(text, d));
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No problems found.';
    items.push(empty);
  }
  diagnosticsList.replaceChildren(...items);
  diagnosticsCount.textContent = diagnostics.length ? String(diagnostics.length) : '';
  diagnosticsCount.title = diagnosticsSummary(diagnostics);
}

function render(): void {
  const text = source.value;
  const panes = renderPanes(text);
  latest = panes;
  showPreviews();
  agentOut.textContent = panes.agent.text;
  agentMeta.textContent = `≈ ${panes.agent.tokens.toLocaleString()} tokens for an agent, from ≈ ${panes.agent.originalTokens.toLocaleString()} in the source.`;
  agentCount.textContent = `≈${panes.agent.tokens.toLocaleString()}`;
  showDiagnostics(text, panes.diagnostics);
  markdownOut.textContent = panes.markdown;
}

function scheduleRender(): void {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, RENDER_DELAY);
}

function updateGutter(): void {
  gutter.textContent = lineNumbers(source.value);
  gutter.scrollTop = source.scrollTop;
}

function scrollToLine(line: number): void {
  const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 20;
  source.scrollTop = Math.max(0, line * lineHeight - source.clientHeight / 3);
  gutter.scrollTop = source.scrollTop;
}

function revealRange(text: string, d: Diagnostic): void {
  if (source.value !== text) return; // the list is from an older version; it is about to be replaced
  const start = offsetOf(text, d.line, d.column);
  const end = offsetOf(text, d.line, d.endColumn);
  source.focus({ preventScroll: true });
  source.setSelectionRange(start, end);
  scrollToLine(d.line);
}

function setText(text: string): void {
  source.value = text;
  updateGutter();
  render();
}

function applyEdit(edit: Edit): void {
  // Replace only what changed, so the editor keeps its scroll position.
  const change = changedRange(source.value, edit.text);
  source.setRangeText(change.insert, change.from, change.to, 'preserve');
  source.setSelectionRange(edit.start, edit.end);
  onInput();
}

let tabReleased = false;

source.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    tabReleased = true; // the next Tab moves focus out, so keyboard users are never trapped
    return;
  }
  if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey || tabReleased) {
    tabReleased = false;
    return;
  }
  event.preventDefault();
  const { selectionStart: start, selectionEnd: end, value } = source;
  applyEdit(event.shiftKey ? outdent(value, start, end) : indent(value, start, end));
});

function forgetLink(): void {
  if (!loadedFromLink) return;
  // Once a shared document is edited, the link in the address bar no longer matches it: drop it, so a reload
  // opens the draft rather than the original.
  loadedFromLink = false;
  history.replaceState(null, '', location.pathname + location.search);
}

function onInput(): void {
  updateGutter();
  scheduleRender();
  forgetLink();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => writeStored(DRAFT_KEY, source.value), DRAFT_DELAY);
}

source.addEventListener('input', onInput);
source.addEventListener('scroll', () => { gutter.scrollTop = source.scrollTop; }, { passive: true });

// Tabs (WAI-ARIA tabs pattern)

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

function selectTab(index: number, focus: boolean): void {
  tabs.forEach((tab, i) => {
    const selected = i === index;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
    if (panel) panel.hidden = !selected;
  });
  // Compare shows two previews side by side, so it gets more of the window than the editor.
  layout.classList.toggle('comparing', tabs[index]?.id === 'tab-compare');
  showPreviews();
  if (focus) tabs[index]?.focus();
}

function tabKeyTarget(key: string, index: number): number {
  const keys: Record<string, number> = {
    ArrowRight: (index + 1) % tabs.length,
    ArrowLeft: (index - 1 + tabs.length) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  };
  return keys[key] ?? -1;
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(index, false));
  tab.addEventListener('keydown', (event) => {
    const target = tabKeyTarget(event.key, index);
    if (target < 0) return;
    event.preventDefault();
    selectTab(target, true);
  });
});

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyLink(): Promise<void> {
  if (!canShare()) {
    showNotice('This browser cannot compress share links (it needs CompressionStream). Try a current Chrome, Edge, Firefox or Safari.', 'warning');
    return;
  }
  const fragment = await shareFragment(source.value);
  const url = location.href.split('#')[0] + fragment;
  history.replaceState(null, '', fragment);
  loadedFromLink = true;
  const copied = await copyText(url);
  const warning = shareLinkWarning(url);
  const status = copied ? 'Link copied.' : 'The link is in the address bar; copy it from there.';
  showNotice(warning ? `${status} ${warning}` : status, warning ? 'warning' : 'info');
}

async function copyMarkdown(): Promise<void> {
  const copied = await copyText(markdownOut.textContent ?? '');
  showNotice(copied ? 'Markdown copied.' : 'Could not copy; select the text and copy it instead.', copied ? 'info' : 'warning');
}

byId('copy-link').addEventListener('click', () => { void copyLink(); });
byId('copy-markdown').addEventListener('click', () => { void copyMarkdown(); });
byId('example').addEventListener('click', () => {
  if (source.value !== STARTER && source.value.trim() && !confirm('Replace the editor contents with the example document?')) return;
  setText(STARTER);
  forgetLink();
  writeStored(DRAFT_KEY, STARTER);
});
systemDark?.addEventListener('change', showPreviews);

/** Shows the Compare tab's .md side in this mode and renderer, and says what it is. */
function applyCompare(nextMode: CompareMode, nextRenderer: MarkdownRenderer): void {
  mode = nextMode;
  renderer = nextRenderer;
  compareSelect.value = mode;
  rendererSelect.value = renderer;
  compareNoteOut.textContent = compareNote(mode, renderer);
  showPreviews();
}

compareSelect.addEventListener('change', () => {
  const value = compareMode(compareSelect.value);
  writeStored(COMPARE_KEY, value);
  applyCompare(value, renderer);
});
rendererSelect.addEventListener('change', () => {
  const value = markdownRenderer(rendererSelect.value);
  writeStored(RENDERER_KEY, value);
  applyCompare(mode, value);
});
themeSelect.addEventListener('change', () => {
  const setting = themeSetting(themeSelect.value);
  writeStored(THEME_KEY, setting);
  applyTheme(setting);
});

async function loadFromHash(): Promise<boolean> {
  const found = await documentFromHash(location.hash);
  if (found.kind === 'invalid') showNotice(found.message, 'warning');
  if (found.kind !== 'document') return false;
  loadedFromLink = true;
  setText(found.text);
  return true;
}

window.addEventListener('hashchange', () => {
  if (fragmentPayload(location.hash) !== undefined) void loadFromHash();
});

async function start(): Promise<void> {
  applyTheme(theme);
  applyCompare(mode, renderer);
  if (await loadFromHash()) return;
  setText(readStored(DRAFT_KEY) ?? STARTER);
}

void start();

// Line numbers for an empty editor before the first render.
updateGutter();
