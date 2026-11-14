import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decideLink, decodePath, followLink, inside, type LinkContext, type LinkOpener } from '../src/linkPolicy';

/**
 * One link policy at the webview host boundary (improvement roadmap t-11, CL-03). The host is tested with a stub
 * opener, so each case shows what reaches the opener and what is refused.
 */

/** A workspace with a document, a sibling file, a folder outside it, and links out of it where the system allows. */
function workspace() {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'smd-links-')));
  const root = join(base, 'ws');
  const outside = join(base, 'outside');
  fs.mkdirSync(join(root, 'docs'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(join(root, 'docs', 'spec.smd'), '# Spec\n');
  fs.writeFileSync(join(root, 'docs', 'my notes.smd'), '# Notes\n');
  fs.writeFileSync(join(root, 'README.md'), '# Readme\n');
  fs.writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  // A directory link works without extra rights on Windows as a junction.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, join(root, 'docs', 'escape'), linkType);
  fs.mkdirSync(join(root, 'inner'));
  fs.writeFileSync(join(root, 'inner', 'ok.smd'), '# Ok\n');
  fs.symlinkSync(join(root, 'inner'), join(root, 'docs', 'alias'), linkType);
  let fileLink = false;
  try {
    fs.symlinkSync(join(outside, 'secret.txt'), join(root, 'docs', 'secret-link.txt'), 'file');
    fileLink = true;
  } catch {
    // File links need extra rights on Windows; the directory links cover the same check.
  }
  const context: LinkContext = { documentDir: join(root, 'docs'), roots: [root] };
  return { base, root, outside, context, fileLink };
}

function stubOpener() {
  const calls: Array<[keyof LinkOpener, string]> = [];
  const opener: LinkOpener = {
    openExternal: (url) => { calls.push(['openExternal', url]); },
    openFile: (file) => { calls.push(['openFile', file]); },
    refuse: (message) => { calls.push(['refuse', message]); },
    missing: (message) => { calls.push(['missing', message]); },
  };
  return { calls, opener };
}

test('t-11: http, https and mailto reach the external opener and nothing else does', async () => {
  const { context } = workspace();
  for (const href of ['https://example.com/a?b=1#c', 'http://example.com', 'mailto:team@example.com', 'HTTPS://Example.com/']) {
    const { calls, opener } = stubOpener();
    await followLink(href, context, opener);
    assert.equal(calls.length, 1, href);
    assert.equal(calls[0][0], 'openExternal', href);
    assert.equal(calls[0][1], new URL(href).href);
  }
});

test('t-11: command:, vscode:, javascript:, data: and custom schemes are refused with a message that shows the link', async () => {
  const { context } = workspace();
  const hrefs = [
    'command:workbench.action.terminal.new', 'command:_workbench.downloadResource?%5B%22x%22%5D', 'vscode:extension/evil.ext',
    'vscode-insiders://settings', 'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'myapp://do/thing',
    'ftp://example.com/x', 'C:/Windows/win.ini',
  ];
  for (const href of hrefs) {
    const { calls, opener } = stubOpener();
    const decision = await followLink(href, context, opener);
    assert.equal(decision.kind, 'refused', href);
    assert.deepEqual(calls.map(([kind]) => kind), ['refuse'], href);
    assert.ok(calls[0][1].includes(`"${href}"`), `the message shows ${href}: ${calls[0][1]}`);
  }
});

test('t-11: malformed links are refused, not thrown', async () => {
  const { context } = workspace();
  for (const href of ['%E0%A4%A', 'docs/%ZZ.smd', 'http://[::1', 'https://exa mple.com', '', '   ', 'a\0b', 'x'.repeat(5000), 42, undefined, null, { href: 'x' }]) {
    const { calls, opener } = stubOpener();
    const decision = await followLink(href, context, opener);
    assert.equal(decision.kind, 'refused', String(href).slice(0, 40));
    assert.deepEqual(calls.map(([kind]) => kind), ['refuse']);
  }
  assert.equal(decodePath('%E0%A4%A'), undefined);
  assert.equal(decodePath('my%20notes.smd'), 'my notes.smd');
});

test('t-11: relative links open inside the root, with escapes decoded, and a missing file is reported', async () => {
  const { root, context } = workspace();
  const opened = async (href: string) => {
    const { calls, opener } = stubOpener();
    await followLink(href, context, opener);
    return calls;
  };
  assert.deepEqual(await opened('spec.smd#goals'), [['openFile', join(root, 'docs', 'spec.smd')]]);
  assert.deepEqual(await opened('my%20notes.smd'), [['openFile', join(root, 'docs', 'my notes.smd')]]);
  assert.deepEqual(await opened('../README.md?plain=1'), [['openFile', join(root, 'README.md')]]);
  const missing = await opened('gone.smd');
  assert.equal(missing[0][0], 'missing');
  assert.match(missing[0][1], /"gone\.smd" does not exist/);
});

test('t-11: relative and file: links outside every root are refused before the disk is read', async () => {
  const { outside, context } = workspace();
  const reads: string[] = [];
  const watched: LinkContext = { ...context, realpath: (file) => { reads.push(file); return fs.existsSync(file) ? file : undefined; } };
  for (const href of ['../../outside/secret.txt', pathToFileURL(join(outside, 'secret.txt')).href, '/etc/passwd', '//server/share/x', '\\\\server\\share\\x']) {
    const { calls, opener } = stubOpener();
    const decision = await followLink(href, watched, opener);
    assert.equal(decision.kind, 'refused', href);
    assert.deepEqual(calls.map(([kind]) => kind), ['refuse'], href);
  }
  assert.deepEqual(reads, [], 'no path outside the roots was looked up');
});

test('t-11: a raw HTML file: href inside the workspace opens in the editor', async () => {
  const { root, context } = workspace();
  const { calls, opener } = stubOpener();
  await followLink(`${pathToFileURL(join(root, 'docs', 'spec.smd')).href}#top`, context, opener);
  assert.deepEqual(calls, [['openFile', join(root, 'docs', 'spec.smd')]]);
});

test('t-11: real-path containment: a link inside the root that leads out is refused, one that stays in is followed', async () => {
  const { root, context, fileLink } = workspace();
  const out = stubOpener();
  assert.equal((await followLink('escape/secret.txt', context, out.opener)).kind, 'refused');
  assert.deepEqual(out.calls.map(([kind]) => kind), ['refuse']);
  const viaFileUrl = stubOpener();
  assert.equal((await followLink(pathToFileURL(join(root, 'docs', 'escape', 'secret.txt')).href, context, viaFileUrl.opener)).kind, 'refused');
  const stays = stubOpener();
  await followLink('alias/ok.smd', context, stays.opener);
  assert.deepEqual(stays.calls, [['openFile', join(root, 'inner', 'ok.smd')]], 'the real path is what opens');
  if (fileLink) {
    const file = stubOpener();
    assert.equal((await followLink('secret-link.txt', context, file.opener)).kind, 'refused');
  }
});

test('t-11: a standalone document may link beside itself only; an unsaved one has no relative links', async () => {
  const { root } = workspace();
  const standalone: LinkContext = { documentDir: join(root, 'docs'), roots: [join(root, 'docs')] };
  assert.equal(decideLink('spec.smd', standalone).kind, 'file');
  assert.equal(decideLink('../README.md', standalone).kind, 'refused');
  const unsaved: LinkContext = { roots: [root] };
  assert.equal(decideLink('spec.smd', unsaved).kind, 'refused');
  assert.equal(decideLink('https://example.com', unsaved).kind, 'external');
});

test('t-11: inside() compares whole path segments', () => {
  const base = os.tmpdir();
  assert.equal(inside(join(base, 'ws'), join(base, 'ws')), true);
  assert.equal(inside(join(base, 'ws'), join(base, 'ws', 'a', 'b')), true);
  assert.equal(inside(join(base, 'ws'), join(base, 'ws-other', 'a')), false);
  assert.equal(inside(join(base, 'ws'), join(base, 'ws', '..', 'x')), false);
  assert.equal(inside(join(base, 'ws'), join(base, 'ws', '..foo')), true, 'a name that starts with two dots is still inside');
});
