import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BLOCKED_ELEMENTS, blockActiveContent, printPolicy } from '../src/core/activeContent';
import { renderStandaloneHtml } from '../src/core/render';
import { createPrintPage, exportPdf, lightTheme, PDF_BEFORE_PRINT, PDF_READY_CHECK, type PdfBrowser, type PdfEngine, type PdfPage } from '../src/pdf';
import { browserEngine, findInstalledBrowsers } from '../src/pdfBrowser';

/**
 * Active document content is blocked in PDF export (improvement roadmap t-12, CL-04), and each export gets a print
 * page of its own (t-13, EV-03).
 */

const media = (file: string) => fs.readFileSync(join(__dirname, '..', 'media', file), 'utf8');
const NONCE = 'dGVzdC1ub25jZS0xMjM0NTY3';
const page = (text: string, nonce?: string) => renderStandaloneHtml(text, media('smd.css'), media('runtime.js'), nonce ? { nonce } : {});

/** Raw HTML that would run, embed or navigate if the page let it. Each part only sets a marker, so it is inert. */
const HOSTILE = [
  '---', 'smd: 2', 'title: Print policy', '---', '',
  '# Print policy', '',
  '<script>window.__smdDocScript = 1</script>', '',
  '<p>Image <img id="bad-img" src="data:," onerror="window.__smdOnError = 1"> and <a id="js-link" href="javascript:window.__smdJsUrl = 1">link</a></p>', '',
  '<iframe id="frame" srcdoc="<script>parent.__smdSrcdoc = 1</script><p>inside</p>"></iframe>', '',
  '<object id="obj" data="data:text/html,<p>object</p>">object fallback</object>', '',
  '<embed id="emb" src="data:text/html,<p>embed</p>">', '',
  '<IFRAME\nsrc="data:text/html,x"></IFRAME>', '',
  '<meta http-equiv="refresh" content="1;url=data:text/html,moved">', '',
  '<base href="https://example.invalid/">', '',
  '<svg width="10" height="10"><script>window.__smdSvgScript = 1</script></svg>', '',
  '<form id="form" action="https://example.invalid/submit"><button>Send</button></form>', '',
  '<div id="raw" style="color: rgb(200, 0, 0)">Raw <b>bold</b> HTML</div>', '',
  '```mermaid', 'graph TD; A-->B', '```', '',
  'Math $x^2$ inline.', '',
].join('\n');

test('t-12: the print policy lets only nonce scripts run and refuses frames, plug-ins, workers, forms and base', () => {
  const policy = printPolicy(NONCE);
  assert.match(policy, /^default-src 'none'; /);
  assert.ok(policy.includes(`script-src 'nonce-${NONCE}'`));
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/, 'event attributes and javascript: URLs stay blocked');
  for (const directive of ["object-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'", "connect-src 'none'"]) {
    assert.ok(policy.includes(directive), directive);
  }
  assert.throws(() => printPolicy('short'), /16 base64/);
  assert.throws(() => printPolicy(`${NONCE}'; script-src *`), /16 base64/);
});

test('t-12: blockActiveContent renames every blocked start and end tag, in any case and spacing, and nothing else', () => {
  for (const name of BLOCKED_ELEMENTS) {
    assert.equal(blockActiveContent(`<${name} a="1"></${name}>`), `<smd-blocked-${name} a="1"></smd-blocked-${name}>`);
    assert.equal(blockActiveContent(`<${name.toUpperCase()}\n>`), `<smd-blocked-${name}\n>`);
    assert.equal(blockActiveContent(`<${name}/>`), `<smd-blocked-${name}/>`);
    assert.equal(blockActiveContent(`<${name}`), `<smd-blocked-${name}`);
  }
  // Longer names that only start with a blocked one, escaped text and code are left alone.
  for (const kept of ['<metadata>', '<iframes>', '<basefont>', '<embedded-x>', '&lt;iframe&gt;', '<code>&lt;meta&gt;</code>']) {
    assert.equal(blockActiveContent(kept), kept);
  }
});

