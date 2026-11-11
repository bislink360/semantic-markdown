import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import {
  BLOCK_EDITOR_SCRIPTS, BLOCK_EDITOR_STYLES, KNOWN_FAILURES, PREVIEW_SCRIPTS, PREVIEW_STYLES, VSCODE_STUB,
  analyseTabWalk, applyKnown, blockEditorPage, claimsReducedMotion, formatTable, hasFocusIndicator, idRefProblems, landmarks, longestMotion,
  missingRoles, pageCss, parseArgs, previewPage, remoteUrls, seconds, siteFiles, standalonePage, stepKey, tabsProblems, themePref,
  diagramProblems, unnamedControls, unnamedFocusables, unnamedImages,
  type AXNode, type CheckResult, type PageUrls, type TabStep,
} from './browser/a11y';

// The pure parts of the real-browser accessibility checks (test/browser/a11y.ts): building the pages, and reading
// the accessibility tree, the Tab walk, tab lists and motion. No browser is started here; `npm run test:a11y` does that.

const samples = join(__dirname, 'samples');
const showcase = readFileSync(join(samples, 'showcase.smd'), 'utf8');
const checkout = readFileSync(join(samples, 'checkout-redesign.smd'), 'utf8');
const urls: PageUrls = {
  media: (...parts) => `file:///ext/media/${parts.join('/')}`,
  stub: 'file:///tmp/vscode-stub.js',
  blockEditorScript: 'file:///tmp/block-editor.js',
};
const scriptSrcs = (html: string) => [...html.matchAll(/<script nonce="n1" src="([^"]+)"><\/script>/g)].map((m) => m[1]);

test('preview page: the shell the preview builds, stub first, local files, no remote loads', () => {
  const html = previewPage(showcase, join(samples, 'showcase.smd'), urls, 'n1');
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: https: data:; style-src file: 'unsafe-inline'; font-src file: data:; script-src 'nonce-n1'; form-action 'none'">/);
  assert.deepEqual(scriptSrcs(html), ['file:///tmp/vscode-stub.js', 'file:///ext/media/vendor/mermaid.min.js', 'file:///ext/media/runtime.js']);
  assert.match(html, /<link rel="stylesheet" href="file:\/\/\/ext\/media\/vendor\/katex\/katex.min.css">\n<link rel="stylesheet" href="file:\/\/\/ext\/media\/smd.css">/);
  assert.match(html, /<base href="file:\/\/\/[^"]+\/test\/samples\/">/);
  assert.match(html, /<body class="smd-body">\n<main id="smd-root" data-smd-sync="\{&quot;version&quot;:1/);
  assert.match(html, /class="smd-tabs"/, 'the sample has tabs');
  assert.match(html, /class="smd-task-box"/, 'and tasks');
  assert.doesNotMatch(html, /vscode-resource|vscode-webview/);
  assert.deepEqual(remoteUrls(html), []);
});

test('block editor page: the shell the Block Editor builds, with its script last and its CSS for the shadow roots', () => {
  const html = blockEditorPage(join(samples, 'showcase.smd'), urls, 'n1');
  assert.deepEqual(scriptSrcs(html), ['file:///tmp/vscode-stub.js', 'file:///ext/media/vendor/mermaid.min.js', 'file:///ext/media/runtime.js', 'file:///tmp/block-editor.js']);
  assert.match(html, /<body class="smd-body smd-ed-body" data-smd-mode="block-editor" data-smd-ed-css="file:\/\/\/ext\/media\/block-editor.css">/);
  assert.match(html, /<div id="smd-ed-toolbar"><\/div>\n<main id="smd-root" class="smd-ed-root"><\/main>/);
  assert.throws(() => blockEditorPage('x.smd', { ...urls, blockEditorScript: undefined }), /needs its script/);
});

test('page lists mirror shell() in src/preview.ts and src/blockEditor.ts', () => {
  const read = (name: string) => readFileSync(join(__dirname, '..', 'src', name), 'utf8');
  const calls = (source: string, start: string) => {
    const at = source.indexOf(start);
    assert.ok(at >= 0, start);
    const list = source.slice(at, source.indexOf(']', at) + 1);
    return [...list.matchAll(/media\(([^)]*)\)|\bcss\b/g)].map((m) => (m[1] === undefined ? ['block-editor.css'] : [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1])));
  };
  const preview = read('preview.ts');
  const editor = read('blockEditor.ts');
  assert.match(editor, /const css = media\('block-editor\.css'\);/);
  assert.deepEqual(calls(preview, 'styles: ['), PREVIEW_STYLES);
  assert.deepEqual(calls(preview, 'scripts: ['), PREVIEW_SCRIPTS);
  assert.deepEqual(calls(editor, 'styles: ['), BLOCK_EDITOR_STYLES);
  assert.deepEqual(calls(editor, 'scripts: ['), BLOCK_EDITOR_SCRIPTS);
  assert.match(editor, /body: '<div id="smd-ed-toolbar"><\/div>\\n<main id="smd-root" class="smd-ed-root"><\/main>'/);
  assert.match(editor, /render: \(text\) => renderBlocks\(text, \{ \.\.\.options\(\), inlineIndex: true \}\)/, 'the host renders blocks as the harness does');
  assert.match(preview, /allowHtml: config\.get<boolean>\('allowHtml', true\)/);
  assert.match(preview, /'showAgentBlocks', 'collapsed'\)/);
  assert.equal(themePref({ theme: 'Dark' }), 'dark');
  assert.equal(themePref({}), 'auto');
});

