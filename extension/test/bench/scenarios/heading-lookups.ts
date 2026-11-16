import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { headingAt, renameHeading } from '../../../src/core/anchors';
import { parseSmd } from '../../../src/core/parse';
import { documentPreview, documentSymbols, sectionExcerpt } from '../../../src/core/symbols';
import { composite, edited } from '../profile';
import { defineScenario, type InProcessCase } from '../runner';
import { BenchClient, makeWorkspace, positionOf, type Workspace } from '../workspace';

/**
 * The editor lookups that need a document's headings (t-16, CL-09): the outline, the heading under the cursor, the
 * section and document previews hovers show, and renaming a heading, on a document of about 20k tokens (80 KB), and a
 * heading rename through the language server on the shared 40-document workspace. Cold clears the parse cache first,
 * cached asks again about the same text, and incremental asks after a small edit, as an editor does while typing.
 */

interface Doc { base: string; text: string; heading: number; slug: string }

function largeDocument(): Doc {
  const text = composite(20000, 'h');
  const headings = parseSmd(text).headings;
  const h = headings[Math.floor(headings.length / 2)];
  return { base: text, text, heading: h.line, slug: h.slug };
}

function lookup(name: string, run: (d: Doc) => unknown): InProcessCase<Doc> {
  return {
    name,
    setup: largeDocument,
    edit: (d, n) => { d.text = edited(d.base, n); },
    run,
  };
}

interface Lsp { ws: Workspace; text: string; client?: BenchClient; version: number }

const lspRename: InProcessCase<Lsp> = {
  name: 'language server rename of a heading, 40 documents',
  setup: () => {
    const ws = makeWorkspace(40);
    return { ws, text: fs.readFileSync(ws.first, 'utf8').replace('## Work', 'An unsaved line.\n\n## Work'), version: 0 };
  },
  teardown: (s) => { s.client?.dispose(); s.ws.remove(); },
  fresh: (s) => {
    s.client?.dispose();
    s.client = new BenchClient(s.ws.root);
    s.client.open(s.ws.first, s.text);
  },
  edit: (s, n) => {
    s.text = s.text.replace(/An unsaved line[^.]*\./, `An unsaved line, edit ${n}.`);
    s.client!.change(s.ws.first, s.text, ++s.version);
  },
  run: (s) => {
    if (!s.client) {
      s.client = new BenchClient(s.ws.root);
      s.client.open(s.ws.first, s.text);
    }
    const at = positionOf(s.text, '## Document 0');
    return s.client.request('textDocument/rename', { textDocument: { uri: pathToFileURL(s.ws.first).href }, position: { line: at.line, character: 4 }, newName: 'Document zero' });
  },
};

export default defineScenario({
  name: 'heading-lookups',
  description: 'Outline, heading under the cursor, section and document previews and heading rename on an 80 KB document, and a heading rename through the language server.',
  tasks: ['t-16'],
  cases: [
    lookup('outline symbols', (d) => documentSymbols(d.text)),
    lookup('heading under the cursor', (d) => headingAt(d.text, d.heading)),
    lookup('section preview', (d) => sectionExcerpt(d.text, d.slug)),
    lookup('document preview', (d) => documentPreview(d.text)),
    lookup('rename a heading', (d) => renameHeading(d.text, d.heading, 'Renamed heading')),
    lspRename,
  ],
});
