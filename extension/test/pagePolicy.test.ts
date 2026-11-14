import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withPageNonce } from '../src/core/activeContent';
import { CDN_ASSETS } from '../src/core/cdnAssets';
import { renderStandaloneHtml } from '../src/core/render';
import { buildSite, type SiteBuild } from '../src/core/site';
import { browserEngine, findInstalledBrowsers } from '../src/pdfBrowser';
import { cdnServer, HOSTILE, HOSTILE_MARKERS, HOSTILE_STATE, hostServer, viaCdn, type LocalServer } from './activeContentFixture';

/**
 * Export to HTML and the pages of a site load under the same content policy as the PDF print page (improvement
 * roadmap t-54, CL-04), with the pinned assets of t-14 as the only scripts from elsewhere.
 */

const root = join(__dirname, '..');
const media = (file: string) => fs.readFileSync(join(root, 'media', file), 'utf8');
const page = (text: string, contentPolicy?: boolean) => renderStandaloneHtml(text, media('smd.css'), media('runtime.js'), contentPolicy === undefined ? {} : { contentPolicy });
const SITE_ASSETS = { css: media('smd.css'), siteCss: media('site.css'), runtimeJs: media('runtime.js'), siteJs: media('site.js') };
const site = (text: string, contentPolicy?: boolean): SiteBuild => buildSite(
  [{ path: 'index.smd', text: '---\ntitle: Home\n---\n# Home\n\nSee [the hostile page](hostile.smd).\n' }, { path: 'hostile.smd', text }],
  { assets: SITE_ASSETS, today: '2026-11-14', ...(contentPolicy === undefined ? {} : { contentPolicy }) },
);
const fileOf = (build: SiteBuild, path: string) => build.files.find((f) => f.path === path)!.content;
const nonceOf = (html: string) => /script-src 'nonce-([^']+)'/.exec(html)?.[1];