test('exported pages: KaTeX and Mermaid from the extension, not the CDN; the site\'s own files filled in', () => {
  const page = standalonePage(showcase, join(samples, 'showcase.smd'), urls);
  assert.doesNotMatch(page, /cdn\.jsdelivr\.net/);
  assert.match(page, /<script src="file:\/\/\/ext\/media\/vendor\/mermaid\.min\.js"><\/script>/);
  assert.match(page, /<title>[^<]+<\/title>/);
  assert.deepEqual(remoteUrls(page), []);
  const files = siteFiles([{ path: 'showcase.smd', text: showcase }, { path: 'checkout-redesign.smd', text: checkout }], urls);
  const css = files.find((f) => f.path === '_smd/smd.css')!;
  assert.match(css.content, /prefers-reduced-motion/);
  const site = files.find((f) => f.path === 'checkout-redesign.html')!;
  assert.deepEqual(remoteUrls(site.content), []);
  assert.match(site.content, /<a class="smd-site-skip" href="#smd-root">/);
});

test('remoteUrls: what a page loads, not links to follow', () => {
  assert.deepEqual(remoteUrls('<script src="https://x/a.js"></script><img src="//y/i.png"><link rel="stylesheet" href="http://z/s.css"><a href="https://w/">w</a>'), ['https://x/a.js', '//y/i.png', 'http://z/s.css']);
});

test('the VS Code stand-in keeps posted messages and state, and opens shadow roots for the harness', () => {
  const attached: unknown[] = [];
  class Element {
    attachShadow(init: unknown) {
      attached.push(init);
      return { init };
    }
  }
  const window: Record<string, unknown> = {};
  vm.runInNewContext(VSCODE_STUB, { window, Element, JSON });
  const api = (window.acquireVsCodeApi as () => { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void })();
  const message = { type: 'ready', nested: { a: 1 } };
  api.postMessage(message);
  message.nested.a = 2;
  // Arrays and objects made inside the context have its prototypes: compare them as plain data.
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  assert.deepEqual(plain(window.__smdOutbox), [{ type: 'ready', nested: { a: 1 } }], 'a copy, as postMessage clones');
  assert.deepEqual(plain(window.__smdSent), plain(window.__smdOutbox));
  assert.equal(api.getState(), undefined);
  api.setState({ tabs: {} });
  assert.deepEqual(api.getState(), { tabs: {} });
  new Element().attachShadow({ mode: 'closed', delegatesFocus: true });
  assert.deepEqual(plain(attached), [{ mode: 'open', delegatesFocus: true }]);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { json: false, requireBrowser: false, keep: false });
  assert.deepEqual(parseArgs(['--json', '--require-browser', '--keep']), { json: true, requireBrowser: true, keep: true });
  assert.throws(() => parseArgs(['--fast']), /Unknown option: --fast/);
});

