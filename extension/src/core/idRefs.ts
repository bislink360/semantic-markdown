import { encodeAnchor } from './anchors';
import { findAttrsEnd, lexAttrItems } from './attrs';
import { CONTAINER_OPEN } from './containers';
import { findRefs } from './figures';
import { parseFrontMatter } from './frontmatter';
import { splitIdRef } from './idTarget';
import { resolveId } from './ids';
import { findLinks, splitTarget } from './links';
import { idOwners, parseSmd } from './parse';
import { tagBlocks } from './semanticTags';
import { ID_ATTRIBUTES } from './spec';
import { specVersion, type SpecVersion } from './specVersion';
import { scanTasks } from './taskLines';
import { escapeRegExp } from './util';

/**
 * Where a document names block ids, for go to definition, find references, hover and rename (semantic tags R18): the
 * `{#id}` that gives an id, every id attribute that lists it (`verifies=R1,R2`, `depends-on=`, `for=`…), `:ref[id]`, a
 * task's `:depends[id]` and `#id` links. An id may name a block of another document, `other.smd#R1` (R19). Positions
 * are zero-based lines and UTF-16 columns, as everywhere in the core. Hosts (the VS Code extension and the language
 * server) find the documents and resolve paths; nothing here reads files.
 */

export type IdUseKind = 'definition' | 'attribute' | 'ref' | 'depends' | 'link';

export interface IdUse {
  kind: IdUseKind;
  line: number;
  /** The columns of the id itself, without the path written before it (`R1` of `other.smd#R1`). */
  column: number;
  endColumn: number;
  /** Where the reference as written starts: the path of `other.smd#R1`, else `column`. */
  start: number;
  id: string;
  /** The document as written, relative to this one (decoded for links); `''` for this document. */
  path: string;
  /** The attribute that lists it (`verifies`), for an attribute. */
  key?: string;
  /** A link's anchor as written, which may be percent-encoded. */
  raw?: string;
}

/** The characters an id may have: what `{#id}` takes on a container, a heading or a task. */
export const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const cache = new Map<string, readonly IdUse[]>();

/** Every place a document gives or names an id, in source order. Code holds none. */
export function idUses(text: string): readonly IdUse[] {
  const known = cache.get(text);
  if (known) return known;
  const uses = scan(text);
  if (cache.size > 16) cache.clear();
  cache.set(text, uses);
  return uses;
}

/** The use of an id under a zero-based line and column (anywhere in `other.smd#R1`), if any. */
export function idUseAt(text: string, line: number, column: number): IdUse | undefined {
  return idUses(text).find((u) => u.line === line && column >= u.start && column <= u.endColumn);
}

function scan(text: string): IdUse[] {
  const fm = parseFrontMatter(text);
  const spec = specVersion(fm.data);
  const lines = text.split(/\r?\n/);
  const uses: IdUse[] = [...definitions(text, lines), ...attributes(text, lines, spec), ...refs(lines, fm.bodyStartLine, spec)];
  if (spec >= 2) uses.push(...depends(text, lines, spec));
  uses.push(...links(text));
  return uses.sort((a, b) => a.line - b.line || a.start - b.start);
}

/** The `{#id}` (or raw HTML `id="…"`) of each block that gives an id. A heading's id from its text is not written, so it has none. */
function definitions(text: string, lines: string[]): IdUse[] {
  const uses: IdUse[] = [];
  for (const [id, owners] of idOwners(text)) {
    for (const owner of owners) {
      if (owner.heading && !owner.stable) continue;
      const column = definitionColumn(lines[owner.line] ?? '', id);
      if (column !== undefined) uses.push({ kind: 'definition', line: owner.line, column, endColumn: column + id.length, start: column, id, path: '' });
    }
  }
  return uses;
}

function definitionColumn(raw: string, id: string): number | undefined {
  const e = escapeRegExp(id);
  const attr = new RegExp(String.raw`(?:^|[{\s])#${e}(?=[\s}])`).exec(raw);
  if (attr) return attr.index + attr[0].length - id.length;
  const html = new RegExp(String.raw`\b(?:id|name)\s*=\s*["']?${e}(?=["'\s>/]|$)`, 'i').exec(raw);
  return html ? html.index + html[0].length - id.length : undefined;
}

