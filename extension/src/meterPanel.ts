import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { declaredSectionEdges, meterReport, parseSmd, sectionGraph, sectionGraphMermaid } from './core';
import { clearEvents, folderBytes, setMeterConfig } from './meter/log';
import { newSessionId } from './meter/record';
import { recordEditorCopy } from './meterCommand';
import { meterPanelBody, METER_PANEL_CSS, METER_TABS, type MeterPanelModel, type MeterPeriod, type MeterTab } from './meterPanelHtml';
import { MeterStore, MeterStores } from './meterStore';
import type { MeasuredUse } from './tokenMeter';
import { webviewCsp, webviewNonce } from './webviewShell';

/**
 * The token meter in VS Code: one log store per workspace, the meter panel, heading hints and the commands that turn
 * metering on or off and clear it. The status bar card (agentViewUi.ts) asks `measuredFor` what the log says about
 * the active file.
 */

export interface TokenMeterUi {
  stores: MeterStores;
  /** Whether metering is on for the document's workspace; undefined for a file outside every workspace folder. */
  enabledFor(uri: vscode.Uri): boolean | undefined;
  /** The document's measured use over the last 7 days, when metering is on. */
  measuredFor(uri: vscode.Uri): MeasuredUse | undefined;
  /** Record a person's copy of a view for an agent (no-op while metering is off). */
  recordCopy(uri: vscode.Uri, text: string): void;
  /** Fires when any store's events or settings change. */
  onDidChange: vscode.Event<unknown>;
}

const DAY = 86_400_000;
const sinceFor = (period: MeterPeriod) => (period === 'all' ? undefined : new Date(Date.now() - Number(period) * DAY).toISOString());

const HOW_COUNTED = 'Session net savings: for each agent session and file, the raw file (plus the files its view included) '
  + 'counts once, against every token smd sent for that file in the session. An agent that read the raw file would keep it in '
  + 'context, so this is the fair comparison; it can be negative when an agent reads many sections. Per-read savings count the '
  + 'whole file on every read and overstate. Counts are ≈4 characters per token unless .smdrc sets "meter": {"tokenizer": "o200k_base"} '
  + 'and js-tiktoken is installed. Raw reads are measured only where an agent reports them through a hook. Nothing leaves this machine.';

export function registerTokenMeter(context: vscode.ExtensionContext): TokenMeterUi {
  const stores = new MeterStores();
  const editorSession = newSessionId('editor');
  context.subscriptions.push(stores);

  const ui: TokenMeterUi = {
    stores,
    onDidChange: stores.onDidChange,
    enabledFor: (uri) => stores.forUri(uri)?.settings.enabled,
    measuredFor: (uri) => {
      const store = stores.forUri(uri);
      const rel = store?.relative(uri.fsPath);
      if (!store?.settings.enabled || !rel) return undefined;
      return { period: 'last 7 days', report: meterReport(store.all, { since: sinceFor('7'), paths: [rel] }) };
    },
    recordCopy: (uri, text) => {
      const store = stores.forUri(uri);
      if (store?.settings.enabled) recordEditorCopy(store.root, uri.fsPath, text, editorSession, false);
    },
  };

  const storeForCommand = (): MeterStore | undefined => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const store = (uri && stores.forUri(uri)) ?? stores.first();
    if (!store) vscode.window.showInformationMessage('Open a folder first: the token meter keeps its log per workspace.');
    return store;
  };

  const turnOn = async (store = storeForCommand()) => {
    if (!store) return false;
    const choice = await vscode.window.showInformationMessage(
      'Turn on token metering for this workspace?',
      {
        modal: true,
        detail: 'smd will record which .smd files and sections agents read and how many tokens they received, in .smd/meter/ in '
          + 'this folder. Nothing leaves your machine. No document text is stored. The folder is ignored by Git. It writes "meter": true '
          + 'to .smdrc so agents outside VS Code record too. You can turn it off or clear it at any time.',
      },
      'Turn on',
    );
    if (choice !== 'Turn on') return false;
    try {
      setMeterConfig(store.root, true);
    } catch (e) {
      vscode.window.showErrorMessage(`Could not turn on token metering: ${(e as Error).message}`);
      return false;
    }
    vscode.window.setStatusBarMessage('$(check) Token metering is on', 4000);
    return true;
  };

  const turnOff = (store = storeForCommand()) => {
    if (!store) return;
    try {
      setMeterConfig(store.root, false);
      vscode.window.setStatusBarMessage('$(check) Token metering is off; recorded events are kept', 4000);
    } catch (e) {
      vscode.window.showErrorMessage(`Could not turn off token metering: ${(e as Error).message}`);
    }
  };

  const clear = async (store = storeForCommand()) => {
    if (!store) return;
    const choice = await vscode.window.showWarningMessage(
      'Delete every recorded token meter event for this workspace?',
      { modal: true, detail: `This deletes the event files in ${store.settings.dir}. It cannot be undone. Metering stays on or off as it is.` },
      'Delete events',
    );
    if (choice !== 'Delete events') return;
    const n = clearEvents(store.settings.dir);
    store.reload();
    vscode.window.setStatusBarMessage(`$(trash) Deleted ${n} token meter file(s)`, 4000);
  };

  const panel = new MeterPanel(context, ui, { turnOn, clear });

  context.subscriptions.push(
    vscode.commands.registerCommand('smd.openTokenMeter', () => {
      const store = storeForCommand();
      if (store) panel.show(store, vscode.window.activeTextEditor?.document);
    }),
    vscode.commands.registerCommand('smd.meter.turnOn', () => turnOn()),
    vscode.commands.registerCommand('smd.meter.turnOff', () => turnOff()),
    vscode.commands.registerCommand('smd.meter.clear', () => clear()),
    vscode.commands.registerCommand('smd.meter.howCounted', () => vscode.window.showInformationMessage('How the token meter counts', { modal: true, detail: HOW_COUNTED })),
    // For integration tests: what the store holds for the active document's workspace.
    vscode.commands.registerCommand('smd._meterState', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const store = target ? stores.forUri(target) : stores.first();
      return store ? { root: store.root, enabled: store.settings.enabled, events: store.all.length, panel: panel.state() } : undefined;
    }),
    registerHeadingHints(ui),
  );
  return ui;
}

