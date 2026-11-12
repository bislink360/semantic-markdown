import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkMermaid, formatSmd, parseSmd, renderPage, validateSmd, type Diagnostic, type ValidateOptions } from './core';
import { encodeAnchor, headingAt, linksToAnchor, renameHeading } from './core/anchors';
import { anchorNames, anchorOrAliasLine } from './core/headingAliases';
import {
  idDefinitionLines, idReferences, idUseAt, idUses as idUsesOf, namingUses, renameIdEdits, useTarget, type IdDocument, type IdTargetRef, type IdUse,
} from './core/idRefs';
import { isDocumentPath, linkAt, splitTarget } from './core/links';
import type { MermaidParse } from './core/mermaid';
import { documentSymbols, fuzzyMatch, type SmdSymbol } from './core/symbols';
import { loadRuleConfig } from './config';
import { loadMermaidParser } from './mermaidLoader';
import { completionsAt, hoverAt, type AssistEnv, type FolderEntry } from './lspAssist';
import { chooseEncoding, TextDocument, TextDocuments, type Position, type PositionEncoding, type Range } from './lspDocuments';
import { frame, isObject, LspEndpoint, LspError, LSP_ERRORS, serveStream, type LspMessage } from './lspProtocol';
import { collect, readerFor } from './workspace';

/**
 * `smd lsp` (also `smd-language-server`): the editor features of the VS Code extension as a Language
 * Server, for Neovim, Helix, Zed and other LSP clients. Validation, quick fixes, outline, workspace
 * symbols, hover, completion, go to definition, find references, rename and formatting, from the same core as the
 * extension and the CLI. Rule settings come from the nearest smd.config.json / .smdrc, like `smd validate`.
 */

export interface LanguageServerOptions {
  version: string;
  /** Sends one message to the client. */
  send: (message: LspMessage) => void;
  /** Called on `exit` with the process exit code. */
  onExit: (code: number) => void;
  /** Where to log (default: stderr via console.error). */
  log?: (message: string) => void;
  /** Mermaid's parser for diagram syntax errors (default: the one shipped next to the CLI, if any). Null skips them. */
  mermaid?: MermaidParse | null;
  /** Milliseconds to wait after a change before validating (default 200). 0 validates at once. */
  validateDelay?: number;
  /** "Today" as YYYY-MM-DD for overdue and stale checks (default: the current date). */
  today?: string;
}

/** LSP SymbolKind values for headings, decisions, risks and API endpoints. */
const SYMBOL_KIND: Record<SmdSymbol['kind'], number> = {
  heading: 15, decision: 24, risk: 14, api: 6, requirement: 11, constraint: 20, acceptance: 17, assumption: 13, evidence: 19,
  'non-goals': 21, limitation: 22, deprecated: 26,
};
const SEVERITY: Record<Diagnostic['severity'], number> = { error: 1, warning: 2, info: 3, hint: 4 };
const TEXT_DOCUMENT_SYNC_FULL = 1;
const TRIGGER_CHARACTERS = [':', '{', '=', '`', '(', '/', '#', '"', '^'];

interface TextDocumentParams { textDocument: { uri: string }; position: Position }

/** A document of the workspace for find references and rename: its URI and text, by its key (see pathKey). */
interface WorkspaceText { uri: string; text: string }
/** What the cursor names for find references and rename: a block id (semantic tags R18) or a heading. */
type RenameTarget =
  | { kind: 'id'; target: IdTargetRef; use: IdUse; self: string }
  | { kind: 'heading'; target: IdTargetRef; line: number; start: number; end: number; text: string };
interface Validation { version: number; diagnostics: Diagnostic[] }

export class SmdLanguageServer {
  readonly endpoint: LspEndpoint;
  private encoding: PositionEncoding = 'utf-16';
  private readonly documents = new TextDocuments(() => this.encoding);
  private roots: string[] = [];
  /** The latest core diagnostics per open document, for quick fixes. */
  private readonly validations = new Map<string, Validation>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly symbolCache = new Map<string, { mtime: number; symbols: SmdSymbol[] }>();
  private readonly reportedConfigs = new Set<string>();
  private readonly log: (message: string) => void;
  private readonly mermaid: MermaidParse | undefined;

