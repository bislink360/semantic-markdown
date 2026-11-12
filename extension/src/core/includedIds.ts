import { parseFrontMatter } from './frontmatter';
import { containerEnd, findIncludes, includeRequest, innerScope, loadInclude, rootScope, type IncludeScope } from './include';
import { includeSource } from './includeText';
import { idOwners } from './parse';
import { specVersion, type SpecVersion } from './specVersion';

/**
 * The ids a document gives once its includes are read (research contract, "Identity"; improvement roadmap t-15 and
 * t-59). Rendering shows an included file's blocks in place of the `:::include`, so their ids are ids of the document,
 * and the include's own body, the fallback text, is not shown. One index serves validation (links, `:ref`, `applies-to`
 * and `depends-on`) and reads (which rules apply), so the two agree on what an id names.
 *
 * Nothing here decides who may see a block: a read still hides included text an agent may not see.
 */

/** Where a block that gives an id sits. */
export interface IdSite {
  /** `''` for the document itself, else the included file's path relative to the document. */
  file: string;
  /** Zero-based line in `file`. */
  line: number;
  /** False for a heading's slug, which changes with its text. */
  stable: boolean;
}

export interface DocumentIds {
  /** Every id of the document and of what its includes show, with each block that gives it in document order. */
  owners: ReadonlyMap<string, readonly IdSite[]>;
  /** Zero-based lines of the document that are the fallback text of an include that was read, so not shown. */
  fallback: ReadonlyArray<readonly [number, number]>;
}

const within = (line: number, ranges: ReadonlyArray<readonly [number, number]>) => ranges.some(([a, b]) => line >= a && line <= b);

/**
 * The ids `text` gives with its includes read through `readFile`. Without a reader, or without includes, they are its
 * own ids. An include that cannot be read shows its fallback text, so the ids there count; once it is read they don't.
 */
export function documentIdIndex(text: string, readFile?: (relativePath: string) => string | undefined): DocumentIds {
  const owners = new Map<string, IdSite[]>();
  const add = (id: string, site: IdSite) => {
    const list = owners.get(id);
    if (list) list.push(site);
    else owners.set(id, [site]);
  };
  const lines = text.split(/\r?\n/);
  const spec = specVersion(parseFrontMatter(text).data);
  const source = includeSource(readFile);
  const fallback = readFile && /include/i.test(text) ? readIncludes(lines, parseFrontMatter(text).bodyStartLine, lines.length - 1, rootScope(text), spec, source, add) : [];
  // The document's own ids first, then the included ones. An id two blocks give is ambiguous wherever they sit.
  const own = new Map<string, IdSite[]>();
  for (const [id, blocks] of idOwners(text)) {
    const shown = blocks.filter((b) => !within(b.line, fallback)).map((b) => ({ file: '', line: b.line, stable: b.stable }));
    if (shown.length) own.set(id, shown);
  }
  for (const [id, sites] of owners) own.set(id, [...(own.get(id) ?? []), ...sites]);
  return { owners: own, fallback };
}

/**
 * Read the includes in lines [from, to] of a file, adding the ids of what they show, and return the fallback lines of
 * those that were read. Nested includes are read the same way, relative to the file they are written in.
 */
function readIncludes(
  lines: string[], from: number, to: number, scope: IncludeScope, spec: SpecVersion,
  source: ReturnType<typeof includeSource>, add: (id: string, site: IdSite) => void,
): Array<[number, number]> {
  const fallback: Array<[number, number]> = [];
  for (const block of findIncludes(lines, from, to, spec)) {
    const request = includeRequest(block.info.attrs.values);
    if (!request) continue;
    const result = loadInclude(request, scope, source);
    if (!result.ok) continue;
    const end = containerEnd(lines, block.line, spec, from);
    if (end > block.line + 1) fallback.push([block.line + 1, end - 1]);
    const inc = result.include;
    const incText = inc.lines.join('\n');
    const nested = readIncludes(inc.lines, inc.start, inc.end, innerScope(scope, inc), spec, source, add);
    for (const [id, blocks] of idOwners(incText)) {
      for (const b of blocks) {
        if (b.line >= inc.start && b.line <= inc.end && !within(b.line, nested)) add(id, { file: inc.path, line: b.line, stable: b.stable });
      }
    }
  }
  return fallback;
}

/** What `id` names in the document with its includes read: one block, several (ambiguous) or none. */
export function resolveDocumentId(index: DocumentIds, id: string):
  | { status: 'resolved'; site: IdSite }
  | { status: 'ambiguous'; sites: readonly IdSite[] }
  | { status: 'missing' } {
  const sites = index.owners.get(id);
  if (!sites?.length) return { status: 'missing' };
  return sites.length > 1 ? { status: 'ambiguous', sites } : { status: 'resolved', site: sites[0] };
}
