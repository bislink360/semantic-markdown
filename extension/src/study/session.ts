// Study 2 session logging, in a study build of the extension only. A release build defines __SMD_STUDY__ as false,
// so every call into this module is removed and the module itself is left out of the bundle (see build.mjs and
// test/studyLog.test.ts). In a study build it is still off until a session is turned on, by SMD_STUDY_LOG=<file>
// when VS Code starts or by the study status bar item. Nothing is contributed to package.json: the commands below
// are registered here and reached from the status bar item, never from the released command palette.
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BlockEditorSession, SessionMessage } from '../blockEditorSession';
import { blockTemplates, type Snippet } from '../core/templates';
import { cueCounts, EditBatch, studyBlockAt, studyCues, studyPageEvent, templateSlug } from './cues';
import { ActiveClock, createStudyLogger, STUDY_LOGGER_OFF, type StudyLogger } from './logger';
import { studyFixture, studyStatus, type StudyEventType } from './schema';

declare const __SMD_PKG_VERSION__: string | undefined;

/** The environment variable that turns a session on when VS Code starts: the log file's path. */
export const STUDY_LOG_ENV = 'SMD_STUDY_LOG';
const TOGGLE = 'smd._studyToggle';
const EDIT_PAUSE = 2000;
const DIAGNOSTICS_PAUSE = 1500;
const HEARTBEAT = 60_000;
const CODE = /^[A-Za-z][\w-]{0,40}$/;

export type StudyView = 'text' | 'preview' | 'block-editor' | 'agent' | 'agent-brief' | 'omissions' | 'other';

let logger: StudyLogger = STUDY_LOGGER_OFF;
let clock: ActiveClock | undefined;
let file = '';
let heartbeat: ReturnType<typeof setInterval> | undefined;
let status: vscode.StatusBarItem | undefined;
let lastView = '';
let lastFocus: boolean | undefined;
const rendered = /* @__PURE__ */ new Map<string, string>();
const edits = /* @__PURE__ */ new Map<string, { uri: vscode.Uri; batch: EditBatch; timer: ReturnType<typeof setTimeout> }>();
const validated = /* @__PURE__ */ new Map<string, { signature: string; timer?: ReturnType<typeof setTimeout> }>();

const now = () => Date.now();

/** True while a session is logging. */
export function studyLogging(): boolean {
  return logger.enabled;
}

/** The document fields of an event: the salted id and, for a study fixture, its file name. */
function documentFields(uri: vscode.Uri | undefined): Record<string, unknown> {
  if (!uri) return {};
  return { doc: logger.docId(uri.toString()), fixture: studyFixture(uri.path) };
}

/** Record an event about a document (or none). Does nothing while no session is logging. */
export function studyRecord(type: StudyEventType, fields: Record<string, unknown> = {}, uri?: vscode.Uri): void {
  if (!logger.enabled) return;
  clock?.touch(now());
  logger.log(type, { ...documentFields(uri), ...fields });
}

/** A view rendered a document: its cues, when they differ from what this view last showed. */
export function studyRendered(document: vscode.TextDocument, view: StudyView): void {
  if (!logger.enabled) return;
  const cues = studyCues(document.getText());
  const key = `${view}|${document.uri.toString()}`;
  const signature = JSON.stringify(cues);
  if (rendered.get(key) === signature) return;
  rendered.set(key, signature);
  studyRecord('cue.render', { view, count: cues.length, counts: cueCounts(cues), cues }, document.uri);
}

/** A message from the preview's study page script. True when it was one (logged or not). */
export function studyPageMessage(raw: unknown, uri: vscode.Uri, view: StudyView): boolean {
  const event = studyPageEvent(raw);
  if (!event) return false;
  studyRecord(event.type, { ...event.fields, view }, uri);
  return true;
}

/**
 * A Block Editor message in a study build: handle it, then log the review step, inserted template or status change
 * it asked for (kinds, lines and ids only) and whether it changed the document.
 */