  constructor(private readonly options: LanguageServerOptions) {
    this.log = options.log ?? ((m) => console.error(m));
    this.mermaid = options.mermaid === undefined ? loadMermaidParser() : options.mermaid ?? undefined;
    const handle = <P>(fn: (params: P) => unknown) => (params: unknown) => fn.call(this, params as P);
    this.endpoint = new LspEndpoint({
      send: options.send,
      onExit: (code) => { this.dispose(); options.onExit(code); },
      log: this.log,
      requests: {
        initialize: handle(this.initialize),
        'textDocument/codeAction': handle(this.codeActions),
        'textDocument/documentSymbol': handle(this.documentSymbols),
        'workspace/symbol': handle(this.workspaceSymbols),
        'textDocument/hover': handle(this.hover),
        'textDocument/completion': handle(this.completion),
        'textDocument/definition': handle(this.definition),
        'textDocument/references': handle(this.references),
        'textDocument/prepareRename': handle(this.prepareRename),
        'textDocument/rename': handle(this.rename),
        'textDocument/formatting': handle(this.formatting),
        'smd/renderHtml': handle(this.renderHtml),
      },
      notifications: {
        'textDocument/didOpen': handle(this.didOpen),
        'textDocument/didChange': handle(this.didChange),
        'textDocument/didClose': handle(this.didClose),
      },
    });
  }

