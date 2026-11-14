import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one policy for links clicked in a Semantic Markdown webview (the preview, the Block Editor), applied in the
 * extension host (improvement roadmap t-11, CL-03). The page only reports the href, so a document can't widen it.
 *
 * - `http`, `https` and `mailto` open outside VS Code.
 * - `file:` and relative links open in an editor when their real path, symbolic links resolved, is inside a
 *   containment root: a workspace folder, or the folder of a document that is in none.
 * - Every other scheme (`command:`, `vscode:`, `javascript:`, `data:`, custom schemes) is refused, with a message
 *   that shows the link. Nothing asks the reader at click time.
 */

const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const MAX_LENGTH = 4096;

export interface LinkContext {
  /** The folder relative links resolve against: the document's own. Undefined for an unsaved document. */
  documentDir?: string;
  /** Where linked files may be: the workspace folders, or the document's folder when it is in none. */
  roots: readonly string[];
  /** The real path, symbolic links resolved, or undefined when nothing is there (default: fs.realpathSync.native). */
  realpath?: (file: string) => string | undefined;
}

export type LinkDecision =
  | { kind: 'external'; url: string }
  | { kind: 'file'; file: string }
  | { kind: 'missing'; file: string }
  | { kind: 'refused'; reason: string };

/** What the host does with each decision; tests pass a stub. */
export interface LinkOpener {
  openExternal(url: string): Promise<unknown> | unknown;
  openFile(file: string): Promise<unknown> | unknown;
  /** Tell the reader the link was not opened; `message` shows the link. */
  refuse(message: string): Promise<unknown> | unknown;
  /** Tell the reader the linked file does not exist. */
  missing(message: string): Promise<unknown> | unknown;
}

/** Decide what a clicked href may do. Never throws: anything unreadable is refused. */
export function decideLink(href: unknown, context: LinkContext): LinkDecision {
  if (typeof href !== 'string' || href.trim() === '' || href.length > MAX_LENGTH || href.includes('\0')) {
    return { kind: 'refused', reason: 'the link is not readable' };
  }
  const scheme = SCHEME.exec(href)?.[1].toLowerCase();
  if (scheme !== undefined) return decideScheme(href, `${scheme}:`, context);
  // `//host/x` and `\\host\x` name another machine; following them would reach the network.
  if (/^[\\/]{2}/.test(href)) return { kind: 'refused', reason: 'links to another machine are not opened' };
  if (href.startsWith('#')) return { kind: 'refused', reason: 'the link points inside the page' };
  if (context.documentDir === undefined) return { kind: 'refused', reason: 'relative links need a saved document' };
  const file = decodePath(withoutQuery(href));
  if (file === undefined) return { kind: 'refused', reason: 'the link has a malformed escape' };
  if (file === '') return { kind: 'refused', reason: 'the link names no file' };
  return contained(path.resolve(context.documentDir, file), context);
}

function decideScheme(href: string, scheme: string, context: LinkContext): LinkDecision {
  if (EXTERNAL.has(scheme)) {
    try {
      return { kind: 'external', url: new URL(href).href };
    } catch {
      return { kind: 'refused', reason: 'the link is not a valid URL' };
    }
  }
  if (scheme === 'file:') {
    let file: string;
    try {
      file = fileURLToPath(new URL(withoutQuery(href)));
    } catch {
      return { kind: 'refused', reason: 'the file link is not valid here' };
    }
    return contained(file, context);
  }
  return { kind: 'refused', reason: `${scheme} links are not opened from a document` };
}

/** The href up to its first `?` or `#`. */
function withoutQuery(href: string): string {
  const end = href.search(/[?#]/);
  return end < 0 ? href : href.slice(0, end);
}

/** Percent-decoding that returns undefined instead of throwing on a malformed escape. */
export function decodePath(text: string): string | undefined {
  try {
    const decoded = decodeURIComponent(text);
    return decoded.includes('\0') ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/**
 * A file inside a root. The path is checked as written first, so a path outside every root is refused without
 * touching the disk, then again with symbolic links resolved, so a link inside a root can't lead out of it.
 */
function contained(file: string, context: LinkContext): LinkDecision {
  const outside: LinkDecision = { kind: 'refused', reason: 'the file is outside the workspace' };
  if (!context.roots.some((root) => inside(root, file))) return outside;
  const realpath = context.realpath ?? realpathOrUndefined;
  const real = realpath(file);
  if (real === undefined) return { kind: 'missing', file };
  const roots = context.roots.map((root) => realpath(root) ?? root);
  return roots.some((root) => inside(root, real)) ? { kind: 'file', file: real } : outside;
}

/** Whether `file` is `root` or below it (case-insensitive on Windows, as `path.relative` is there). */
export function inside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
}

function realpathOrUndefined(file: string): string | undefined {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return undefined;
  }
}

/** Decide, then do: open the URL or the file, or say why not. Resolves to the decision, for tests and logs. */
export async function followLink(href: unknown, context: LinkContext, opener: LinkOpener): Promise<LinkDecision> {
  const decision = decideLink(href, context);
  switch (decision.kind) {
    case 'external':
      await opener.openExternal(decision.url);
      break;
    case 'file':
      await opener.openFile(decision.file);
      break;
    case 'missing':
      await opener.missing(`Semantic Markdown: "${String(href)}" does not exist.`);
      break;
    case 'refused':
      await opener.refuse(`Semantic Markdown did not open ${show(href)}: ${decision.reason}.`);
      break;
  }
  return decision;
}

/** The link as the message shows it: one line, and not so long that the message is all link. */
function show(href: unknown): string {
  if (typeof href !== 'string') return 'the link';
  const line = href.replace(/[\r\n\t]+/g, ' ');
  return `"${line.length > 200 ? `${line.slice(0, 200)}…` : line}"`;
}