export async function studyBlockEditorMessage(
  document: vscode.TextDocument,
  session: Pick<BlockEditorSession, 'handle' | 'lineOf'>,
  message: SessionMessage,
  snippets: Readonly<Record<string, Snippet>>,
): Promise<void> {
  if (!logger.enabled) return session.handle(message);
  const before = document.version;
  const key = 'key' in message && typeof message.key === 'string' ? message.key : undefined;
  const line = key === undefined ? undefined : session.lineOf(key);
  const block = line === undefined ? {} : studyBlockAt(document.getText(), line);
  await session.handle(message);
  const applied = document.version !== before;
  const view = 'block-editor';
  if (message.type === 'ready') studyRendered(document, view);
  else if (message.type === 'review') {
    studyRecord('review', { view, action: message.action, kind: block.kind, commentKind: block.commentKind, line, block: block.block, applied }, document.uri);
  } else if (message.type === 'insert') {
    // Only the extension's own template names: the page could send any string.
    const known = blockTemplates(snippets).some((t) => t.name === message.template);
    studyRecord('block.insert', { view, template: known ? templateSlug(message.template) : undefined, applied }, document.uri);
  } else if (message.type === 'setAttr' && message.name === 'status') {
    const status = typeof message.value === 'string' ? studyStatus(message.value) : undefined;
    studyRecord('status.set', { view, kind: block.kind, status, line, block: block.block, applied }, document.uri);
  }
}

/** Register the study session's status bar item, commands and listeners, and start a session if SMD_STUDY_LOG says so. */
export function registerStudy(context: vscode.ExtensionContext): void {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1000);
  status.command = TOGGLE;
  updateStatus();
  status.show();

  context.subscriptions.push(
    status,
    { dispose: () => stop('deactivate') },
    vscode.commands.registerCommand(TOGGLE, () => (logger.enabled ? confirmStop() : startFromCommand())),
    vscode.window.onDidChangeWindowState((state) => {
      if (!logger.enabled || state.focused === lastFocus) return;
      lastFocus = state.focused;
      clock?.setFocused(state.focused, now());
      logger.log('focus', { focused: state.focused, activeMs: clock?.activeMs(now()) });
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => logActiveTab()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => logActiveTab()),
    vscode.window.onDidChangeTextEditorSelection(() => clock?.touch(now())),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => clock?.touch(now())),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!logger.enabled || !isStudyDocument(e.document) || !e.contentChanges.length) return;
      recordEdits(e.document.uri, e.contentChanges);
    }),
    vscode.languages.onDidChangeDiagnostics((e) => {
      if (!logger.enabled) return;
      for (const uri of e.uris) if (/\.smd$/i.test(uri.path)) scheduleValidation(uri);
    }),
  );

  const fromEnv = process.env[STUDY_LOG_ENV];
  if (fromEnv) start(path.resolve(fromEnv), 'env');
}

/** Stop the session (VS Code is closing). */
export function stopStudy(): void {
  stop('deactivate');
}

function isStudyDocument(doc: vscode.TextDocument): boolean {
  return (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') && (doc.languageId === 'smd' || doc.languageId === 'markdown');
}

async function startFromCommand(): Promise<void> {
  const ok = await vscode.window.showInformationMessage(
    'Start a study session log?',
    {
      modal: true,
      detail: 'For a consented Study 2 session only. The log records events (views opened, cues shown and opened, review steps, '
        + 'edit line ranges, validator counts, active time) in a local file you choose. It records no document text, '
        + 'file paths or names, sends nothing anywhere, and stops when you stop it or close VS Code.',
    },
    'Start',
  );
  if (ok !== 'Start') return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `smd-study-${stamp}.jsonl`)),
    filters: { 'Study log (JSON lines)': ['jsonl'] },
    saveLabel: 'Log here',
  });
  if (target) start(target.fsPath, 'command');
}

async function confirmStop(): Promise<void> {
  const ok = await vscode.window.showInformationMessage('Stop the study session log?', { modal: true, detail: `The log stays in ${file}.` }, 'Stop');
  if (ok === 'Stop') stop('stopped');
}

