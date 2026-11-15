import * as fs from 'node:fs';
import { collect } from '../../../src/workspace';
import { defineScenario } from '../runner';
import { BenchClient, makeWorkspace, type Workspace } from '../workspace';

/**
 * Finding the documents of a workspace and indexing them: `collect` (the CLI and MCP walk) and the language server's
 * workspace symbols, which walk the folders and read each file's symbols, cached by modification time.
 */

interface State { ws: Workspace; client?: BenchClient }

const symbols = (count: number) => ({
  name: `workspace symbols, ${count} documents`,
  setup: (): State => ({ ws: makeWorkspace(count) }),
  teardown: (s: State) => { s.client?.dispose(); s.ws.remove(); },
  fresh: (s: State) => {
    s.client?.dispose();
    s.client = new BenchClient(s.ws.root);
  },
  // One file changes on disk, as a save from another editor would.
  edit: (s: State, n: number) => {
    const file = s.ws.files[n % s.ws.files.length];
    fs.appendFileSync(file, `\n## Added ${n}\n`);
    const later = new Date(Date.now() + (n + 1) * 1000);
    fs.utimesSync(file, later, later);
  },
  run: (s: State) => {
    s.client ??= new BenchClient(s.ws.root);
    return s.client.request('workspace/symbol', { query: '' });
  },
});

export default defineScenario({
  name: 'workspace-discovery',
  description: 'Finding a workspace\'s documents (collect) and indexing their symbols (language server workspace/symbol).',
  tasks: ['t-20', 't-26', 't-50'],
  cases: [
    {
      name: 'collect, 200 documents',
      setup: () => makeWorkspace(200),
      teardown: (ws: Workspace) => ws.remove(),
      run: (ws: Workspace) => collect(ws.root),
      modes: ['cold', 'cached'],
    },
    symbols(40),
    symbols(200),
  ],
});