test('t-12: a page with a nonce carries the policy first in <head>, nonces only its own scripts and renames document elements', () => {
  const html = page(HOSTILE, NONCE);
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /^<!DOCTYPE html>\n<html[^>]*>\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="[^"]+">/);
  assert.equal(html.match(/<script nonce="/g)?.length, 2, 'the diagram library and the runtime');
  const body = html.slice(html.indexOf('<main id="smd-root">'), html.lastIndexOf('</main>'));
  assert.doesNotMatch(body, /nonce=/);
  assert.doesNotMatch(body, /<(iframe|object|embed|meta|base)[\s/>]/i);
  assert.match(body, /<smd-blocked-iframe id="frame"/);
  assert.match(body, /<div id="raw" style="color: rgb\(200, 0, 0\)">Raw <b>bold<\/b> HTML<\/div>/, 'ordinary raw HTML is unchanged');
  assert.equal(page(HOSTILE), page(HOSTILE, undefined), 'without a nonce the page is as before');
  assert.doesNotMatch(page(HOSTILE), /Content-Security-Policy|smd-blocked-/);
});

/** An engine whose browser fails or succeeds as the test says, and records the page it was given. */
function fakeEngine(options: { fail?: 'launch' | 'pdf'; seen?: string[]; html?: string[] } = {}): PdfEngine {
  const newPage = async (): Promise<PdfPage> => ({
    goto: async (url) => {
      options.seen?.push(url);
      options.html?.push(fs.readFileSync(new URL(url), 'utf8'));
    },
    waitForFunction: async () => true,
    evaluate: async () => undefined,
    pdf: async () => {
      if (options.fail === 'pdf') throw new Error('the browser crashed');
      return new TextEncoder().encode('%PDF-1.7 fake');
    },
  });
  const browser: PdfBrowser = { newPage, close: async () => undefined };
  return {
    name: 'fake',
    launch: async () => {
      if (options.fail === 'launch') throw new Error('no display');
      return browser;
    },
    waitFor: async () => true,
  };
}

const OPTIONS = { format: 'A4', landscape: false, timeout: 5_000 };

function folder() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-print-'));
  const source = join(dir, 'plan.smd');
  fs.writeFileSync(source, '# Plan\n');
  return { dir, source };
}

test('t-12: exportPdf renders with a fresh nonce each time and prints that page', async () => {
  const { dir, source } = folder();
  const nonces: string[] = [];
  const html: string[] = [];
  const render = (nonce: string) => { nonces.push(nonce); return page(HOSTILE, nonce); };
  await exportPdf(source, render, join(dir, 'a.pdf'), OPTIONS, { engine: fakeEngine({ html }), warn: assert.fail });
  await exportPdf(source, render, join(dir, 'b.pdf'), OPTIONS, { engine: fakeEngine({ html }), warn: assert.fail });
  assert.equal(nonces.length, 2);
  assert.notEqual(nonces[0], nonces[1]);
  for (const [i, nonce] of nonces.entries()) {
    assert.match(nonce, /^[A-Za-z0-9+/]{24}$/);
    assert.ok(html[i].includes(`script-src 'nonce-${nonce}'`));
    assert.ok(html[i].includes('data-smd-theme-pref="light"'), 'printed in the light theme');
  }
});

test('t-13: the print page is created exclusively; a file already at a name is skipped and left untouched', async () => {
  const { dir, source } = folder();
  const taken = join(dir, '.plan.smd.aaaa.print.html');
  fs.writeFileSync(taken, 'not ours');
  const names = ['aaaa', 'bbbb'];
  const seen: string[] = [];
  await exportPdf(source, () => '<html lang="en" data-smd-theme-pref="auto"><p>Plan</p>', join(dir, 'out.pdf'), OPTIONS, {
    engine: fakeEngine({ seen }), warn: assert.fail, random: () => names.shift() ?? 'zzzz',
  });
  assert.deepEqual(seen, [pathToFileURL(join(dir, '.plan.smd.bbbb.print.html')).href]);
  assert.equal(fs.readFileSync(taken, 'utf8'), 'not ours', 'the file that was there is unchanged');
  assert.deepEqual(fs.readdirSync(dir).sort((a, b) => a.localeCompare(b)), ['.plan.smd.aaaa.print.html', 'out.pdf', 'plan.smd']);
  assert.throws(() => createPrintPage(source, () => 'aaaa'), /every name tried was taken/);
});

test('t-13: concurrent exports of one document each print their own page and remove only it', async () => {
  const { dir, source } = folder();
  const seen: string[] = [];
  const html: string[] = [];
  await Promise.all(['one', 'two', 'three'].map((label) => exportPdf(
    source, () => `<html lang="en" data-smd-theme-pref="auto"><p>${label}</p>`, join(dir, `${label}.pdf`), OPTIONS,
    { engine: fakeEngine({ seen, html }), warn: assert.fail },
  )));
  assert.equal(new Set(seen).size, 3, 'three distinct pages');
  for (const label of ['one', 'two', 'three']) assert.ok(html.some((h) => h.includes(`<p>${label}</p>`)), label);
  assert.deepEqual(fs.readdirSync(dir).sort((a, b) => a.localeCompare(b)), ['one.pdf', 'plan.smd', 'three.pdf', 'two.pdf']);
});

test('t-13: a browser that fails to start or to print leaves no page behind and touches nothing else', async () => {
  for (const fail of ['launch', 'pdf'] as const) {
    const { dir, source } = folder();
    fs.writeFileSync(join(dir, '.plan.smd.other.print.html'), 'another export');
    await assert.rejects(exportPdf(source, () => '<html lang="en" data-smd-theme-pref="auto">', join(dir, 'out.pdf'), OPTIONS, {
      engine: fakeEngine({ fail }), warn: assert.fail,
    }));
    assert.deepEqual(fs.readdirSync(dir).sort((a, b) => a.localeCompare(b)), ['.plan.smd.other.print.html', 'plan.smd'], fail);
  }
});