const node = (nodeId: string, role: string, name = '', extra: Partial<AXNode> = {}): AXNode =>
  ({ nodeId, ignored: false, role: { type: 'role', value: role }, name: { type: 'computedString', value: name }, ...extra });
const focusable = { properties: [{ name: 'focusable', value: { type: 'booleanOrUndefined', value: true } }] };

const tree: AXNode[] = [
  node('1', 'RootWebArea', 'Doc', focusable),
  node('2', 'main'),
  node('3', 'navigation', 'Contents'),
  node('4', 'button', 'Copy code', focusable),
  node('5', 'checkbox', '  ', focusable),
  node('6', 'link', '', { ...focusable, backendDOMNodeId: 42 }),
  node('7', 'DisclosureTriangle', 'More', focusable),
  node('8', 'graphics-document', ''),
  node('9', 'image', 'Logo'),
  node('10', 'generic', '', focusable),
  node('11', 'tabpanel', 'npm', focusable),
  node('12', 'button', '', { ...focusable, ignored: true }),
  node('13', 'toolbar', 'Block editor'),
  node('14', 'navigation', 'Breadcrumb'),
];

test('unnamed controls, images and other focusable elements', () => {
  assert.deepEqual(unnamedControls(tree).map((n) => n.nodeId), ['5', '6'], 'blank names count as none; ignored nodes don\'t count');
  assert.deepEqual(unnamedImages(tree).map((n) => n.nodeId), ['8']);
  assert.deepEqual(unnamedFocusables(tree).map((n) => n.nodeId), ['10'], 'not the page, a named panel or a control');
  assert.deepEqual(unnamedFocusables([node('m', 'main', '', focusable)]), [], 'a main that a skip link focuses');
});

test('landmarks and expected roles', () => {
  assert.deepEqual(landmarks(tree), [{ role: 'main', name: '' }, { role: 'navigation', name: 'Contents' }, { role: 'navigation', name: 'Breadcrumb' }]);
  assert.deepEqual(missingRoles(tree, [{ role: 'main', exactly: 1 }, { role: 'toolbar', name: 'Block editor' }, { role: 'navigation', name: 'Contents' }]), []);
  assert.deepEqual(missingRoles(tree, [{ role: 'banner' }, { role: 'navigation', exactly: 1 }, { role: 'navigation', name: 'Documents' }]), [
    'no banner', '2 × navigation, expected 1', 'no navigation "Documents"',
  ]);
});

test('id references: missing or repeated in their own tree scope', () => {
  const problems = idRefProblems([
    { scope: 'document', ids: ['a', 'b', 'b', 'menu'], refs: [
      { attr: 'aria-labelledby', ids: ['a', 'b'], where: 'section#p' },
      { attr: 'aria-controls', ids: ['menu'], where: 'button' },
      { attr: 'for', ids: ['x'], where: 'label' },
    ] },
    { scope: 'shadow root of div#bar', ids: ['menu'], refs: [{ attr: 'aria-controls', ids: ['menu'], where: 'button "Insert…"' }] },
    { scope: 'shadow root of div#pop', ids: [], refs: [{ attr: 'aria-labelledby', ids: ['a'], where: 'div[role=dialog]' }] },
  ]);
  assert.deepEqual(problems, [
    'section#p: aria-labelledby → "b" is used by 2 elements in the document',
    'label: for → "x" is not in the document',
    'div[role=dialog]: aria-labelledby → "a" is not in the shadow root of div#pop',
  ], 'an id in another scope does not count');
});

const ring = { outlineStyle: 'solid', outlineWidth: '2px', boxShadow: 'none', inView: true, opacity: 1 };
const at = (expected: number, order: number, extra: Partial<TabStep> = {}): TabStep => ({ body: false, desc: `el${expected}`, order, expected, ...ring, ...extra });
const BODY: TabStep = { body: true };

