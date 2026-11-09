// The preview's study page script, built only by `build.mjs --study` into dist/webview/study-cues.js and loaded only
// by a study build's preview. It tells the extension which cues were on screen and for how long, and which
// collapsible cues were opened or closed: kinds, source lines and block ids, never text. The extension drops the
// messages unless a study session is logging, and checks every field again.

interface Runtime {
  vscode: { postMessage(message: unknown): void } | null;
}

const runtime = (globalThis as { smdRuntime?: Runtime }).smdRuntime;
const host = runtime?.vscode;

/** How long a cue must be at least half visible to count as seen. */
const DWELL = 500;
/** How often time on screen so far is reported. */
const CHUNK = 5000;
/** Kinds of rendered cues, from their classes (core/render.ts). */
const CALLOUT = /^smd-callout-([a-z]+)$/;

interface Cue {
  kind: string;
  line: number;
  block?: string;
  status?: string;
}

/** The cue an element renders, or nothing. */
function cueOf(el: Element): Cue | undefined {
  const line = Number(el.getAttribute('data-line'));
  if (!Number.isInteger(line) || line < 0) return undefined;
  const id = el.id || el.getAttribute('data-review-for') || undefined;
  const cue = (kind: string, status?: string): Cue => ({ kind, line, block: id && /^[A-Za-z][\w.:-]{0,63}$/.test(id) ? id : undefined, status });
  const classes = Array.from(el.classList);
  if (el.classList.contains('smd-review')) return cue(el.getAttribute('data-review') ?? 'comment', el.getAttribute('data-review-status') ?? undefined);
  if (el.classList.contains('smd-decision')) {
    const status = classes.map((c) => /^smd-decision-([a-z]+)$/.exec(c)?.[1]).find((s) => s && !['head', 'label', 'status', 'title', 'body'].includes(s));
    return cue('decision', status);
  }
  if (el.classList.contains('smd-human')) return cue('human');
  if (el.classList.contains('smd-agent')) return cue('agent');
  if (el.classList.contains('smd-details')) return cue('details');
  if (el.classList.contains('smd-task')) return cue('task', (el.querySelector('.smd-task-box') as HTMLInputElement | null)?.checked ? 'done' : undefined);
  for (const c of classes) {
    const kind = CALLOUT.exec(c)?.[1];
    if (kind && kind !== 'title' && kind !== 'body' && kind !== 'icon') return cue(kind);
  }
  return undefined;
}

const SELECTOR = '#smd-root [data-line].smd-callout, #smd-root [data-line].smd-decision, #smd-root [data-line].smd-review, '
  + '#smd-root [data-line].smd-human, #smd-root details[data-line], #smd-root li[data-line].smd-task';

function post(message: Record<string, unknown>): void {
  host?.postMessage({ type: 'studyCue', ...message });
}

if (host && typeof IntersectionObserver === 'function') {
  /** When each cue on screen came into view (or was last reported), and which ones were reported while on screen. */
  const since = new Map<Element, number>();
  const reported = new Set<Element>();
  const report = (el: Element, start: number, at: number) => {
    const cue = cueOf(el);
    if (cue) post({ event: 'visible', ...cue, durationMs: Math.round(at - start) });
  };
  const end = (el: Element, at: number) => {
    const start = since.get(el);
    since.delete(el);
    const continued = reported.delete(el);
    if (start === undefined || (at - start < DWELL && !(continued && at > start))) return;
    report(el, start, at);
  };
  // A page can be torn down without notice (hidden webviews are not kept), so time on screen is reported in chunks:
  // the log sums a cue's `cue.visible` durations.
  setInterval(() => {
    const at = performance.now();
    for (const [el, start] of since) {
      if (at - start < DWELL) continue;
      report(el, start, at);
      since.set(el, at);
      reported.add(el);
    }
  }, CHUNK);
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && document.visibilityState === 'visible') {
        if (!since.has(entry.target)) since.set(entry.target, entry.time);
      } else end(entry.target, entry.time);
    }
  }, { threshold: 0.5 });

  let watched: Element[] = [];
  const watch = () => {
    const at = performance.now();
    for (const el of watched) {
      if (!el.isConnected) end(el, at);
      observer.unobserve(el);
    }
    watched = Array.from(document.querySelectorAll(SELECTOR));
    for (const el of watched) observer.observe(el);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const root = document.getElementById('smd-root');
  if (root) {
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(watch, 300);
    }).observe(root, { childList: true, subtree: true });
  }
  watch();

  // A hidden page sees nothing: what was on screen ends now, and starts again when the page is shown.
  document.addEventListener('visibilitychange', () => {
    const at = performance.now();
    if (document.visibilityState !== 'visible') [...since.keys()].forEach((el) => end(el, at));
    else watch();
  });

  // Only toggles a person made: the runtime also opens and closes <details> when it restores the page's state.
  let input = Number.NEGATIVE_INFINITY;
  const touched = () => { input = performance.now(); };
  document.addEventListener('click', touched, true);
  document.addEventListener('keydown', touched, true);
  document.addEventListener('toggle', (e) => {
    if (performance.now() - input > 1000) return;
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement) || !el.closest('#smd-root')) return;
    const cue = cueOf(el.hasAttribute('data-line') ? el : (el.closest('[data-line]') ?? el));
    if (cue) post({ event: 'toggle', kind: cue.kind, line: cue.line, block: cue.block, state: el.open ? 'open' : 'closed' });
  }, true);
}

export {};