test('t-13: relative assets still resolve from the print page beside the document', async () => {
  const { dir, source } = folder();
  const seen: string[] = [];
  await exportPdf(source, () => '<html lang="en" data-smd-theme-pref="auto"><img src="img/a.png">', join(dir, 'out.pdf'), OPTIONS, {
    engine: fakeEngine({ seen }), warn: assert.fail,
  });
  assert.equal(new URL('img/a.png', seen[0]).href, pathToFileURL(join(dir, 'img', 'a.png')).href);
});

const browsers = findInstalledBrowsers();

/** Whether the diagram library's CDN answers, so a missing diagram is a failure and not an offline machine. */
async function cdnReachable(): Promise<boolean> {
  try {
    const response = await fetch('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js', { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

test('t-12: in a real browser the print page blocks the document\'s active content and still renders the rest', {
  skip: !browsers.length && 'no Chrome, Edge, Chromium or Brave installed',
  timeout: 120_000,
}, async () => {
  const { dir, source } = folder();
  const file = join(dir, 'print.html');
  fs.writeFileSync(file, lightTheme(page(HOSTILE, NONCE)));
  const url = pathToFileURL(file).href;
  const engine = browserEngine(browsers);
  const browser = await engine.launch();
  try {
    const tab = await browser.newPage();
    await tab.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await engine.waitFor(tab, PDF_READY_CHECK, 60_000);
    await tab.evaluate(PDF_BEFORE_PRINT);
    await tab.evaluate("document.getElementById('js-link').click()");
    // Give a meta refresh (one second) and the javascript: link time to act if they could.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const state = await tab.evaluate(`JSON.stringify({
      href: location.href, base: document.baseURI,
      docScript: window.__smdDocScript, onError: window.__smdOnError, jsUrl: window.__smdJsUrl,
      srcdoc: window.__smdSrcdoc, svgScript: window.__smdSvgScript,
      frames: document.querySelectorAll('iframe, frame, object, embed, meta[http-equiv], base').length,
      ready: document.documentElement.getAttribute('data-smd-ready'),
      raw: getComputedStyle(document.getElementById('raw')).color,
      bold: !!document.querySelector('#raw b'),
      math: document.querySelectorAll('.katex').length,
      mermaidLoaded: typeof window.mermaid !== 'undefined',
      diagrams: document.querySelectorAll('.smd-diagram svg').length,
      styled: getComputedStyle(document.body).fontFamily !== '',
    })`);
    const s = JSON.parse(String(state)) as Record<string, unknown>;
    assert.equal(s.href, url, 'no meta refresh moved the page');
    assert.equal(s.base, url, 'the document\'s <base> does nothing');
    for (const marker of ['docScript', 'onError', 'jsUrl', 'srcdoc', 'svgScript']) assert.equal(s[marker], undefined, `${marker} did not run`);
    assert.equal(s.frames, 1, 'only the page\'s own policy <meta> is left');
    assert.equal(s.ready, 'true', 'the trusted runtime ran');
    assert.equal(s.raw, 'rgb(200, 0, 0)', 'ordinary raw HTML keeps its inline style');
    assert.equal(s.bold, true);
    assert.ok(Number(s.math) > 0, 'math renders');
    assert.equal(s.styled, true);
    if (s.mermaidLoaded || await cdnReachable()) {
      assert.equal(s.mermaidLoaded, true, 'the diagram library loads under the policy');
      assert.ok(Number(s.diagrams) > 0, 'the diagram renders');
    }
    const pdf = await tab.pdf({ format: 'A4', printBackground: true });
    assert.equal(Buffer.from(pdf).subarray(0, 5).toString('latin1'), '%PDF-');

    // The control: the same document without the policy runs its markers, so the checks above can fail.
    const open = join(dir, 'open.html');
    fs.writeFileSync(open, lightTheme(page(HOSTILE.replace('content="1;url=data:text/html,moved"', 'content="60"'))));
    const control = await browser.newPage();
    await control.goto(pathToFileURL(open).href, { waitUntil: 'load', timeout: 60_000 });
    const ran = JSON.parse(String(await control.evaluate(
      "JSON.stringify({ docScript: window.__smdDocScript, onError: window.__smdOnError, svgScript: window.__smdSvgScript, frames: document.querySelectorAll('iframe, object, embed').length })",
    ))) as Record<string, unknown>;
    assert.deepEqual(ran, { docScript: 1, onError: 1, svgScript: 1, frames: 4 });
  } finally {
    await browser.close();
  }
});