/** The ids of a comma-separated list written from `offset`, each with its columns (and its path's, across documents). */
function listUses(value: string, offset: number, line: number, kind: IdUseKind, key?: string): IdUse[] {
  const uses: IdUse[] = [];
  let at = 0;
  for (const part of value.split(',')) {
    const written = part.trim();
    if (written) {
      const start = offset + at + (part.length - part.trimStart().length);
      const target = splitIdRef(written);
      const column = target.path ? start + target.path.length + 1 : start;
      uses.push({ kind, line, column, endColumn: column + target.id.length, start, id: target.id, path: target.path, ...(key ? { key } : {}) });
    }
    at += part.length + 1;
  }
  return uses;
}

/** The ids each id attribute lists, on the opening lines of the containers it applies to. */
function attributes(text: string, lines: string[], spec: SpecVersion): IdUse[] {
  const uses: IdUse[] = [];
  for (const block of tagBlocks(text)) {
    const keys = Object.entries(ID_ATTRIBUTES).filter(([key, names]) => names.includes(block.name) && block.values[key] !== undefined).map(([key]) => key);
    if (block.name === 'evidence' && block.values.rev !== undefined) keys.push('rev');
    if (!keys.length) continue;
    const raw = lines[block.line] ?? '';
    const open = CONTAINER_OPEN.exec(raw);
    if (!open?.[4].startsWith('{')) continue;
    const rest = open[4];
    const restStart = raw.length - rest.length;
    const end = findAttrsEnd(rest, 0, spec);
    const items = end < 0 ? null : lexAttrItems(rest.slice(1, end), spec);
    for (const { match: m, pos } of items ?? []) {
      if (!m[3] || !keys.includes(m[3])) continue;
      const value = m[4] ?? m[5] ?? m[6];
      if (value === undefined) continue;
      const eq = m[0].indexOf('=', m[0].indexOf(m[3]) + m[3].length);
      let from = eq + 1;
      while (/\s/.test(m[0][from] ?? '')) from++;
      if (m[6] === undefined) from++; // past the opening quote
      const offset = restStart + 1 + pos + from;
      uses.push(...(m[3] === 'rev' ? revUses(value, offset, block.line) : listUses(value, offset, block.line, 'attribute', m[3])));
    }
  }
  return uses;
}

/** The ids of an evidence record's `rev=R1@3f2a…,R2@…`: the part before each `@`. A bare hash names no id. */
function revUses(value: string, offset: number, line: number): IdUse[] {
  const uses: IdUse[] = [];
  let at = 0;
  for (const part of value.split(',')) {
    const written = part.trim();
    const hash = written.lastIndexOf('@');
    if (hash > 0) {
      const start = offset + at + (part.length - part.trimStart().length);
      uses.push(...listUses(written.slice(0, hash), start, line, 'attribute', 'rev'));
    }
    at += part.length + 1;
  }
  return uses;
}

