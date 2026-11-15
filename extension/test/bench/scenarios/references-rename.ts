import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defineScenario, type InProcessCase } from '../runner';
import { BenchClient, makeWorkspace, positionOf, type Workspace } from '../workspace';

/**
 * Find references and rename of a block id every document links to, through the language server, on a workspace whose
 * open document has unsaved text (t-20). Discovery (stats and folder listings), file reads and parses are counted
 * apart. Cold is the first request on a new server, cached a repeat, incremental a request after an edit to the open
 * document.
 */

interface State { ws: Workspace; text: string; client?: BenchClient; version: number }

function lspCase(name: string, count: number, request: (s: State) => unknown): InProcessCase<State> {
  const ready = (s: State) => {
    s.client = new BenchClient(s.ws.root);
    s.client.open(s.ws.first, s.text);
    s.version = 1;
  };
  return {
    name: `${name}, ${count} documents`,
    setup: () => {
      const ws = makeWorkspace(count);
      // Unsaved text in the open document: a line the file on disk does not have.
      const text = fs.readFileSync(ws.first, 'utf8').replace('## Work', 'An unsaved line.\n\n## Work');
      return { ws, text, version: 0 };
    },
    teardown: (s) => { s.client?.dispose(); s.ws.remove(); },
    fresh: (s) => {
      s.client?.dispose();
      ready(s);
    },
    edit: (s, n) => {
      s.text = s.text.replace('An unsaved line.', `An unsaved line, edit ${n}.`).replace(/edit \d+, edit/, 'edit');
      s.client!.change(s.ws.first, s.text, ++s.version);
    },
    run: (s) => {
      if (!s.client) ready(s);
      return request(s);
    },
  };
}

const at = (s: State) => ({ textDocument: { uri: pathToFileURL(s.ws.first).href }, position: positionOf(s.text, 'R-SHARED}') });
const references = (s: State) => s.client!.request('textDocument/references', { ...at(s), context: { includeDeclaration: true } });
const rename = (s: State) => s.client!.request('textDocument/rename', { ...at(s), newName: 'R-RENAMED' });

export default defineScenario({
  name: 'references-rename',
  description: 'Find references and rename of a shared block id through the language server, with unsaved open text.',
  tasks: ['t-20', 't-50'],
  cases: [lspCase('references', 40, references), lspCase('rename', 40, rename), lspCase('references', 200, references)],
});