test('hasFocusIndicator: an outline with a width, or a box shadow', () => {
  assert.equal(hasFocusIndicator({ outlineStyle: 'auto', outlineWidth: '1px', boxShadow: 'none' }), true, 'the browser\'s own ring');
  assert.equal(hasFocusIndicator({ outlineStyle: 'none', outlineWidth: '2px', boxShadow: 'none' }), false);
  assert.equal(hasFocusIndicator({ outlineStyle: 'solid', outlineWidth: '0px', boxShadow: 'none' }), false);
  assert.equal(hasFocusIndicator({ outlineStyle: 'none', outlineWidth: '0px', boxShadow: 'rgb(0, 0, 0) 0px 0px 0px 2px' }), true);
});

test('analyseTabWalk: a clean walk from mid-page, past the end and round', () => {
  const expected = ['el0', 'el1', 'el2', 'el3'];
  const walk = analyseTabWalk(expected, [at(2, 30), at(3, 40), BODY, at(0, 5), at(1, 10), at(2, 30)]);
  assert.deepEqual(walk, { unreached: [], backwards: [], trap: undefined, invisible: [], reached: 4 });
  assert.equal(stepKey(at(2, 99)), '#2', 'the same stop when its position shifts');
  assert.equal(stepKey({ body: false, desc: 'div.x', expected: -1 }), 'div.x');
});

test('analyseTabWalk: unreached, out of order, trapped, and invisible focus', () => {
  const expected = ['el0', 'el1', 'el2', 'el3', 'el4'];
  const out = analyseTabWalk(expected, [at(0, 5), at(2, 30), at(1, 10), at(3, 40), BODY, at(0, 5)], [true, true, true, true, false]);
  assert.deepEqual(out.unreached, [], 'el4 left the tab order during the walk (roving tabindex)');
  assert.deepEqual(out.backwards, ['el2 → el1']);
  assert.deepEqual(analyseTabWalk(expected, [at(0, 5), BODY, at(0, 5)]).unreached, ['el1', 'el2', 'el3', 'el4']);
  assert.equal(analyseTabWalk(expected, [at(0, 5), at(1, 10), at(1, 10), at(1, 10)]).trap, 'focus stays on el1');
  assert.equal(analyseTabWalk(expected, [at(0, 5), at(1, 10)]).trap, 'focus never came back round past the last control');
  const seen = analyseTabWalk(['el0', 'el1', 'el2'], [
    at(0, 5, { outlineStyle: 'none' }), at(1, 10, { inView: false }), at(2, 20, { opacity: 0 }), BODY, at(0, 5, { outlineStyle: 'none' }),
  ]);
  assert.deepEqual(seen.invisible, ['el0: no outline or box-shadow', 'el1: off screen when focused', 'el2: opacity 0 when focused']);
});

test('tabsProblems: focus, aria-selected, roving tabindex and the shown panel', () => {
  const good = { focused: 1, selected: ['false', 'true', 'false'], tabindex: ['-1', '0', '-1'], panels: [false, true, false] };
  assert.deepEqual(tabsProblems(1, good), []);
  assert.deepEqual(tabsProblems(2, good), [
    'focus on tab 2, expected 3', 'tab 2 aria-selected=true', 'tab 3 aria-selected=false', 'tab 2 tabindex=0', 'tab 3 tabindex=-1',
    'panel 2 shown', 'panel 3 hidden',
  ]);
  assert.deepEqual(tabsProblems(0, { focused: 0, selected: ['true'], tabindex: ['0'], panels: [null] }), ['tab 1 controls no panel']);
});

test('seconds and longestMotion', () => {
  assert.deepEqual(seconds('0s, .15s, 200ms'), [0, 0.15, 0.2]);
  assert.deepEqual(seconds(''), []);
  const style = { desc: 'x', transitionProperty: 'opacity', transitionDuration: '0.15s', animationName: 'none', animationDuration: '2s' };
  assert.equal(longestMotion(style), 0.15, 'an animation named none does not run');
  assert.equal(longestMotion({ ...style, transitionProperty: 'none', animationName: 'spin' }), 2);
  assert.equal(longestMotion({ ...style, transitionDuration: '0s' }), 0);
});