  /** Stops pending validations. */
  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }

  private initialize(params: unknown) {
    const p = isObject(params) ? params : {};
    const general = isObject(p.capabilities) && isObject(p.capabilities.general) ? p.capabilities.general : {};
    this.encoding = chooseEncoding(general.positionEncodings);
    this.roots = workspaceRoots(p);
    // A rename range and placeholder (prepareRename) only for clients that ask for them.
    const textDocument = isObject(p.capabilities) && isObject(p.capabilities.textDocument) ? p.capabilities.textDocument : {};
    const prepareRename = isObject(textDocument.rename) && textDocument.rename.prepareSupport === true;
    return {
      capabilities: {
        positionEncoding: this.encoding,
        textDocumentSync: { openClose: true, change: TEXT_DOCUMENT_SYNC_FULL },
        codeActionProvider: { codeActionKinds: ['quickfix'] },
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        hoverProvider: true,
        completionProvider: { triggerCharacters: TRIGGER_CHARACTERS },
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: prepareRename ? { prepareProvider: true } : true,
        documentFormattingProvider: true,
        // Not part of LSP: the `smd/renderHtml` request (see renderHtml), for clients with a preview.
        experimental: { smdRenderHtml: true },
      },
      serverInfo: { name: 'smd-language-server', version: this.options.version },
    };
  }

  private didOpen(params: { textDocument: { uri: string; version: number; text: string } }): void {
    const { uri, version, text } = params.textDocument;
    this.validate(this.documents.set(uri, version, text));
  }

  private didChange(params: { textDocument: { uri: string; version: number }; contentChanges: Array<{ text: string }> }): void {
    const change = params.contentChanges[params.contentChanges.length - 1];
    if (!change) return;
    const { uri, version } = params.textDocument;
    const document = this.documents.set(uri, version, change.text);
    const delay = this.options.validateDelay ?? 200;
    if (delay > 0) {
      clearTimeout(this.timers.get(uri));
      this.timers.set(uri, setTimeout(() => this.validate(document), delay));
    } else {
      this.validate(document);
    }
  }

  private didClose(params: { textDocument: { uri: string } }): void {
    const { uri } = params.textDocument;
    clearTimeout(this.timers.get(uri));
    this.timers.delete(uri);
    this.documents.delete(uri);
    this.validations.delete(uri);
    this.endpoint.notify('textDocument/publishDiagnostics', { uri, diagnostics: [] });
  }

  /** Publishes problems at once; Mermaid syntax errors follow when parsing finishes, unless the document changed. */
  private validate(document: TextDocument): void {
    clearTimeout(this.timers.get(document.uri));
    this.timers.delete(document.uri);
    const file = filePath(document.uri);
    const options = this.validateOptions(file);
    const found = validateSmd(document.text, options);
    this.publish(document, found);
    if (!this.mermaid || !/^\s{0,3}(```|~~~)\s*mermaid/im.test(document.text)) return;
    checkMermaid(document.text, this.mermaid, options.rules).then((diagrams) => {
      if (diagrams.length && this.documents.get(document.uri) === document) this.publish(document, [...found, ...diagrams]);
    }).catch((e: Error) => this.log(`[smd lsp] Mermaid check failed: ${e.stack ?? e}`));
  }

  private validateOptions(file: string | undefined): ValidateOptions {
    if (!file) return { today: this.options.today };
    const dir = path.dirname(file);
    const config = loadRuleConfig(file);
    const problems = config.file && config.problems.length ? `${config.file}: ${config.problems.join('; ')}` : '';
    if (problems && !this.reportedConfigs.has(problems)) {
      this.reportedConfigs.add(problems);
      this.log(`[smd lsp] config problems in ${problems}`);
    }
    return { fileExists: (rel) => fs.existsSync(path.resolve(dir, rel)), readFile: this.reader(file), rules: config.rules, today: this.options.today };
  }

  private publish(document: TextDocument, diagnostics: Diagnostic[]): void {
    this.validations.set(document.uri, { version: document.version, diagnostics });
    this.endpoint.notify('textDocument/publishDiagnostics', {
      uri: document.uri, version: document.version, diagnostics: diagnostics.map((d) => toLspDiagnostic(document, d)),
    });
  }

  /** The diagnostics of the document's current text, validating now if a validation is pending. */
  private currentDiagnostics(document: TextDocument): Diagnostic[] {
    const validation = this.validations.get(document.uri);
    if (validation?.version === document.version && !this.timers.has(document.uri)) return validation.diagnostics;
    this.validate(document);
    return this.validations.get(document.uri)?.diagnostics ?? [];
  }

  private codeActions(params: { textDocument: { uri: string }; range: Range; context?: { only?: string[] } }) {
    const document = this.documents.get(params.textDocument.uri);
    const only = params.context?.only;
    if (!document || (only && !only.some((kind) => kind === 'quickfix' || kind === ''))) return [];
    const from = params.range.start.line;
    const to = params.range.end.line;
    return this.currentDiagnostics(document).filter((d) => d.fix && d.line >= from && d.line <= to).map((d) => {
      const fix = d.fix!;
      const edit = { range: document.range(fix.line, fix.column, fix.endColumn), newText: fix.replacement };
      return {
        title: fix.title, kind: 'quickfix', diagnostics: [toLspDiagnostic(document, d)], isPreferred: true,
        edit: { changes: { [document.uri]: [edit] } },
      };
    });
  }

  private documentSymbols(params: { textDocument: { uri: string } }) {
    const document = this.documents.get(params.textDocument.uri);
    return document ? outlineSymbols(document) : null;
  }

  private workspaceSymbols(params: { query?: string }) {
    const query = params.query ?? '';
    const found: unknown[] = [];
    for (const { uri, symbols } of this.workspaceIndex()) {
      for (const s of symbols) {
        if (query && !fuzzyMatch(query, s.name)) continue;
        const at = { line: s.line, character: 0 };
        const containerName = [s.kind === 'heading' ? '' : s.kind, s.detail].filter(Boolean).join(' · ');
        found.push({ name: s.name, kind: SYMBOL_KIND[s.kind], location: { uri, range: { start: at, end: at } }, containerName });
      }
    }
    return found;
  }

  /** Symbols of every .smd file in the workspace folders, and of open documents (with their unsaved text). */
  private workspaceIndex(): Array<{ uri: string; symbols: SmdSymbol[] }> {
    const index = new Map<string, { uri: string; symbols: () => SmdSymbol[] }>();
    for (const found of this.roots.flatMap((root) => collect(root))) {
      const file = path.resolve(found);
      index.set(pathKey(file), { uri: pathToFileURL(file).href, symbols: () => this.fileSymbols(file) });
    }
    for (const document of this.documents.all()) {
      const file = filePath(document.uri);
      index.set(file ? pathKey(file) : document.uri, { uri: document.uri, symbols: () => documentSymbols(document.text) });
    }
    return [...index.values()].map((entry) => ({ uri: entry.uri, symbols: entry.symbols() }));
  }

  /** Symbols of a file on disk, cached by modification time. */
  private fileSymbols(file: string): SmdSymbol[] {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const cached = this.symbolCache.get(file);
      if (cached?.mtime === mtime) return cached.symbols;
      const symbols = documentSymbols(fs.readFileSync(file, 'utf8'));
      this.symbolCache.set(file, { mtime, symbols });
      return symbols;
    } catch {
      return [];
    }
  }

  private hover(params: TextDocumentParams) {
    const document = this.documents.get(params.textDocument.uri);
    if (!document) return null;
    const { line, column } = document.locate(params.position);
    const hover = hoverAt(document.text, line, column, this.assistEnv(document));
    if (!hover) return null;
    const range = hover.start === undefined ? {} : { range: document.range(line, hover.start, hover.end ?? hover.start) };
    return { contents: { kind: 'markdown', value: hover.markdown }, ...range };
  }

  private completion(params: TextDocumentParams) {
    const document = this.documents.get(params.textDocument.uri);
    if (!document) return null;
    const { line, column } = document.locate(params.position);
    const found = completionsAt(document.text, line, column, { ...this.assistEnv(document), today: this.options.today });
    if (!found) return null;
    const range = document.range(line, found.from, column);
    const items = found.items.map(({ insertText, ...item }) => ({ ...item, textEdit: { range, newText: insertText ?? item.label } }));
    return { isIncomplete: false, items };
  }

  private definition(params: TextDocumentParams) {
    const document = this.documents.get(params.textDocument.uri);
    if (!document) return null;
    const { line, column } = document.locate(params.position);
    const hit = linkAt(document.text, line, column);
    if (!hit) return this.idDefinition(document, line, column);
    // A reference `[text][label]` jumps to its `[label]: …` definition.
    if (hit.reference) return location(document.uri, hit.link.line);
    const parts = splitTarget(hit.link.target);
    if (!parts) return null;
    if (!parts.path) {
      const target = parts.anchor ? anchorOrAliasLine(document.text, parts.anchor) : undefined;
      return target === undefined ? null : location(document.uri, target);
    }
    return this.fileDefinition(document, parts.path, parts.anchor);
  }

  /** A link to another file: its start, or the line of `#anchor` in a linked document. */
  private fileDefinition(document: TextDocument, linkPath: string, anchor: string | undefined) {
    const file = filePath(document.uri);
    if (!file) return null;
    const target = path.resolve(path.dirname(file), linkPath);
    if (!fs.existsSync(target)) return null;
    const uri = this.uriOf(target);
    if (!anchor || !isDocumentPath(linkPath)) return location(uri, 0);
    const text = this.readText(target);
    return location(uri, (text === undefined ? undefined : anchorOrAliasLine(text, anchor)) ?? 0);
  }

  /** An id in an id attribute, `:ref` or `:depends` (semantic tags R18): the block that gives it, here or in another document. */
  private idDefinition(document: TextDocument, line: number, column: number) {
    const use = idUseAt(document.text, line, column);
    if (!use || use.kind === 'definition') return null;
    let uri = document.uri;
    let text: string | undefined = document.text;
    if (use.path) {
      const file = filePath(document.uri);
      if (!file) return null;
      const target = path.resolve(path.dirname(file), use.path);
      text = this.readText(target);
      uri = this.uriOf(target);
    }
    const lines = text === undefined ? [] : idDefinitionLines(text, use.id);
    if (!lines.length) return null;
    return lines.length === 1 ? location(uri, lines[0]) : lines.map((l) => location(uri, l));
  }

  // Find references and rename: block ids and headings, across the workspace

  private references(params: TextDocumentParams & { context?: { includeDeclaration?: boolean } }) {
    const document = this.documents.get(params.textDocument.uri);
    if (!document) return null;
    const { line, column } = document.locate(params.position);
    const docs = this.workspaceTexts(document);
    const found = this.renameTarget(document, line, column, docs);
    if (!found) return null;
    const declaration = params.context?.includeDeclaration !== false;
    const target = docs.get(found.target.key);
    const locations: Array<{ uri: string; range: Range }> = [];
    if (found.kind === 'heading' && declaration) {
      locations.push({ uri: document.uri, range: document.range(line, found.start, found.end) });
    }
    // Links to a heading by its GitHub id (`#foo_bar` for `#foobar`) are references too.
    const names = target ? anchorNames(target.text, found.target.id) : [found.target.id];
    for (const id of names) {
      for (const { key, use } of idReferences(this.idDocuments(docs), { key: found.target.key, id }, this.resolver(docs), declaration && found.kind === 'id')) {
        const doc = docs.get(key);
        if (doc) locations.push({ uri: doc.uri, range: this.textDocument(doc).range(use.line, use.column, use.endColumn) });
      }
    }
    return locations;
  }

  private prepareRename(params: TextDocumentParams) {
    const document = this.documents.get(params.textDocument.uri);
    if (!document) return null;
    const { line, column } = document.locate(params.position);
    const docs = this.workspaceTexts(document);
    const found = this.renameTarget(document, line, column, docs);
    if (!found) return null;
    if (found.kind === 'heading') return { range: document.range(line, found.start, found.end), placeholder: found.text };
    // Refused up front (a heading's id from its text, an id two blocks give, an unknown id), with the reason.
    const check = renameIdEdits(this.idDocuments(docs), found.target, found.use.id, this.resolver(docs), { key: found.self, line, column });
    if ('error' in check) throw new LspError(LSP_ERRORS.requestFailed, check.error);
    return { range: document.range(found.use.line, found.use.column, found.use.endColumn), placeholder: found.use.id };
  }

  private rename(params: TextDocumentParams & { newName: string }) {
    const document = this.documents.get(params.textDocument.uri);
    if (!document || typeof params.newName !== 'string') return null;
    const { line, column } = document.locate(params.position);
    const docs = this.workspaceTexts(document);
    const found = this.renameTarget(document, line, column, docs);
    if (!found) throw new LspError(LSP_ERRORS.requestFailed, 'Rename a heading, or a block id ({#R1}, verifies=R1, :ref[R1]), to update every reference to it.');
    const changes = new Map<string, Array<{ range: Range; newText: string }>>();
    const add = (key: string, l: number, start: number, end: number, newText: string) => {
      const doc = docs.get(key);
      if (!doc) return;
      changes.set(doc.uri, [...(changes.get(doc.uri) ?? []), { range: this.textDocument(doc).range(l, start, end), newText }]);
    };
    if (found.kind === 'heading') {
      this.renameHeadingEdits(document, found, params.newName, docs, add);
    } else {
      const result = renameIdEdits(this.idDocuments(docs), found.target, params.newName.trim(), this.resolver(docs), { key: found.self, line, column });
      if ('error' in result) throw new LspError(LSP_ERRORS.requestFailed, result.error);
      for (const e of result.edits) add(e.key, e.line, e.column, e.endColumn, e.newText);
    }
    return { changes: Object.fromEntries(changes) };
  }

  /** Renaming a heading: its text, then every link, id attribute, `:ref` and `:depends` that names an anchor it changes. */
  private renameHeadingEdits(
    document: TextDocument, heading: Extract<RenameTarget, { kind: 'heading' }>, newText: string, docs: Map<string, WorkspaceText>,
    add: (key: string, line: number, start: number, end: number, newText: string) => void,
  ): void {
    const { line } = heading;
    const renamed = renameHeading(document.text, line, newText);
    if (!renamed) return;
    const self = heading.target.key;
    add(self, line, heading.start, heading.end, renamed.lineText.slice(heading.start, renamed.lineText.length - (document.lines[line].length - heading.end)));
    const resolve = this.resolver(docs);
    for (const [key, doc] of docs) {
      const pointsAt = (p: string) => resolve(key, p) === self;
      // A link or `:ref` inside the renamed heading text is replaced along with it.
      const inHeading = (l: number, column: number) => key === self && l === line && column >= heading.start && column < heading.end;
      for (const { from, to } of renamed.changes) {
        for (const l of linksToAnchor(doc.text, from, pointsAt)) {
          if (!inHeading(l.line, l.column)) add(key, l.line, l.column, l.endColumn, encodeAnchor(l.raw, to));
        }
        for (const u of namingUses(doc.text, from, pointsAt)) if (!inHeading(u.line, u.column)) add(key, u.line, u.column, u.endColumn, to);
      }
    }
  }

  /** The block id under the cursor (in an id attribute, `:ref`, `:depends`, a link or its `{#id}`), else the heading on the line. */
  private renameTarget(document: TextDocument, line: number, column: number, docs: Map<string, WorkspaceText>): RenameTarget | undefined {
    const self = this.keyOf(document);
    const use = idUseAt(document.text, line, column);
    if (use) {
      const target = useTarget(self, use, this.resolver(docs));
      return target ? { kind: 'id', target, use, self } : undefined;
    }
    const heading = headingAt(document.text, line);
    if (!heading) return undefined;
    return { kind: 'heading', target: { key: self, id: heading.slug }, line, start: heading.start, end: heading.end, text: heading.text };
  }

  /** The .smd files under the workspace folders and the open documents (with their unsaved text), by key. */
  private workspaceTexts(current: TextDocument): Map<string, WorkspaceText> {
    const docs = new Map<string, WorkspaceText>();
    for (const found of this.roots.flatMap((root) => collect(root))) {
      const file = path.resolve(found);
      const text = this.readText(file);
      if (text !== undefined) docs.set(pathKey(file), { uri: this.uriOf(file), text });
    }
    for (const document of [...this.documents.all(), current]) docs.set(this.keyOf(document), { uri: document.uri, text: document.text });
    // A document the current one names outside the workspace folders.
    const file = filePath(current.uri);
    if (file) {
      for (const use of namedPaths(current.text)) {
        const other = path.resolve(path.dirname(file), use);
        if (docs.has(pathKey(other))) continue;
        const text = this.readText(other);
        if (text !== undefined) docs.set(pathKey(other), { uri: this.uriOf(other), text });
      }
    }
    return docs;
  }

  private idDocuments(docs: Map<string, WorkspaceText>): IdDocument[] {
    return [...docs].map(([key, doc]) => ({ key, text: doc.text }));
  }

  /** Paths written in a document, resolved to document keys; `''` is the document itself. */
  private resolver(docs: Map<string, WorkspaceText>) {
    return (from: string, rel: string): string | undefined => {
      if (!rel) return from;
      const uri = docs.get(from)?.uri;
      const file = uri ? filePath(uri) : undefined;
      return file ? pathKey(path.resolve(path.dirname(file), rel)) : undefined;
    };
  }

  private keyOf(document: TextDocument): string {
    const file = filePath(document.uri);
    return file ? pathKey(file) : document.uri;
  }

  /** The open document for a workspace text, or one made for converting its positions. */
  private textDocument(doc: WorkspaceText): TextDocument {
    return this.documents.get(doc.uri) ?? new TextDocument(doc.uri, 0, doc.text, this.encoding);
  }

  private formatting(params: { textDocument: { uri: string } }) {
    const document = this.documents.get(params.textDocument.uri);
    return document ? formattingEdits(document, formatSmd(document.text)) : null;
  }

  /**
   * `smd/renderHtml` (not part of LSP; the server announces it as `experimental.smdRenderHtml`): the document as the
   * standalone page `smd export --to html` writes, for a client's preview. `text` renders the client's current text
   * (unsaved edits too), so the page never lags behind a `didChange` still on its way; without it, the open document's.
   * Includes and code embeds resolve from the document's folder. `theme` (`light` or `dark`) is the page's theme when
   * the front matter names none, e.g. the editor's.
   */
  private renderHtml(params: { textDocument?: { uri?: unknown }; text?: unknown; theme?: unknown }) {
    const uri = isObject(params) && isObject(params.textDocument) && typeof params.textDocument.uri === 'string' ? params.textDocument.uri : undefined;
    if (!uri) throw new LspError(LSP_ERRORS.invalidParams, 'smd/renderHtml needs textDocument.uri');
    const text = typeof params.text === 'string' ? params.text : this.documents.get(uri)?.text;
    if (text === undefined) throw new LspError(LSP_ERRORS.invalidParams, `smd/renderHtml: ${uri} is not open and no text was sent`);
    const file = filePath(uri);
    const theme = params.theme === 'light' || params.theme === 'dark' ? params.theme : 'auto';
    return { html: renderPage(text, { readFile: file ? this.reader(file) : undefined, ...(file ? { file } : {}), today: this.options.today, reviewBlocks: 'shown' }, theme) };
  }

  private assistEnv(document: TextDocument): AssistEnv {
    const file = filePath(document.uri);
    if (!file) return {};
    const dir = path.dirname(file);
    return {
      readDocument: (rel) => this.readText(path.resolve(dir, rel)),
      listFolder: (rel) => listFolder(path.resolve(dir, rel), file),
      readFile: this.reader(file),
    };
  }

  /** Reader for code embeds: files in the document's folder or a workspace folder only. */
  private reader(file: string): (rel: string) => string | undefined {
    return readerFor(file, [path.dirname(file), ...this.roots]);
  }

  /** An open document's (possibly unsaved) text, or the file on disk. */
  private readText(file: string): string | undefined {
    const open = this.openDocument(file);
    if (open) return open.text;
    try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  }

  /** The URI the client uses for a file, if it is open, else a file: URI. */
  private uriOf(file: string): string {
    return this.openDocument(file)?.uri ?? pathToFileURL(file).href;
  }

  private openDocument(file: string): TextDocument | undefined {
    return this.documents.all().find((d) => samePath(filePath(d.uri), file));
  }
}

/** The paths of other documents an id use in `text` names. */
function namedPaths(text: string): string[] {
  return [...new Set(idUsesOf(text).filter((u) => u.path).map((u) => u.path))];
}

function toLspDiagnostic(document: TextDocument, d: Diagnostic) {
  return { range: document.range(d.line, d.column, d.endColumn), severity: SEVERITY[d.severity], code: d.code, source: 'smd', message: d.message };
}

function location(uri: string, line: number) {
  const at = { line, character: 0 };
  return { uri, range: { start: at, end: at } };
}

/** The local path of a file: URI, or undefined for other schemes. */
export function filePath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined;
  try { return path.resolve(fileURLToPath(uri)); } catch { return undefined; }
}

/** A path for comparisons: resolved, and lower case on Windows. */
function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && pathKey(a) === pathKey(b);
}