function start(target: string, reason: 'env' | 'command'): void {
  if (logger.enabled) stop('restart');
  try {
    logger = createStudyLogger({ file: target });
  } catch (error) {
    vscode.window.showErrorMessage(`The study log could not be opened: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  file = target;
  lastFocus = vscode.window.state.focused;
  clock = new ActiveClock(lastFocus, now());
  logger.log('session.start', { reason, version: typeof __SMD_PKG_VERSION__ === 'string' ? __SMD_PKG_VERSION__ : undefined });
  heartbeat = setInterval(() => logger.log('heartbeat', { activeMs: clock?.activeMs(now()) }), HEARTBEAT);
  lastView = '';
  logActiveTab();
  updateStatus();
}

function stop(reason: 'stopped' | 'deactivate' | 'restart'): void {
  if (!logger.enabled) return;
  for (const key of [...edits.keys()]) flushEdits(key);
  for (const entry of validated.values()) clearTimeout(entry.timer);
  validated.clear();
  rendered.clear();
  clearInterval(heartbeat);
  heartbeat = undefined;
  logger.log('session.end', { reason, durationMs: logger.elapsed(), activeMs: clock?.activeMs(now()) });
  logger.close();
  logger = STUDY_LOGGER_OFF;
  clock = undefined;
  updateStatus();
}

function updateStatus(): void {
  if (!status) return;
  status.text = logger.enabled ? '$(record) Study log on' : '$(beaker) Study build';
  status.tooltip = logger.enabled
    ? `Study session logging to ${file}. No document text is recorded. Click to stop.`
    : 'Semantic Markdown study build (never released). Study logging is off. Click to start a consented session.';
}

/** Which view of which document the active tab shows. */
function activeTab(): { view: StudyView; uri?: vscode.Uri } {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) {
    if (input.uri.scheme === 'smd-agent') {
      return { view: input.uri.fragment === 'brief' ? 'agent-brief' : 'agent', uri: safeParse(input.uri.query) };
    }
    return { view: 'text', uri: /\.(?:smd|md)$/i.test(input.uri.path) ? input.uri : undefined };
  }
  if (input instanceof vscode.TabInputCustom && input.viewType === 'smd.blockEditor') return { view: 'block-editor', uri: input.uri };
  if (input instanceof vscode.TabInputWebview && input.viewType.endsWith('smd.preview')) {
    // The preview's tab is titled "Preview <file name>": the open document of that name, if there is exactly one.
    const name = vscode.window.tabGroups.activeTabGroup.activeTab?.label.replace(/^Preview /, '');
    const docs = vscode.workspace.textDocuments.filter((d) => path.basename(d.uri.fsPath) === name);
    return { view: 'preview', uri: docs.length === 1 ? docs[0].uri : undefined };
  }
  return { view: 'other' };
}

function safeParse(value: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(value, true);
  } catch {
    return undefined;
  }
}

function logActiveTab(): void {
  if (!logger.enabled) return;
  const { view, uri } = activeTab();
  const key = `${view}|${uri?.toString() ?? ''}`;
  if (key === lastView) return;
  lastView = key;
  studyRecord('view.active', { view }, uri);
}

function recordEdits(uri: vscode.Uri, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
  const key = uri.toString();
  const at = now();
  clock?.touch(at);
  let entry = edits.get(key);
  if (!entry) {
    entry = { uri, batch: new EditBatch(at), timer: setTimeout(() => flushEdits(key), EDIT_PAUSE) };
    edits.set(key, entry);
  }
  entry.batch.add(changes.map((c) => ({ startLine: c.range.start.line, endLine: c.range.end.line, rangeLength: c.rangeLength, textLength: c.text.length })), at);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flushEdits(key), EDIT_PAUSE);
}

function flushEdits(key: string): void {
  const entry = edits.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  edits.delete(key);
  if (logger.enabled) logger.log('edit', { ...documentFields(entry.uri), view: activeTab().view, ...entry.batch.fields() });
}

function scheduleValidation(uri: vscode.Uri): void {
  const key = uri.toString();
  const entry = validated.get(key) ?? { signature: '' };
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (!logger.enabled) return;
    const diagnostics = vscode.languages.getDiagnostics(uri);
    const count = (s: vscode.DiagnosticSeverity) => diagnostics.filter((d) => d.severity === s).length;
    const codes = [...new Set(diagnostics.map((d) => String(typeof d.code === 'object' ? d.code.value : d.code ?? '')).filter((c) => CODE.test(c)))].sort((a, b) => (a < b ? -1 : Number(a > b))).slice(0, 50);
    const fields = {
      errors: count(vscode.DiagnosticSeverity.Error),
      warnings: count(vscode.DiagnosticSeverity.Warning),
      infos: count(vscode.DiagnosticSeverity.Information) + count(vscode.DiagnosticSeverity.Hint),
      codes,
    };
    const signature = JSON.stringify(fields);
    if (signature === entry.signature) return;
    entry.signature = signature;
    logger.log('validate', { ...documentFields(uri), ...fields });
  }, DIAGNOSTICS_PAUSE);
  validated.set(key, entry);
}