/** `:ref[id]` outside code. */
function refs(lines: string[], bodyStart: number, spec: SpecVersion): IdUse[] {
  return findRefs(lines, bodyStart, spec).flatMap((ref) => {
    const inner = ':ref['.length;
    const value = (lines[ref.line] ?? '').slice(ref.column + inner, ref.endColumn - 1);
    return listUses(value, ref.column + inner, ref.line, 'ref').slice(0, 1).filter((u) => u.id && `${u.path ? `${u.path}#` : ''}${u.id}` === ref.id);
  });
}

const DEPENDS = /(^|[\s([{>*_~"'-]):depends\[([^\]\n]*)\]/gi;

/** A task's `:depends[id, …]` (spec v2). */
function depends(text: string, lines: string[], spec: SpecVersion): IdUse[] {
  const uses: IdUse[] = [];
  for (const task of scanTasks(text, undefined, spec)) {
    if (task.kind !== 'task') continue;
    const raw = (lines[task.line] ?? '').replace(/(`+)([\s\S]*?)\1/g, (m) => ' '.repeat(m.length));
    for (const m of raw.matchAll(DEPENDS)) {
      uses.push(...listUses(m[2], m.index + m[1].length + ':depends['.length, task.line, 'depends'));
    }
  }
  return uses;
}

/** `#id` and `other.smd#id` links (not includes, whose `#` names a section). */
function links(text: string): IdUse[] {
  const uses: IdUse[] = [];
  for (const link of findLinks(text).links) {
    if (link.kind === 'include') continue;
    const parts = splitTarget(link.target);
    const hash = link.target.indexOf('#');
    if (!parts?.anchor || hash < 0) continue;
    const column = link.column + hash + 1;
    uses.push({
      kind: 'link', line: link.line, column, endColumn: link.column + link.target.length, start: link.column, id: parts.anchor,
      path: parts.path, raw: link.target.slice(hash + 1),
    });
  }
  return uses;
}

/** A document of the workspace: a key the host chooses (a path or URI) and its text. */
export interface IdDocument { key: string; text: string }

/** The key of the document a path written in document `from` names (`''` is `from` itself), or undefined. */
export type ResolveDocument = (from: string, path: string) => string | undefined;

/** An id of one document. */
export interface IdTargetRef { key: string; id: string }

/** A use in a document of the workspace. */
export interface WorkspaceIdUse { key: string; use: IdUse }

/** The document and id a use names: its own document for a definition. */
export function useTarget(from: string, use: IdUse, resolve: ResolveDocument): IdTargetRef | undefined {
  const key = use.kind === 'definition' ? from : resolve(from, use.path);
  return key === undefined ? undefined : { key, id: use.id };
}

/**
 * Every place in `documents` that names `target`: id attributes, `:ref`, `:depends` and links, and with
 * `declaration` the `{#id}` that gives it.
 */
export function idReferences(documents: readonly IdDocument[], target: IdTargetRef, resolve: ResolveDocument, declaration = false): WorkspaceIdUse[] {
  const found: WorkspaceIdUse[] = [];
  for (const doc of documents) {
    if (!doc.text.includes(target.id) && !doc.text.includes('%')) continue; // a link may percent-encode the whole id
    for (const use of idUses(doc.text)) {
      if (use.id !== target.id) continue;
      if (use.kind === 'definition') {
        if (declaration && doc.key === target.key) found.push({ key: doc.key, use });
      } else if (resolve(doc.key, use.path) === target.key) {
        found.push({ key: doc.key, use });
      }
    }
  }
  return found;
}

/** One replacement on one line of a document of the workspace. */
export interface IdEdit { key: string; line: number; column: number; endColumn: number; newText: string }

/**
 * The edits that rename `target` to `newId`: its `{#id}` and every reference to it in `documents` (which must hold
 * the target's document). Refused, with a reason, for an id that can't be written in `{#…}`, one already used in the
 * document, a heading's id from its text (rename the heading instead) and an id two blocks give: then only the `{#id}`
 * under `at` is renamed, since references to it name neither block.
 */
export function renameIdEdits(
  documents: readonly IdDocument[], target: IdTargetRef, newId: string, resolve: ResolveDocument,
  at?: { key: string; line: number; column: number },
): { edits: IdEdit[] } | { error: string } {
  if (!ID_PATTERN.test(newId)) return { error: `"${newId}" can't be an id: use letters, digits, "-" and "_".` };
  const doc = documents.find((d) => d.key === target.key);
  if (!doc) return { error: `The document that gives "${target.id}" can't be read.` };
  const owners = idOwners(doc.text).get(target.id);
  if (!owners) return { error: `No block has the id "${target.id}".` };
  const definitionsOf = idUses(doc.text).filter((u) => u.kind === 'definition' && u.id === target.id);
  const edit = (key: string, u: IdUse, text = newId): IdEdit => ({ key, line: u.line, column: u.column, endColumn: u.endColumn, newText: text });
  let only: IdUse | undefined;
  if (owners.length > 1) {
    only = at?.key === target.key ? definitionsOf.find((u) => u.line === at.line && at.column >= u.start - 1 && at.column <= u.endColumn) : undefined;
    if (!only) return { error: `"${target.id}" is the id of ${owners.length} blocks, so references to it name none of them. Rename one of its {#${target.id}} to tell them apart.` };
  } else if (owners[0].heading && !owners[0].stable) {
    return { error: `"${target.id}" is the id a heading gets from its text: rename the heading to change it.` };
  } else if (!definitionsOf.length) {
    return { error: `Can't find where "${target.id}" is written.` };
  }
  if (newId === target.id) return { edits: [] };
  if (parseSmd(doc.text).ids.has(newId)) return { error: `"${newId}" is already an id in that document: choose another.` };
  if (only) return { edits: [edit(target.key, only)] };
  const edits = definitionsOf.map((u) => edit(target.key, u));
  for (const { key, use } of idReferences(documents, target, resolve)) {
    edits.push(edit(key, use, use.kind === 'link' && use.raw !== undefined ? encodeAnchor(use.raw, newId) : newId));
  }
  return { edits };
}

/**
 * The id attributes, `:ref` and `:depends` in `text` that name `id` (not links, which hosts find with linksToAnchor):
 * for the references of a heading, and for moving them when a rename changes its id. `pointsAt(path)` says whether a
 * path written in `text` is the heading's document (`''` for `text`'s own).
 */
export function namingUses(text: string, id: string, pointsAt: (path: string) => boolean): IdUse[] {
  if (!text.includes(id)) return [];
  return idUses(text).filter((u) => u.id === id && (u.kind === 'attribute' || u.kind === 'ref' || u.kind === 'depends') && pointsAt(u.path));
}

/** The zero-based lines of the blocks that give `id` in a document: one, several (ambiguous) or none. */
export function idDefinitionLines(text: string, id: string): number[] {
  const found = resolveId(text, id);
  if (found.status === 'ambiguous') return found.lines;
  return found.status === 'resolved' && found.line !== undefined ? [found.line] : [];
}

const HOVER_LINES = 8;

/**
 * Hover text for an id: the block that gives it (its name, attributes and title, then the first lines of its body),
 * the lines of the blocks when two give it, or undefined when nothing does. `where` names another document.
 */
export function idHover(text: string, id: string, where = ''): string | undefined {
  const found = resolveId(text, id);
  const place = where ? ` in ${where}` : '';
  if (found.status === 'missing') return undefined;
  if (found.status === 'ambiguous') {
    return `**${id}** is the id of ${found.lines.length} blocks${place} (lines ${found.lines.map((l) => l + 1).join(', ')}), so it names none of them.`;
  }
  if (found.line === undefined) return `**${id}**${place}`;
  const lines = text.split(/\r?\n/);
  const block = tagBlocks(text).find((b) => b.line === found.line && b.id === id);
  const head = (what: string, title: string) => `**${id}** · ${what}${place}${title ? ` — ${title}` : ''}`;
  if (block) {
    const values = Object.entries(block.values).map(([k, v]) => `${k}=${v}`).join(' ');
    const body = lines.slice(block.line + 1, block.endLine).filter((l) => !/^\s{0,3}:{3,}\s*$/.test(l));
    const excerpt = body.slice(0, HOVER_LINES).join('\n').trim();
    return [head(`:::${block.name}${values ? ` \`${values}\`` : ''}`, block.title), ...(excerpt ? [`${excerpt}${body.length > HOVER_LINES ? '\n\n…' : ''}`] : [])].join('\n\n');
  }
  const task = scanTasks(text).find((t) => t.line === found.line);
  if (task?.kind === 'task') return head(`task (${task.mark === ' ' ? 'open' : 'done'})`, task.body.trim());
  if (task?.kind === 'heading') return head('heading', task.text);
  return head('block', (lines[found.line] ?? '').trim());
}