/** Workspace folders from initialize: workspaceFolders, else rootUri, else rootPath. */
function workspaceRoots(params: Record<string, unknown>): string[] {
  const folders = Array.isArray(params.workspaceFolders) ? params.workspaceFolders : [];
  const uris = folders.map((f) => (isObject(f) && typeof f.uri === 'string' ? f.uri : '')).filter(Boolean);
  if (!uris.length && typeof params.rootUri === 'string') uris.push(params.rootUri);
  const roots = uris.map(filePath).filter((p): p is string => p !== undefined);
  if (!roots.length && typeof params.rootPath === 'string') roots.push(path.resolve(params.rootPath));
  return roots.filter((root) => fs.existsSync(root));
}

function listFolder(folder: string, self: string): FolderEntry[] {
  try {
    return fs.readdirSync(folder, { withFileTypes: true })
      .filter((entry) => !samePath(path.join(folder, entry.name), self))
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  } catch {
    return [];
  }
}

/** Headings as a tree (each spans its section), with decisions, risks and APIs inside their section. */
export function outlineSymbols(document: TextDocument) {
  const headings = parseSmd(document.text).headings;
  const lastLine = document.lines.length - 1;
  interface Node { level: number; line: number; symbol: Record<string, unknown> & { children: unknown[] } }
  const nodes: Node[] = headings.map((h, i) => {
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    const range = document.lineRange(h.line, Math.max(h.line, (next ? next.line : lastLine + 1) - 1));
    const selectionRange = document.lineRange(h.line, h.line);
    return { level: h.level, line: h.line, symbol: { name: h.text || '(untitled)', detail: `H${h.level}`, kind: SYMBOL_KIND.heading, range, selectionRange, children: [] } };
  });
  for (const s of documentSymbols(document.text)) {
    if (s.kind === 'heading') continue;
    const range = document.lineRange(s.line, s.line);
    // Level 7: below every heading, so blocks never contain anything.
    nodes.push({ level: 7, line: s.line, symbol: { name: s.name, detail: s.detail, kind: SYMBOL_KIND[s.kind], range, selectionRange: range, children: [] } });
  }
  nodes.sort((a, b) => a.line - b.line || a.level - b.level);
  const roots: unknown[] = [];
  const stack: Node[] = [];
  for (const node of nodes) {
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    (stack.length ? stack[stack.length - 1].symbol.children : roots).push(node.symbol);
    if (node.level < 7) stack.push(node);
  }
  return roots;
}

