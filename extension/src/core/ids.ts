import { idOwners, parseSmd, type IdBlock } from './parse';

/**
 * Resolving an id of a document (research contract, "Identity"). Ids share one namespace per document: headings,
 * tasks, containers, figures and raw HTML (semantic tags R13). An id that two blocks give resolves to nothing and is
 * ambiguous, never to the first of them (R17). `:ref` to figures keeps its released first-match rule
 * (`figure/duplicate-id`), so it does not use this.
 */
export type IdResolution =
  /** One block gives the id. `stable` is false for a heading's slug, which changes with its text. */
  | { status: 'resolved'; line?: number; stable: boolean }
  /** Two or more blocks give the id, on these zero-based lines. */
  | { status: 'ambiguous'; lines: number[] }
  | { status: 'missing' };

/** What `id` names in a document: one block, several (ambiguous) or none. */
export function resolveId(text: string, id: string): IdResolution {
  const owners = idOwners(text).get(id);
  if (owners && owners.length > 1) return { status: 'ambiguous', lines: owners.map((o) => o.line) };
  if (owners) return { status: 'resolved', line: owners[0].line, stable: owners[0].stable };
  // Ids rendering makes up (footnotes) or gives outside the blocks (the front matter title) have no owner listed.
  return parseSmd(text).ids.has(id) ? { status: 'resolved', stable: true } : { status: 'missing' };
}

/** The ids that two or more blocks of a document give, with those blocks in document order. */
export function duplicateIds(text: string): Map<string, readonly IdBlock[]> {
  return new Map([...idOwners(text)].filter(([, owners]) => owners.length > 1));
}
