import * as path from 'node:path';
import * as vscode from 'vscode';
import { readerFor as fileReader } from './workspace';

/**
 * Reader for ```lang file="…"``` embeds. Only files inside an open workspace folder or the
 * document's own folder can be read, so an untrusted .smd cannot pull in e.g. ~/.ssh keys.
 */
export function readerFor(document: vscode.TextDocument): ((rel: string) => string | undefined) | undefined {
  return readerForUri(document.uri);
}

/**
 * The same reader for a document known by its URI (e.g. a .md file in the built-in Markdown preview). It checks the
 * real path too, links and junctions followed, as the CLI and the MCP server do (see workspace.readerFor).
 */
export function readerForUri(uri: Pick<vscode.Uri, 'scheme' | 'fsPath'> | undefined): ((rel: string) => string | undefined) | undefined {
  if (uri?.scheme !== 'file') return undefined;
  const dir = path.dirname(uri.fsPath);
  const roots = [dir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)].map((r) => path.resolve(r));
  return fileReader(uri.fsPath, roots);
}