/** The meter panel: one webview, re-rendered when its store changes or a choice is made. */
class MeterPanel {
  private panel: vscode.WebviewPanel | undefined;
  private store: MeterStore | undefined;
  private period: MeterPeriod = '30';
  private tab: MeterTab = 'overview';
  private file: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private subscription: vscode.Disposable | undefined;
  private lastGraph: ReturnType<typeof sectionGraph> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ui: TokenMeterUi,
    private readonly actions: { turnOn: (s: MeterStore) => Promise<boolean>; clear: (s: MeterStore) => Promise<void> },
  ) {}

  state() {
    return this.panel ? { visible: true, tab: this.tab, period: this.period, file: this.file } : { visible: false };
  }

  show(store: MeterStore, doc: vscode.TextDocument | undefined): void {
    this.store = store;
    const rel = doc?.languageId === 'smd' ? store.relative(doc.uri.fsPath) : undefined;
    if (rel) this.file = rel;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('smd.tokenMeter', 'Token Meter', vscode.ViewColumn.Active, {
        enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')], retainContextWhenHidden: false,
      });
      this.panel.iconPath = new vscode.ThemeIcon('graph');
      this.panel.onDidDispose(() => { this.panel = undefined; this.subscription?.dispose(); });
      this.panel.webview.onDidReceiveMessage((m: { type: string; value?: string; file?: string | null; slug?: string | null }) => this.onMessage(m));
    } else {
      this.panel.reveal();
    }
    this.subscription?.dispose();
    this.subscription = this.ui.onDidChange(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.render(), 300);
    });
    this.render();
  }

  private async onMessage(m: { type: string; value?: string; file?: string | null; slug?: string | null }): Promise<void> {
    const store = this.store;
    if (!store) return;
    switch (m.type) {
      case 'tab':
        if ((METER_TABS as readonly string[]).includes(m.value ?? '')) this.tab = m.value as MeterTab;
        return;
      case 'period':
        if (m.value === '7' || m.value === '30' || m.value === 'all') this.period = m.value;
        break;
      case 'file':
        if (m.file) { this.file = m.file; if (this.tab === 'overview') this.tab = 'sections'; }
        break;
      case 'open':
        if (m.file) await this.openSection(store, m.file, m.slug ?? undefined);
        return;
      case 'copyMermaid':
        if (this.lastGraph) {
          await vscode.env.clipboard.writeText(sectionGraphMermaid(this.lastGraph));
          vscode.window.setStatusBarMessage('$(check) Copied the section graph as Mermaid', 4000);
        }
        return;
      case 'turnOn':
        await this.actions.turnOn(store);
        return;
      case 'clear':
        await this.actions.clear(store);
        return;
      case 'howCounted':
        await vscode.commands.executeCommand('smd.meter.howCounted');
        return;
      default:
        return;
    }
    this.render();
  }

  private async openSection(store: MeterStore, file: string, slug: string | undefined): Promise<void> {
    const uri = vscode.Uri.file(path.join(store.root, file));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const heading = slug ? parseSmd(doc.getText()).headings.find((h) => h.slug === slug) : undefined;
      const line = heading?.line ?? 0;
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside, preview: true });
    } catch {
      vscode.window.showWarningMessage(`Could not open ${file}.`);
    }
  }

  private textOf(store: MeterStore, file: string): string | undefined {
    const abs = path.join(store.root, file);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
    if (open) return open.getText();
    try { return fs.readFileSync(abs, 'utf8'); } catch { return undefined; }
  }

  private render(): void {
    const store = this.store;
    if (!this.panel || !store) return;
    const settings = store.settings;
    const report = meterReport(store.all, { since: sinceFor(this.period) });
    const files = [...new Set([...report.sections.map((s) => s.file), ...report.files.map((f) => f.file)])];
    if (this.file && !files.includes(this.file)) files.unshift(this.file);
    const file = this.file ?? files[0];
    const model: MeterPanelModel = {
      root: store.root, enabled: settings.enabled, ...(settings.off ? { off: settings.off } : {}),
      paused: settings.enabled && folderBytes(settings.dir) >= settings.maxBytes,
      period: this.period, tab: this.tab, report, files, ...(file ? { file } : {}),
    };
    if (file) {
      const text = this.textOf(store, file);
      model.fileReport = meterReport(store.all, { since: sinceFor(this.period), paths: [file] });
      const declared = text === undefined ? [] : declaredSectionEdges(file, text);
      model.graph = sectionGraph(store.all, { since: sinceFor(this.period), paths: [file], declared });
      this.lastGraph = model.graph;
      if (text !== undefined) {
        model.headings = parseSmd(text).headings.filter((h) => h.level >= 2).map((h) => ({ slug: h.slug, text: h.text, level: h.level, skip: h.agent === 'skip' }));
      }
    }
    const nonce = webviewNonce();
    const script = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'token-meter.js'));
    this.panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${webviewCsp(this.panel.webview.cspSource, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${METER_PANEL_CSS}</style></head>
<body>${meterPanelBody(model)}<script nonce="${nonce}" src="${script.toString()}"></script></body></html>`;
  }
}

/** Read counts above each heading of a .smd file, when `smd.meter.headingHints` is on and metering is on. */
function registerHeadingHints(ui: TokenMeterUi): vscode.Disposable {
  const emitter = new vscode.EventEmitter<void>();
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: emitter.event,
    provideCodeLenses(doc) {
      if (!vscode.workspace.getConfiguration('smd', doc.uri).get<boolean>('meter.headingHints', false)) return [];
      const measured = ui.measuredFor(doc.uri);
      if (!measured) return [];
      const stats = new Map(measured.report.sections.map((s) => [s.slug, s]));
      return parseSmd(doc.getText()).headings.map((h) => {
        const s = stats.get(h.slug);
        const title = s
          ? `$(eye) ${s.reads} read${s.reads === 1 ? '' : 's'} · ${s.sessions} session${s.sessions === 1 ? '' : 's'} · ${measured.period}`
          : h.agent === 'skip' ? '$(eye-closed) hidden from agents (agent=skip)' : '$(eye-closed) never read by agents';
        return new vscode.CodeLens(new vscode.Range(h.line, 0, h.line, 0), { title, command: 'smd.openTokenMeter', tooltip: 'Open the token meter' });
      });
    },
  };
  return vscode.Disposable.from(
    emitter,
    vscode.languages.registerCodeLensProvider({ language: 'smd' }, provider),
    ui.onDidChange(() => emitter.fire()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('smd.meter.headingHints')) emitter.fire(); }),
  );
}
