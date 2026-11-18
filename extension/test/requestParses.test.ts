import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseCounts, resetParseCache } from '../src/core/parse';
import { BenchClient, makeWorkspace, positionOf } from './bench/workspace';

/**
 * Find references and rename parse each document at most once per request (improvement roadmap t-20). Measured on the
 * shared 40-document workspace with unsaved text in the open document: today each request parses every document that
 * names the target exactly once, in the language server and in VS Code alike, so no request-local cache was added. A
 * repeated request parses them all again, since the parse cache keeps three documents: that is t-49's question.
 */

const DOCUMENTS = 40;

function workspace() {
  const ws = makeWorkspace(DOCUMENTS);
  // A heading whose GitHub id (request_options) differs from its own (requestoptions), linked by both, so a request
  // looks for each name.
  fs.appendFileSync(ws.first, '\n## request_options\n\nSee [opts](#requestoptions).\n');
  for (const f of ws.files.slice(1, 6)) fs.appendFileSync(f, '\n[o](../area-0/doc-0.smd#request_options)\n');
  const text = fs.readFileSync(ws.first, 'utf8').replace('## Work', 'An unsaved line.\n\n## Work');
  return { ws, text };
}

/** Parse cache misses during one request. */
function misses(run: () => unknown): number {
  for (const key of Object.keys(parseCounts) as Array<keyof typeof parseCounts>) parseCounts[key] = 0;
  run();
  return parseCounts.calls - parseCounts.cached;
}

const CASES: Array<[string, string, Record<string, unknown>, string]> = [
  ['references to a block id', 'textDocument/references', { context: { includeDeclaration: true } }, 'R-SHARED}'],
  ['rename of a block id', 'textDocument/rename', { newName: 'R-NEW' }, 'R-SHARED}'],
  ['references to a heading with a GitHub id', 'textDocument/references', { context: { includeDeclaration: true } }, '## request_options'],
  ['rename of a heading with a GitHub id', 'textDocument/rename', { newName: 'Request options' }, '## request_options'],
];

test('t-20: references and rename parse each document at most once per request, first and repeated', () => {
  const { ws, text } = workspace();
  try {
    const uri = pathToFileURL(ws.first).href;
    for (const [name, method, extra, needle] of CASES) {
      const client = new BenchClient(ws.root);
      try {
        client.open(ws.first, text);
        const at = positionOf(text, needle);
        const request = () => client.request(method, { textDocument: { uri }, position: { line: at.line, character: at.character + 3 }, ...extra });
        resetParseCache();
        const first = misses(request);
        const repeat = misses(request);
        assert.ok(first <= DOCUMENTS, `${name}: ${first} parses on the first request, for ${DOCUMENTS} documents`);
        assert.ok(repeat <= DOCUMENTS, `${name}: ${repeat} parses on a repeat, for ${DOCUMENTS} documents`);
      } finally {
        client.dispose();
      }
    }
  } finally {
    ws.remove();
  }
});
