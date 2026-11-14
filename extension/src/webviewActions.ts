// What a Semantic Markdown webview (the preview, the Block Editor) asks the extension to do for it.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { taskCheckbox } from './editing';
import { followLink, type LinkContext } from './linkPolicy';

/** Tick or untick the task checkbox on `line` of the document; nothing when that line has none. */
export async function toggleTask(document: vscode.TextDocument, line: number): Promise<void> {
  if (line < 0 || line >= document.lineCount) return;
  const box = taskCheckbox(document.lineAt(line).text);
  if (!box) return;
  const edit = new vscode.WorkspaceEdit();
  const pos = new vscode.Position(line, box.column);
  edit.replace(document.uri, new vscode.Range(pos, pos.translate(0, 1)), box.done ? ' ' : 'x');
  await vscode.workspace.applyEdit(edit);
}

/** Show the document in a text editor with the cursor on `line`. */
export async function revealLine(document: vscode.TextDocument, line: number): Promise<void> {
  const visible = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const editor = await vscode.window.showTextDocument(document, visible?.viewColumn ?? vscode.ViewColumn.One);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/**
 * Follow a link clicked in the page under the one link policy (linkPolicy.ts): web and mail links outside VS Code,
 * files inside the workspace in an editor, anything else refused with a message that shows the link.
 */
export async function openLink(document: vscode.TextDocument, href: unknown): Promise<void> {
  await followLink(href, linkContext(document), {
    openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url, true)),
    openFile: (file) => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), vscode.ViewColumn.One),
    refuse: (message) => vscode.window.showInformationMessage(message),
    missing: (message) => vscode.window.showWarningMessage(message),
  });
}

/** Relative links resolve against the document; files may be in a workspace folder, or beside a document in none. */
export function linkContext(document: vscode.TextDocument): LinkContext {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  if (document.uri.scheme !== 'file') return { roots: folders };
  const documentDir = path.dirname(document.uri.fsPath);
  return { documentDir, roots: vscode.workspace.getWorkspaceFolder(document.uri) ? folders : [documentDir] };
}
