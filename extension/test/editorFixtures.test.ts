import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SmdLanguageServer } from '../src/lsp';
import type { LspMessage, LspResponse } from '../src/lspProtocol';

/**
 * The shared editor behavior fixtures (improvement roadmap t-04), through the language server. test/integration/suite.js
 * runs the same cases through the VS Code providers. Both compare with test/editor/expected.json, which records where
 * the two differ today.
 *
 * SMD_EDITOR_FIXTURES_OUT=<file> writes the language server's answers there instead of checking them, to update
 * expected.json after an intended change (test/editor/README.md).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fixtures = require('./editor/fixtures.cjs') as {
  CASES: Array<{ name: string; feature: 'hover' | 'completion' | 'outline' | 'references' | 'rename'; file: string; at?: object; newName?: string }>;
  cursor: (text: string, at: object) => { line: number; character: number };
  fromLsp: Record<string, (result: unknown, root?: string, fileOf?: (uri: string) => string) => unknown>;
  expectedFor: (name: string, adapter: 'vscode' | 'lsp') => unknown;
  expected: () => Record<string, { both?: unknown; vscode?: unknown; lsp?: unknown; difference?: string }>;
  copyWorkspace: (parent: string) => string;
};
const expectedFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'editor', 'expected.json'), 'utf8')) as {
  policy: { triggerCharacters: { vscode: string[]; lsp: string[]; difference: string } };
};

const METHODS = {
  hover: 'textDocument/hover', completion: 'textDocument/completion', outline: 'textDocument/documentSymbol',
  references: 'textDocument/references', rename: 'textDocument/rename',
} as const;

function server(root: string) {
  const sent: LspMessage[] = [];
  const s = new SmdLanguageServer({ version: 'test', send: (m) => sent.push(m), onExit: () => undefined, log: () => undefined, mermaid: null, validateDelay: 0, today: '2026-11-01' });
  let id = 0;
  const request = (method: string, params: unknown) => {
    const n = ++id;
    s.endpoint.receive({ jsonrpc: '2.0', id: n, method, params });
    const response = sent.find((m) => 'id' in m && m.id === n) as LspResponse;
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };
  const init = request('initialize', {
    processId: null, rootUri: pathToFileURL(root).href,
    capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, rename: { prepareSupport: true } } },
  }) as { capabilities: { completionProvider: { triggerCharacters: string[] } } };
  s.endpoint.receive({ jsonrpc: '2.0', method: 'initialized', params: {} });
  return { request, init, dispose: () => s.dispose(), open: (file: string) => s.endpoint.receive({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: pathToFileURL(file).href, languageId: 'smd', version: 1, text: fs.readFileSync(file, 'utf8') } },
  }) };
}

/** Every case through the language server, in the normal form, by name. */
function lspAnswers(): Record<string, unknown> {
  const root = fixtures.copyWorkspace(fs.realpathSync(os.tmpdir()));
  const lsp = server(root);
  try {
    const out: Record<string, unknown> = {};
    for (const c of fixtures.CASES) {
      const file = path.join(root, c.file);
      lsp.open(file);
      const uri = pathToFileURL(file).href;
      const position = c.at ? fixtures.cursor(fs.readFileSync(file, 'utf8'), c.at) : undefined;
      const params = {
        textDocument: { uri }, ...(position ? { position } : {}),
        ...(c.feature === 'references' ? { context: { includeDeclaration: true } } : {}),
        ...(c.feature === 'rename' ? { newName: c.newName } : {}),
      };
      // A refused request (a rename that can't be made) is an answer too, as its message.
      try {
        out[c.name] = fixtures.fromLsp[c.feature](lsp.request(METHODS[c.feature], params), root, (u: string) => fileURLToPath(u));
      } catch (err) {
        out[c.name] = { error: (err as Error).message };
      }
    }
    return out;
  } finally {
    lsp.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('t-04: every shared editor fixture gets the answer expected of the language server', () => {
  const answers = lspAnswers();
  if (process.env.SMD_EDITOR_FIXTURES_OUT) {
    fs.writeFileSync(process.env.SMD_EDITOR_FIXTURES_OUT, JSON.stringify(answers, null, 2) + '\n');
    return;
  }
  for (const c of fixtures.CASES) assert.deepEqual(answers[c.name], fixtures.expectedFor(c.name, 'lsp'), c.name);
});

test('t-04: expected.json has an entry for every case, and every recorded difference says why', () => {
  const expected = fixtures.expected();
  assert.deepEqual(Object.keys(expected).sort(), fixtures.CASES.map((c) => c.name).sort());
  for (const [name, e] of Object.entries(expected)) {
    if ('both' in e) assert.ok(!('vscode' in e) && !('lsp' in e), `${name}: one answer or two`);
    else {
      assert.ok('vscode' in e && 'lsp' in e, `${name}: both answers`);
      assert.notDeepEqual(e.vscode, e.lsp, `${name}: a difference that isn't one is "both"`);
      assert.ok(e.difference && e.difference.length > 20, `${name}: the difference is explained`);
    }
  }
  const features = new Set(fixtures.CASES.map((c) => c.feature));
  assert.deepEqual([...features].sort(), ['completion', 'hover', 'outline', 'references', 'rename']);
});

test('t-04: completion trigger characters, a registration policy of each adapter, are as recorded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-triggers-'));
  try {
    const lsp = server(root);
    const advertised = lsp.init.capabilities.completionProvider.triggerCharacters;
    lsp.dispose();
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'language.ts'), 'utf8');
    const registration = /registerCompletionItemProvider\(SELECTOR, new CompletionProvider\(\), ([^)]*)\)/.exec(source)![1];
    const footnotes = /registerCompletionItemProvider\(SELECTOR, new FootnoteCompletionProvider\(\), ([^)]*)\)/.exec(source)![1];
    const vscode = [...registration.matchAll(/'((?:\\.|[^'])*)'/g), ...footnotes.matchAll(/'((?:\\.|[^'])*)'/g)].map((m) => m[1]);
    const recorded = expectedFile.policy.triggerCharacters;
    assert.deepEqual([...vscode].sort(), [...recorded.vscode].sort());
    assert.deepEqual([...advertised].sort(), [...recorded.lsp].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
