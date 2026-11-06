# Accessibility checks

This page says what is checked automatically, how to run the browser checks, what they found on one machine, and what still needs people. It follows item C10 of the implementation review. Automated checks catch regressions. They do not show that the product is usable with a screen reader, and they are not a certification of any kind.

## Two kinds of automated checks

**Source assertions.** These run with the unit tests (`npm test`) and need no browser.

- `extension/test/accessibility.test.ts` checks the rendered HTML and the CSS. It covers names on progress bars, status dots, task boxes and callouts, `<details>` with labels, table header scope, landmarks on exported pages and site pages, focus rings in the CSS, the reduced-motion rule, and the tab pattern driven through a small stand-in for the DOM.
- `extension/test/blockEditorWebview.test.ts` checks the Block Editor's labels and announcements, and that its page script builds the roles and labels it should.
- `extension/test/contrast.test.ts` checks colour contrast in both themes from the CSS custom properties.

These assertions read strings. They can't show what a browser builds from the markup, whether Tab reaches every control, or whether a key does what it should.

**Real-browser checks.** `extension/test/browser/a11y.ts` loads the pages in an installed Chromium-based browser and checks what the browser makes of them. It uses the same browser code as PDF export (`extension/src/pdfBrowser.ts`), so it needs no Playwright or Puppeteer. It drives the browser over the DevTools protocol, reading the accessibility tree and sending real key presses.

## Pages checked

The pages are built from `extension/test/samples/showcase.smd` and `checkout-redesign.smd`. Between them they have tabs, collapsible callouts and `<details>`, tasks, decisions, tables, Mermaid diagrams and math.

| Page | How it is built |
|---|---|
| Preview | As the preview panel builds it, with the same CSP, stylesheets and scripts from `extension/media/` |
| Block Editor | As the Block Editor builds it, with its page script bundled from `extension/src/webview/blockEditor.ts`. A `BlockEditorSession` on the sample answers the page's messages, as the extension does |
| Exported HTML | `smd export --to html` of the showcase |
| Site page | One page of `smd build` on both samples |

The webview pages load from `file://` instead of VS Code's resource URLs. A small stand-in replaces `acquireVsCodeApi` and records the messages the page sends. It also opens the Block Editor's closed shadow roots so the checks can walk them. The accessibility tree and the Tab order are the same either way. Exported pages use the extension's own copies of KaTeX and Mermaid instead of the CDN. Every remote request is blocked, and a page that asks for one fails the "loads" check.

VS Code adds its own default styles and theme variables to a webview. They are missing here, so the pages fall back to their own CSS. That makes the focus check a little stricter than in VS Code.

The agent-view inspector is not checked in the browser. It is a read-only text document, a status bar item and quick picks. All of that is VS Code's own UI, with no page of its own.

## What each page is checked for

| Check | What it does | WCAG |
|---|---|---|
| loads | The page renders its diagrams and math, logs no errors and asks for nothing remote | |
| tab order | Tab from the start, past the end and round again. Every tabbable control is reached, in document order, with no trap | 2.1.1, 2.1.2, 2.4.3 |
| focus visible | Each stop has an outline or box shadow, is on screen and is not transparent once focused | 2.4.7 |
| names | Every control in the accessibility tree has a name | 4.1.2 |
| image text | Every image and SVG document has a name | 1.1.1 |
| diagram text | Every rendered Mermaid diagram is a picture with a name and a description in the tree | 1.1.1 |
| focusable names | Other focusable elements that would be announced with no name. A warning only | |
| id references | `aria-labelledby`, `aria-controls`, `for` and the like point at exactly one element in their own tree scope | 4.1.2 |
| landmarks | `lang` is set, one `main`, and the roles each page should have. Site pages need a banner, search and named navigation. The Block Editor needs its named toolbar | 1.3.1, 3.1.1 |
| tabs keys | In every tab list, ArrowRight, ArrowLeft, Home and End move focus, `aria-selected`, the roving `tabindex` and the shown panel. The tree must report the tab as selected | 2.1.1, 4.1.2 |
| disclosure keys | Enter and Space open and close every visible `<details>`, and the tree's expanded state follows | 2.1.1, 4.1.2 |
| task boxes | In the preview and the Block Editor, Space toggles a task box, the tree reports the checked state, and the page asks the extension to change the line | 2.1.1, 4.1.2 |
| editor keys | Block Editor only. The arrow keys and Home move between blocks with one tab stop. Enter opens a labelled source editor and Escape returns to the block. Ctrl+/ opens the insert menu, ArrowDown moves in it and Escape returns. The arrow keys move along the toolbar, which has one tab stop | 2.1.1, 2.4.3, 4.1.2 |
| reduced motion | With reduced motion emulated, no element or pseudo-element has a transition or animation longer than 0.01 s | 2.3.3 |