test('t-54: Export to HTML loads under the policy by default, and the nonce comes from the page', () => {
  const html = page(HOSTILE);
  const nonce = nonceOf(html);
  assert.match(String(nonce), /^[0-9a-f]{32}$/);
  assert.match(html, /^<!DOCTYPE html>\n<html[^>]*>\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" /);
  assert.equal(html.match(new RegExp(`<script nonce="${nonce}"`, 'g'))?.length, 2, 'the pinned library and the runtime');
  assert.match(html, /<smd-blocked-iframe id="frame"/);
  assert.equal(page(HOSTILE), html, 'the same document gives the same page');
  assert.notEqual(nonceOf(page(`${HOSTILE}\nOne more line.\n`)), nonce, 'another document gives another nonce');
  const open = page(HOSTILE, false);
  assert.doesNotMatch(open, /Content-Security-Policy|smd-blocked-|nonce=/, 'contentPolicy: false writes the page as before');
  assert.match(open, /<iframe id="frame"/);
});

test('t-54: a document can\'t carry the page nonce, not even the draft one the nonce is derived from', () => {
  const drafts: string[] = [];
  const final = withPageNonce((n) => {
    drafts.push(n);
    return `<p>${n}</p>`;
  });
  assert.deepEqual(drafts, ['smd-draft-page-nonce', final.slice(3, -4)], 'drafted with the placeholder, then rendered again with the nonce');
  const sneaky = page('# Sneaky\n\n<script nonce="smd-draft-page-nonce">window.__smdDocScript = 1</script>\n');
  assert.ok(sneaky.includes('<script nonce="smd-draft-page-nonce">'), 'the document\'s script keeps its own attribute');
  assert.notEqual(nonceOf(sneaky), 'smd-draft-page-nonce', 'and the policy names a different nonce');
});

test('t-54: every page of a site loads under the policy, with the site\'s scripts nonced and the document\'s elements inert', () => {
  const build = site(HOSTILE);
  for (const path of ['index.html', 'hostile.html', 'dashboard.html']) {
    const html = fileOf(build, path);
    const nonce = nonceOf(html);
    assert.match(String(nonce), /^[0-9a-f]{32}$/, path);
    // The page's own scripts, that is, those outside the document's content.
    const shell = html.slice(0, html.indexOf('<main')) + html.slice(html.lastIndexOf('</main>'));
    const scripts = [...shell.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(scripts.length >= 2, `${path}: the runtime and the site script`);
    for (const script of scripts) assert.ok(script.includes(`nonce="${nonce}"`), `${path}: ${script}`);
  }
  const hostile = fileOf(build, 'hostile.html');
  assert.match(hostile, /<smd-blocked-iframe id="frame"/);
  assert.ok(hostile.includes(CDN_ASSETS.mermaidJs.integrity), 'the pinned library');
  assert.notEqual(nonceOf(fileOf(build, 'index.html')), nonceOf(hostile), 'each page has a nonce of its own');
  assert.deepEqual(site(HOSTILE).files, build.files, 'a build is reproducible');
  const open = fileOf(site(HOSTILE, false), 'hostile.html');
  assert.doesNotMatch(open, /Content-Security-Policy|smd-blocked-|nonce=/, 'contentPolicy: false builds the pages as before');
});

const cli = join(root, 'dist', 'cli.js');

test('t-54: smd export --to html and smd build apply the policy, and --no-content-policy turns it off', {
  skip: !fs.existsSync(cli) && 'run npm run build first',
}, () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-policy-cli-'));
  try {
    fs.mkdirSync(join(dir, 'docs'));
    fs.writeFileSync(join(dir, 'docs', 'index.smd'), HOSTILE);
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
    const exported = run('export', 'docs/index.smd', '--to', 'html');
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, /Content-Security-Policy/);
    assert.equal(exported.stderr, '');
    const open = run('export', 'docs/index.smd', '--to', 'html', '--no-content-policy');
    assert.equal(open.status, 0, open.stderr);
    assert.doesNotMatch(open.stdout, /Content-Security-Policy|smd-blocked-/);
    assert.equal(open.stderr, '', 'the option is known, so there is no warning');
    assert.equal(run('render', 'docs/index.smd', '--no-content-policy').stderr, '');
    assert.equal(run('build', 'docs', '--out', 'site').status, 0);
    assert.match(fs.readFileSync(join(dir, 'site', 'index.html'), 'utf8'), /Content-Security-Policy/);
    const built = run('build', 'docs', '--out', 'open', '--no-content-policy');
    assert.equal(built.status, 0, built.stderr);
    assert.doesNotMatch(built.stderr, /warning/);
    assert.doesNotMatch(fs.readFileSync(join(dir, 'open', 'index.html'), 'utf8'), /Content-Security-Policy/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const browsers = findInstalledBrowsers();

test('t-54: in a real browser the exported page and the site block the document\'s active content, from file: and from a host', {
  skip: !browsers.length && 'no Chrome, Edge, Chromium or Brave installed',
  timeout: 180_000,
}, async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-page-policy-'));
  let cdn: LocalServer | undefined;
  let host: LocalServer | undefined;
  const engine = browserEngine(browsers);
  const browser = await engine.launch();
  try {
    cdn = await cdnServer(join(root, 'node_modules'));
    // The pinned assets come from the stand-in CDN, so the test runs offline and still checks their hashes.
    fs.writeFileSync(join(dir, 'export.html'), viaCdn(page(HOSTILE), cdn));
    fs.writeFileSync(join(dir, 'open.html'), viaCdn(page(HOSTILE.replace('content="1;url=data:text/html,moved"', 'content="60"'), false), cdn));
    for (const f of site(HOSTILE).files) {
      fs.mkdirSync(join(dir, 'site', f.path, '..'), { recursive: true });
      fs.writeFileSync(join(dir, 'site', f.path), f.path.endsWith('.html') ? viaCdn(f.content, cdn) : f.content);
    }
    host = await hostServer(dir);
    const state = async (url: string) => {
      const tab = await browser.newPage();
      await tab.goto(url, { waitUntil: 'load', timeout: 60_000 });
      await engine.waitFor(tab, "document.documentElement.getAttribute('data-smd-ready') === 'true' && !!document.querySelector('.smd-diagram svg')", 60_000);
      await tab.evaluate("document.getElementById('js-link').click()");
      // Give a meta refresh (one second) and the javascript: link time to act if they could.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return { tab, s: JSON.parse(String(await tab.evaluate(HOSTILE_STATE))) as Record<string, unknown> };
    };
    const pages = ['export.html', 'site/hostile.html'];
    for (const url of pages.flatMap((p) => [pathToFileURL(join(dir, p)).href, `${host!.origin}/${p}`])) {
      const { tab, s } = await state(url);
      assert.equal(s.href, url, `${url}: no meta refresh moved the page`);
      assert.equal(s.base, url, `${url}: the document's <base> does nothing`);
      for (const marker of HOSTILE_MARKERS) assert.equal(s[marker], undefined, `${url}: ${marker} did not run`);
      assert.equal(s.frames, 1, `${url}: only the page's own policy <meta> is left`);
      assert.equal(s.raw, 'rgb(200, 0, 0)', `${url}: ordinary raw HTML keeps its inline style`);
      assert.equal(s.bold, true);
      assert.ok(Number(s.math) > 0, `${url}: math renders`);
      assert.equal(s.mermaidLoaded, true, `${url}: the pinned library loads under the policy`);
      assert.ok(Number(s.diagrams) > 0, `${url}: the diagram renders`);
      assert.equal(s.styled, true);
      if (url.includes('site/')) {
        // The site script runs, and so does the search index it adds on demand, which carries the page's nonce.
        await tab.evaluate("(() => { const q = document.getElementById('smd-site-q'); q.value = 'home'; q.dispatchEvent(new Event('input', { bubbles: true })); })()");
        await engine.waitFor(tab, "!!window.SMD_SEARCH_INDEX && !document.getElementById('smd-site-results').hidden", 30_000);
      }
    }

    // The control: the same document without the policy runs its markers, so the checks above can fail.
    const { s } = await state(`${host.origin}/open.html`);
    assert.deepEqual(
      { docScript: s.docScript, onError: s.onError, svgScript: s.svgScript, frames: Number(s.frames) >= 4 },
      { docScript: 1, onError: 1, svgScript: 1, frames: true },
    );
  } finally {
    await browser.close();
    await cdn?.close();
    await host?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
