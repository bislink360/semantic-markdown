import * as path from 'node:path';
import * as vscode from 'vscode';
import { agentView, parseSmd, type AgentViewOptions } from './core';
import { readerFor } from './files';
import { briefOnlyItems, omissionItems, omissionSummary, type OmissionItem } from './omissionPanel';

const SCHEME = 'smd-agent';

/** Live, read-only "what an agent sees" documents: smd-agent:/name.agent.md?<source uri>#brief */
class AgentViewProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly open = new Set<string>();

  static uriFor(source: vscode.Uri, brief: boolean): vscode.Uri {
    const name = path.basename(source.fsPath, '.smd') + (brief ? '.agent-brief.md' : '.agent.md');
    return vscode.Uri.from({ scheme: SCHEME, path: '/' + name, query: source.toString(), fragment: brief ? 'brief' : '' });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    this.open.add(uri.toString());
    const source = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.query);
    if (!source) return '(source document is not open)';
    const file = path.basename(source.uri.fsPath);
    const result = agentView(source.getText(), { brief: uri.fragment === 'brief', readFile: readerFor(source), file, provenance: true });
    const saved = Math.round((1 - result.tokens / Math.max(1, result.originalTokens)) * 100);
    const left = result.provenance ? omissionSummary(result.provenance) : '';
    const note = `Agent view: ≈${result.tokens} tokens (source ≈${result.originalTokens}, ${saved}% smaller). Read-only; edit the .smd file.${left ? `\n${left}` : ''}`;
    return `<!-- ${note} -->\n\n${result.text}`;
  }

  refresh(source: vscode.Uri): void {
    for (const key of this.open) {
      const uri = vscode.Uri.parse(key);
      if (uri.query === source.toString()) this.emitter.fire(uri);
    }
  }
}

export function registerAgentView(context: vscode.ExtensionContext): void {
  const provider = new AgentViewProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'smd.showAgentView';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const activeSmd = (): vscode.TextDocument | undefined => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId === 'smd') return doc;
    vscode.window.showInformationMessage('Open a .smd file first.');
    return undefined;
  };

  const updateStatus = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'smd') { status.hide(); return; }
    const full = agentView(doc.getText(), { readFile: readerFor(doc) });
    const brief = agentView(doc.getText(), { brief: true, readFile: readerFor(doc) });
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    status.text = `$(hubot) ≈${k(full.tokens)} tok`;
    status.tooltip = new vscode.MarkdownString(
      `**Agent token estimate**\n\n| View | ≈ tokens |\n|---|---:|\n| Raw file | ${full.originalTokens} |\n| Agent view | ${full.tokens} |\n| Agent view, brief | ${brief.tokens} |\n\nClick to open the agent view.`);
    status.show();
  };

  const show = async (brief: boolean) => {
    const doc = activeSmd();
    if (!doc) return;
    const target = await vscode.workspace.openTextDocument(AgentViewProvider.uriFor(doc.uri, brief));
    await vscode.languages.setTextDocumentLanguage(target, 'markdown');
    await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
  };

  const copy = async (options: AgentViewOptions, what: string) => {
    const doc = activeSmd();
    if (!doc) return;
    const result = agentView(doc.getText(), { ...options, readFile: readerFor(doc) });
    await vscode.env.clipboard.writeText(result.text);
    vscode.window.setStatusBarMessage(`$(check) Copied ${what} (≈${result.tokens} tokens)`, 4000);
  };

  /** Go to an omission in the source: the document, or the included file it is in. */
  const reveal = async (doc: vscode.TextDocument, item: OmissionItem) => {
    const uri = item.own ? doc.uri : vscode.Uri.joinPath(vscode.Uri.file(path.dirname(doc.uri.fsPath)), item.file);
    try {
      const target = item.own ? doc : await vscode.workspace.openTextDocument(uri);
      const end = Math.min(item.end, target.lineCount - 1);
      const range = new vscode.Range(item.start, 0, end, target.lineAt(end).text.length);
      await vscode.window.showTextDocument(target, { selection: range, preview: false });
    } catch {
      vscode.window.showWarningMessage(`Could not open ${item.file}.`);
    }
  };

  /**
   * What the agent view leaves out, in a quick pick (keyboard first): each omission with its reason, then what the
   * brief view also condenses. Choosing one selects its lines in the source.
   */
  const showOmissions = async () => {
    const doc = activeSmd();
    if (!doc) return;
    const options = { readFile: readerFor(doc), file: path.basename(doc.uri.fsPath), provenance: true };
    const full = agentView(doc.getText(), options).provenance!;
    const brief = agentView(doc.getText(), { ...options, brief: true }).provenance!;
    type Pick = vscode.QuickPickItem & { omission?: OmissionItem };
    const section = (label: string, items: OmissionItem[]): Pick[] => (items.length
      ? [{ label, kind: vscode.QuickPickItemKind.Separator }, ...items.map((o) => ({ label: o.label, description: o.description, detail: o.detail, omission: o }))]
      : []);
    const picks = [
      ...section('Agent view', omissionItems(full)),
      ...section('Also condensed in the brief view', briefOnlyItems(full, brief)),
    ];
    if (!picks.length) {
      vscode.window.showInformationMessage('The agent view leaves nothing out of this document.');
      return;
    }
    const chosen = await vscode.window.showQuickPick(picks, {
      placeHolder: `What agents don't see in full (≈${full.size.tokens} tokens, brief ≈${brief.size.tokens}). Choose one to go to its lines.`,
      matchOnDescription: true, matchOnDetail: true,
    });
    if (chosen?.omission) await reveal(doc, chosen.omission);
  };

  context.subscriptions.push(
    status,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.commands.registerCommand('smd.showAgentView', () => show(false)),
    vscode.commands.registerCommand('smd.showAgentViewBrief', () => show(true)),
    vscode.commands.registerCommand('smd.showAgentViewOmissions', showOmissions),
    vscode.commands.registerCommand('smd.copyAgentView', () => copy({}, 'agent view')),
    vscode.commands.registerCommand('smd.copyAgentSections', async () => {
      const doc = activeSmd();
      if (!doc) return;
      const headings = parseSmd(doc.getText()).headings;
      const picks = await vscode.window.showQuickPick(
        headings.map((h) => ({ label: `${'  '.repeat(h.level - 1)}${h.text}`, description: h.agent === 'skip' ? 'skipped for agents' : `L${h.line + 1}`, slug: h.slug })),
        { canPickMany: true, placeHolder: 'Sections to copy for an agent (agent instructions are always included)' },
      );
      if (picks?.length) await copy({ sections: picks.map((p) => p.slug) }, `${picks.length} section(s)`);
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== 'smd') return;
      clearTimeout(timer);
      // Two agent views per update: wait longer on long documents so typing stays smooth.
      const delay = Math.min(2000, Math.max(400, e.document.lineCount / 10));
      timer = setTimeout(() => {
        provider.refresh(e.document.uri);
        if (e.document === vscode.window.activeTextEditor?.document) updateStatus();
      }, delay);
    }),
  );
  updateStatus();
}
