import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LspMessage, LspResponse } from '../../src/lspProtocol';
import { SmdLanguageServer } from '../../src/lsp';

/**
 * Shared material for the benchmark scenarios (test/bench/scenarios): a generated workspace of linked documents, and
 * a language server driven in this process through its protocol endpoint, as test/lsp.test.ts drives it.
 */

export interface Workspace {
  root: string;
  files: string[];
  /** The first document, which gives the shared rule every other document links to. */
  first: string;
  remove: () => void;
}

/**
 * `count` documents in folders of ten under a new temp folder. Document 0 gives `R-SHARED`, every document links to it
 * and to the next document's heading, and each gives a requirement and a task of its own.
 */
export function makeWorkspace(count: number): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-bench-ws-'));
  const rel = (i: number) => `area-${Math.floor(i / 10)}/doc-${i}.smd`;
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const file = path.join(root, rel(i));
    const up = (j: number) => path.posix.relative(path.posix.dirname(rel(i)), rel(j));
    const lines = [
      '---', 'smd: 2', `title: Document ${i}`, 'status: draft', '---', '',
      `## Document ${i}`, '',
      `Part ${i} of the plan. It follows [the shared rule](${up(0)}#R-SHARED) and leads to [the next part](${up((i + 1) % count)}#document-${(i + 1) % count}).`, '',
      ...(i === 0 ? [':::requirement{#R-SHARED} Every part logs its changes', 'The log is kept for a year.', ':::', ''] : []),
      `:::requirement{#R-${i} depends-on=R-SHARED} Part ${i} answers within ${100 + i} ms`, `It applies to the endpoints of part ${i}.`, ':::', '',
      '## Work', '',
      `- [ ] Build part ${i} {#T-${i}}`, `- [x] Agree part ${i} with the owners`, '',
      '## Notes', '',
      `Notes on part ${i}. ${'Background text for the part. '.repeat(6)}`, '',
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n'));
    files.push(file);
  }
  return { root, files, first: files[0], remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Where `needle` first appears in `text`: zero-based line and UTF-16 column. */
export function positionOf(text: string, needle: string): { line: number; character: number } {
  const lines = text.split('\n');
  const line = lines.findIndex((l) => l.includes(needle));
  if (line < 0) throw new Error(`"${needle}" is not in the text`);
  return { line, character: lines[line].indexOf(needle) };
}

/** A language server for `root`, initialized, with requests answered in place. */
export class BenchClient {
  readonly server: SmdLanguageServer;
  private readonly sent: LspMessage[] = [];
  private id = 0;

  constructor(root: string) {
    this.server = new SmdLanguageServer({
      version: 'bench', send: (m) => this.sent.push(m), onExit: () => undefined, log: () => undefined, mermaid: null, validateDelay: 0, today: '2026-11-01',
    });
    this.request('initialize', { processId: null, rootUri: pathToFileURL(root).href, capabilities: {} });
    this.notify('initialized', {});
  }

  request(method: string, params?: unknown): unknown {
    const n = ++this.id;
    this.server.endpoint.receive({ jsonrpc: '2.0', id: n, method, params });
    const response = this.sent.find((m) => 'id' in m && m.id === n) as LspResponse | undefined;
    this.sent.length = 0; // diagnostics and other notifications are not kept
    if (!response) throw new Error(`${method} got no answer`);
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  }

  notify(method: string, params?: unknown): void {
    this.server.endpoint.receive({ jsonrpc: '2.0', method, params });
    this.sent.length = 0;
  }

  open(file: string, text: string): void {
    this.notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(file).href, languageId: 'smd', version: 1, text } });
  }

  change(file: string, text: string, version: number): void {
    this.notify('textDocument/didChange', { textDocument: { uri: pathToFileURL(file).href, version }, contentChanges: [{ text }] });
  }

  dispose(): void {
    this.server.dispose();
  }
}