test('pageCss: inline styles and linked sheets, resolved against <base>; claimsReducedMotion', () => {
  const read = (url: string) => ({ 'file:///media/smd.css': '@media (prefers-reduced-motion: reduce) { * { transition: none } }', 'file:///site/_smd/site.css': 'a {}' } as Record<string, string>)[url];
  const html = '<base href="file:///docs/"><link rel="stylesheet" href="file:///media/smd.css"><style>b {}</style>';
  assert.deepEqual(pageCss(html, 'file:///tmp/page.html', read), ['b {}', '@media (prefers-reduced-motion: reduce) { * { transition: none } }']);
  assert.equal(claimsReducedMotion(pageCss(html, 'file:///tmp/page.html', read)), true);
  const site = pageCss('<link rel="stylesheet" href="_smd/site.css">', 'file:///site/page.html', read);
  assert.deepEqual(site, ['a {}']);
  assert.equal(claimsReducedMotion(site), false);
});

test('applyKnown: known failures are listed, not failed; new ones still fail; ones that went away are reported', () => {
  const known = [{ page: /^preview/, check: 'image text', item: /^graphics-document/, note: 'diagrams' }, { page: /./, check: 'names', item: /x/, note: 'gone' }];
  const results: CheckResult[] = [
    { page: 'preview: a', check: 'image text', status: 'fail', detail: '1 image', items: ['graphics-document: <svg>'] },
    { page: 'preview: b', check: 'image text', status: 'fail', detail: '2 images', items: ['graphics-document: <svg>', 'image: <img src=x>'] },
    { page: 'site', check: 'image text', status: 'fail', detail: '1 image', items: ['graphics-document: <svg>'] },
    { page: 'preview: a', check: 'tab order', status: 'pass', detail: 'ok' },
  ];
  const { results: out, unseen } = applyKnown(results, known);
  assert.deepEqual(out.map((r) => r.status), ['known', 'fail', 'fail', 'pass']);
  assert.deepEqual(out[1].items, ['image: <img src=x>']);
  assert.equal(out[1].detail, '2 images (1 known)');
  assert.deepEqual(unseen.map((k) => k.note), ['gone']);
});

test('known failures say where, what and which WCAG criterion; diagrams are not one of them', () => {
  for (const k of KNOWN_FAILURES) assert.match(k.note, /WCAG \d\.\d\.\d+/, k.note);
  const diagram = 'graphics-document: <svg id="smd-mermaid-3" width="100%"';
  assert.ok(!KNOWN_FAILURES.some((k) => k.check === 'image text' && k.item.test(diagram)), 'a diagram with no name fails the run');
});

test('diagramProblems: every diagram needs a picture role, a name and a description', () => {
  assert.deepEqual(diagramProblems([
    { id: 'smd-mermaid-1', role: 'graphics-document', name: 'Figure 1: Flow', description: 'Diagram source: flowchart LR' },
    { id: 'smd-mermaid-2', role: 'img', name: '', description: 'Diagram source: pie' },
    { id: 'smd-mermaid-3', role: 'generic', name: 'Diagram', description: '' },
  ]), ['smd-mermaid-2: no name', 'smd-mermaid-3: role "generic" is not a picture role', 'smd-mermaid-3: no description']);
});

test('formatTable: one row per check, problems listed under failures and warnings only', () => {
  const text = formatTable([
    { page: 'preview: a.smd', check: 'names', status: 'pass', detail: '3 controls, all named', items: ['hidden'] },
    { page: 'preview: a.smd', check: 'tab order', status: 'fail', detail: '2 problem(s)', items: ['not reached: a', 'went back: b → c', 'x'] },
  ], 2);
  const lines = text.split('\n');
  assert.match(lines[0], /^Page\s+Check\s+Result\s+Detail$/);
  assert.match(lines[2], /^preview: a\.smd\s+names\s+PASS\s+3 controls, all named$/);
  assert.match(text, /- not reached: a\n\s+- went back: b → c\n\s+- … and 1 more/);
  assert.doesNotMatch(text, /hidden/);
});
