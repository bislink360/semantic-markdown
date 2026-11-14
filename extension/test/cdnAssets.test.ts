import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cdnPins, cdnPinsModule, integrityOf, verifyCdnPins } from '../scripts/cdn-pins.mjs';
import { CDN_ASSETS, cdnNeeds, katexStylesheetTag, mermaidScriptTag } from '../src/core/cdnAssets';
import { renderStandaloneHtml } from '../src/core/render';
import { buildSite } from '../src/core/site';
import { browserEngine, findInstalledBrowsers } from '../src/pdfBrowser';
import { cdnServer, hostServer, viaCdn, type LocalServer } from './activeContentFixture';

/**
 * The CDN assets of exported pages and sites are pinned to the versions the extension bundles, with integrity
 * hashes of their bytes (improvement roadmap t-14, CL-08).
 */

const root = join(__dirname, '..');
const media = (file: string) => fs.readFileSync(join(root, 'media', file), 'utf8');
const lock = JSON.parse(fs.readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> };
const page = (text: string) => renderStandaloneHtml(text, media('smd.css'), media('runtime.js'));
const DIAGRAM_AND_MATH = ['# Pinned', '', '```mermaid', 'graph TD; A-->B', '```', '', 'Math $x^2$ inline.', ''].join('\n');

test('t-14: each asset is the exact version package-lock.json installs, at a URL with that version', () => {
  for (const [key, asset] of Object.entries(CDN_ASSETS)) {
    assert.equal(asset.version, lock.packages[`node_modules/${asset.package}`].version, `${key} is the locked version`);
    assert.match(asset.version, /^\d+\.\d+\.\d+$/, `${key} names an exact version`);
    assert.equal(asset.url, `https://cdn.jsdelivr.net/npm/${asset.package}@${asset.version}/${asset.file}`);
    assert.match(asset.integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
  }
});

test('t-14: the pins are the hashes of the bundled bytes, and cdnPins.ts is what the build writes', () => {
  for (const asset of Object.values(CDN_ASSETS)) {
    assert.equal(asset.integrity, integrityOf(fs.readFileSync(join(root, 'node_modules', asset.package, asset.file))), asset.url);
  }
  const written = fs.readFileSync(join(root, 'src', 'core', 'cdnPins.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(written, cdnPinsModule(cdnPins(root)), 'src/core/cdnPins.ts is stale: run npm run build and commit it');
});

test('t-14: the tags carry the pinned URL, its hash and an anonymous cross-origin request', () => {
  const { katexCss, mermaidJs } = CDN_ASSETS;
  assert.equal(katexStylesheetTag(), `<link rel="stylesheet" href="${katexCss.url}" integrity="${katexCss.integrity}" crossorigin="anonymous">\n`);
  assert.equal(mermaidScriptTag(), `<script src="${mermaidJs.url}" integrity="${mermaidJs.integrity}" crossorigin="anonymous"></script>\n`);
  assert.match(mermaidScriptTag('abcdefghijklmnop'), /^<script nonce="abcdefghijklmnop" src=/);
});

test('t-14: standalone pages and site pages load an asset only when the body needs it, never a floating version', () => {
  assert.deepEqual(cdnNeeds('<p>plain</p>'), { math: false, diagrams: false });
  const plain = page('# Plain\n\nNo math.\n');
  assert.doesNotMatch(plain, /cdn\.jsdelivr/, 'a page without math or diagrams loads nothing from the CDN');
  const both = page(DIAGRAM_AND_MATH);
  assert.ok(both.includes(katexStylesheetTag()) && both.includes(CDN_ASSETS.mermaidJs.integrity));
  const site = buildSite([{ path: 'index.smd', text: DIAGRAM_AND_MATH }, { path: 'plain.smd', text: '# Plain\n' }]);
  const file = (p: string) => site.files.find((f) => f.path === p)!.content;
  assert.ok(file('index.html').includes(katexStylesheetTag()) && file('index.html').includes(CDN_ASSETS.mermaidJs.integrity));
  assert.doesNotMatch(file('plain.html'), /cdn\.jsdelivr/);
  for (const html of [both, file('index.html')]) {
    for (const url of html.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^"]+/g)) assert.match(url[0], /@\d+\.\d+\.\d+\//, `${url[0]} is pinned`);
  }
});

/** Whether jsDelivr answers, so a failed comparison is a mismatch and not an offline machine. */
async function cdnReachable(): Promise<boolean> {
  try {
    return (await fetch(CDN_ASSETS.katexCss.url, { method: 'HEAD', signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}

test('t-14: the bytes jsDelivr serves at each pinned URL match the pinned hash', { timeout: 120_000 }, async (t) => {
  if (!await cdnReachable()) {
    t.skip('jsDelivr is not reachable');
    return;
  }
  assert.deepEqual(await verifyCdnPins(root), []);
});

const browsers = findInstalledBrowsers();

interface Loaded { mermaid: boolean; diagrams: number; katexFont: boolean; unpinned: unknown; policy: boolean }

const LOADED = `new Promise((resolve) => {
  const read = () => JSON.stringify({
    mermaid: typeof window.mermaid !== 'undefined',
    diagrams: document.querySelectorAll('.smd-diagram svg').length,
    katexFont: /KaTeX/.test(getComputedStyle(document.querySelector('.katex')).fontFamily),
    unpinned: window.__smdUnpinned ?? null,
    policy: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
  });
  // Diagrams render after the library loads; give a refused library the same time to show it stayed away.
  const start = Date.now();
  const tick = () => (document.querySelector('.smd-diagram svg') || Date.now() - start > 4000 ? resolve(read()) : setTimeout(tick, 100));
  tick();
})`;

test('t-14: in a real browser the pinned assets load cross-origin from file: and hosted pages, under the content policy, and altered bytes are refused', {
  skip: !browsers.length && 'no Chrome, Edge, Chromium or Brave installed',
  timeout: 120_000,
}, async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-cdn-'));
  // A document that also asks for a script nobody pinned: the policy lets only the page's own and pinned ones run.
  const text = `${DIAGRAM_AND_MATH}\n<script src="CDN/npm/unpinned.js"></script>\n`;
  let cdn: LocalServer | undefined;
  let host: LocalServer | undefined;
  const engine = browserEngine(browsers);
  const browser = await engine.launch();
  try {
    cdn = await cdnServer(join(root, 'node_modules'));
    const html = page(text.replace('CDN', cdn.origin));
    assert.match(html, /Content-Security-Policy/, 'the integrity tests run under the t-54 policy');
    fs.writeFileSync(join(dir, 'page.html'), viaCdn(html, cdn));
    fs.writeFileSync(join(dir, 'tampered.html'), viaCdn(html, cdn, '/tampered'));
    // The control: the same altered bytes without the hashes load, so the refusal above is the hash's doing.
    fs.writeFileSync(join(dir, 'unhashed.html'), viaCdn(html, cdn, '/tampered').replace(/ integrity="[^"]+"/g, ''));
    host = await hostServer(dir);
    const open = async (url: string): Promise<Loaded> => {
      const tab = await browser.newPage();
      await tab.goto(url, { waitUntil: 'load', timeout: 60_000 });
      return JSON.parse(String(await tab.evaluate(LOADED))) as Loaded;
    };
    const fromFile = pathToFileURL(join(dir, 'page.html')).href;
    for (const url of [fromFile, `${host.origin}/page.html`]) {
      assert.deepEqual(await open(url), { mermaid: true, diagrams: 1, katexFont: true, unpinned: null, policy: true }, url);
    }
    const fetched = cdn.requests.filter((r) => r.path.endsWith('mermaid.min.js') || r.path.endsWith('katex.min.css'));
    assert.ok(fetched.length >= 4, 'both assets, for both pages');
    for (const r of fetched) assert.equal(r.mode, 'cors', `${r.path} was a cross-origin (CORS) request`);
    assert.ok(fetched.some((r) => r.origin === 'null'), 'the file: page asks with Origin: null');
    assert.ok(fetched.some((r) => r.origin === host!.origin), 'the hosted page asks with its own origin');
    assert.ok(!cdn.requests.some((r) => r.path === '/npm/unpinned.js'), 'the unpinned script is not even fetched');

    for (const url of [pathToFileURL(join(dir, 'tampered.html')).href, `${host.origin}/tampered.html`]) {
      assert.deepEqual(await open(url), { mermaid: false, diagrams: 0, katexFont: false, unpinned: null, policy: true }, `${url}: altered bytes are refused`);
    }
    assert.ok(cdn.requests.some((r) => r.path.startsWith('/tampered/npm/mermaid@')), 'the altered library was fetched, then refused');
    assert.deepEqual(await open(`${host.origin}/unhashed.html`), { mermaid: true, diagrams: 1, katexFont: true, unpinned: null, policy: true });
  } finally {
    await browser.close();
    await cdn?.close();
    await host?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
