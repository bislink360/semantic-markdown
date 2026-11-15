// Shared editor behavior fixtures (improvement roadmap t-04): the cases, where each puts the cursor, and one normal
// form for what the VS Code providers (src/language.ts) and the language server (src/lsp.ts) answer, so the two can be
// compared with the same expected results. Plain CommonJS: test/integration/suite.js loads it inside VS Code, and
// test/editorFixtures.test.ts loads it under tsx.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE = path.join(__dirname, 'workspace');
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8')).cases;
const EXPECTED_FILE = path.join(__dirname, 'expected.json');

/** The zero-based line and UTF-16 character a case's `at` names in `text`. */
function cursor(text, at) {
  const lines = text.split(/\r?\n/);
  if (at.line !== undefined) return { line: at.line, character: at.character === 'end' ? lines[at.line].length : at.character };
  const matches = lines.map((l, i) => [l, i]).filter(([l]) => l.includes(at.find));
  if (!matches.length) throw new Error(`"${at.find}" is not in the file`);
  const [text_, line] = at.last ? matches[matches.length - 1] : matches[0];
  return { line, character: text_.indexOf(at.find) + (at.offset ?? 0) };
}

/** Symbol kind names. LSP numbers them from 1 (File), VS Code's SymbolKind enum from 0. */
const SYMBOL_KINDS = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface',
  'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event',
  'Operator', 'TypeParameter'];

/** A file path as the expected results write it: relative to the workspace copy, with `/`; outside it, marked. */
function relativeTo(root, file) {
  const rel = path.relative(root, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? `outside:${path.basename(file)}` : rel.split(path.sep).join('/');
}

const span = (r) => `${r.start.line + 1}:${r.start.character}-${r.end.line === r.start.line ? '' : `${r.end.line + 1}:`}${r.end.character}`;
const sortUnique = (items) => [...new Set(items)].sort();

/** Hover text, every hover joined, or null. */
const hover = (markdowns) => (markdowns.length ? markdowns.join('\n\n---\n\n') : null);
/** Completion labels, sorted, without repeats. */
const completion = (labels) => sortUnique(labels);
/** The outline as indented lines: name, kind and the line it starts on. */
function outline(symbols, kindName, depth = 0) {
  return symbols.flatMap((s) => [`${'  '.repeat(depth)}${s.name} [${kindName(s.kind)}] ${s.range.start.line + 1}`, ...outline(s.children ?? [], kindName, depth + 1)]);
}

/** VS Code's answers, from the vscode.execute… commands, in the normal form. */
const fromVscode = {
  hover: (hovers) => hover((hovers ?? []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)))),
  // Items of the snippet kind are the extension's contributed snippets (snippets/smd.json): neither provider makes them.
  completion: (list, _root, snippetKind) => completion((list?.items ?? []).map((i) => {
    const label = typeof i.label === 'string' ? i.label : i.label.label;
    return i.kind === snippetKind ? `snippet: ${label}` : label;
  })),
  outline: (symbols) => outline(symbols ?? [], (k) => SYMBOL_KINDS[k]),
  references: (locations, root) => sortUnique((locations ?? []).map((l) => `${relativeTo(root, l.uri.fsPath)}:${span(l.range)}`)),
  rename: (edit, root) => sortUnique((edit ? edit.entries() : []).flatMap(([uri, edits]) => edits.map((e) => `${relativeTo(root, uri.fsPath)}:${span(e.range)} → ${e.newText}`))),
};

/** The language server's answers, as JSON-RPC results, in the normal form. `fileOf` turns a URI into a path. */
const fromLsp = {
  hover: (result) => hover(result ? [typeof result.contents === 'string' ? result.contents : result.contents.value] : []),
  completion: (result) => completion((Array.isArray(result) ? result : result?.items ?? []).map((i) => i.label)),
  outline: (symbols) => outline(symbols ?? [], (k) => SYMBOL_KINDS[k - 1]),
  references: (locations, root, fileOf) => sortUnique((locations ?? []).map((l) => `${relativeTo(root, fileOf(l.uri))}:${span(l.range)}`)),
  rename: (edit, root, fileOf) => {
    const changes = edit?.changes ? Object.entries(edit.changes)
      : (edit?.documentChanges ?? []).map((d) => [d.textDocument.uri, d.edits]);
    return sortUnique(changes.flatMap(([uri, edits]) => edits.map((e) => `${relativeTo(root, fileOf(uri))}:${span(e.range)} → ${e.newText}`)));
  },
};

/** The expected results, by case name: `{ both }`, or `{ vscode, lsp, difference }` where the adapters differ today. */
function expected() {
  return JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8')).cases;
}

/** What `adapter` ('vscode' or 'lsp') is expected to answer for a case. */
function expectedFor(name, adapter) {
  const e = expected()[name];
  if (!e) throw new Error(`expected.json has no entry for "${name}"`);
  return 'both' in e ? e.both : e[adapter];
}

/** Copies the workspace into a new folder under `parent`; returns its path. */
function copyWorkspace(parent) {
  const dir = fs.mkdtempSync(path.join(parent, 'zz-editor-'));
  fs.cpSync(WORKSPACE, dir, { recursive: true });
  return dir;
}

module.exports = { WORKSPACE, CASES, EXPECTED_FILE, cursor, fromVscode, fromLsp, expected, expectedFor, copyWorkspace, SYMBOL_KINDS };