/**
 * Edits that turn the document into `formatted`: one replacement of the changed lines, so the cursor
 * and folds elsewhere stay put.
 */
export function formattingEdits(document: TextDocument, formatted: string): Array<{ range: Range; newText: string }> {
  if (formatted === document.text) return [];
  const before = document.lines;
  const after = formatted.split(/\r?\n/);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const eol = document.eol;
  if (end > 0) {
    // Whole lines, up to the first unchanged line.
    const range = { start: { line: start, character: 0 }, end: { line: before.length - end, character: 0 } };
    return [{ range, newText: after.slice(start, after.length - end).map((l) => l + eol).join('') }];
  }
  // The change reaches the end of the document.
  const from = Math.min(start, before.length - 1);
  return [{ range: document.lineRange(from, before.length - 1), newText: after.slice(from).join(eol) }];
}

/** Serves the language server over stdio. Resolves with the exit code once the client asks it to exit or closes stdin. */
export function runLanguageServer(settings: { version: string }): Promise<number> {
  // Anything else that logs (e.g. Mermaid) must not corrupt the protocol stream.
  console.log = console.info = console.debug = console.warn = console.error;
  const log = (message: string) => console.error(message);
  return new Promise((resolve) => {
    const finish = (code: number) => {
      server.dispose();
      process.stdin.destroy();
      resolve(code);
    };
    const server = new SmdLanguageServer({ version: settings.version, send: (m) => process.stdout.write(frame(m)), onExit: finish, log });
    log(`[smd lsp] smd-language-server ${settings.version} over stdio`);
    void serveStream(server.endpoint, process.stdin, log).then(() => finish(server.endpoint.shutDown ? 0 : 1));
  });
}