## How to run it

```sh
cd extension
npm run test:a11y                         # table on stdout
npm run test:a11y -- --json               # the results as JSON
npm run test:a11y -- --require-browser    # fail when no browser is installed
npm run test:a11y -- --keep               # keep the built pages to open by hand
```

It looks for Chrome, Edge, Chromium or Brave. Without one it prints `skipped: no browser` and exits 0, so machines without a browser don't fail. `--require-browser` makes that exit 1. A run takes about 20 seconds. The pages and the browser profile go in a new folder under the OS temp folder, which is removed afterwards.

It exits 1 when a check fails. Known failures are listed in `KNOWN_FAILURES` in `a11y.ts`. They are printed but don't fail the run. When one stops showing up, the run says so, and the entry should go.

`extension/test/browserA11y.test.ts` tests the pure parts with no browser. It covers how the pages are built, the tree and Tab-walk analysis on hand-made data, and the known-failure handling. It also fails when the page lists in `a11y.ts` drift from the `shell()` methods in `preview.ts` and `blockEditor.ts`, which need `vscode` and can't be imported.

## Result on this machine

Run on 2026-11-06 with Google Chrome 156.0.8078.80, headless, on Windows 11. Microsoft Edge is installed too but won't start headless here.

78 checks passed, none failed, none were known failures, there were no warnings and 2 were skipped. The two skips are task boxes on exported pages, where a toggle changes no document.

Everything in the table above passed on all six pages.

### Child blocks in the Block Editor

The first run warned that blocks inside a container (paragraphs, lists, tables, columns) took focus with the arrow keys but had no name: 22 in the showcase and 15 in the checkout sample. Only a live region said a child's kind and lines when it got focus. Children are now named like top-level blocks ("Paragraph, lines 4–6", plus its problems), without losing their own role.

- A list, list item, table, row, figure, quote or `<details>` keeps its role and gets the name, so list and table navigation still work.
- A paragraph, a plain `div` or code can't take a name in ARIA, so it becomes a named group with the role description "block", as a top-level block is.
- A heading keeps its text as its name, and the live region still says its kind and lines.

### Diagrams

The first run found that diagrams had no text alternative (WCAG 1.1.1). A Mermaid diagram without `accTitle` became an `<svg role="graphics-document">` with no name, and `media/runtime.js` had replaced the diagram source, its only text version, with the SVG. This is fixed in the preview, the Block Editor, exported HTML and site pages, which all draw diagrams with the same runtime.

Each diagram's SVG now gets a name from the first of these that it has.

1. An `accTitle:` line, which Mermaid turns into the SVG's title.
2. The caption of the `:::figure` around it, such as "Figure 1: Writing, checking and exporting a document".
3. The diagram's own title, from `title:` in its front matter, `pie title …` or a `title …` line.
4. Otherwise just "Diagram", in the document's language.

Its description is the `accDescr:` text when there is one. Otherwise it is the diagram's source, so a screen reader can still read what the picture shows. The validator gives the hint `mermaid/acc-title` for a diagram that would only be called "Diagram". The "diagram text" check asks Chrome for each diagram's name and description, and the samples cover all four kinds of name.

## What still needs people

The browser checks show that the tree has names and states and that keys do what the code says. They can't show that a person can get their work done. The review is clear that this can't be inferred from automated checks.

- **Screen-reader spot checks.** Use NVDA and JAWS on Windows and VoiceOver on macOS, in VS Code and in a browser for exported pages. Things to listen for: how blocks and child blocks are announced in the Block Editor, live-region announcements (code copied, block moved, quick fixes), the insert menu and the properties panel, tabs and collapsible callouts, task boxes, and what is read for a diagram.
- **User tasks.** Ask people who use a keyboard or a screen reader every day to do real work. For example, find and tick a task, follow the contents to a section, edit a block's source, insert a callout, fix a problem from its quick fix, and export a page. Record time, mistakes and where they got stuck.
- **Things not covered here.** Contrast is checked from the CSS only, not on the rendered page. Zoom and reflow at 400%, forced-colors and high-contrast themes, VS Code's own UI (inspector, status bar, quick picks, the text editor) and other browsers are not covered.
