/**
 * An id as an id attribute (`verifies=R1`) or `:ref[R1]` writes it: the id of a block of this document, or of a block
 * of another document, `other.smd#R1` (semantic tags R19). Only a relative path to a document (`.smd`, `.md`,
 * `.markdown`) before the `#` names another document; any other text with a `#` stays one id, as before.
 */
export interface IdTarget {
  /** The document's path as written, relative to the document it is written in; `''` for this document. */
  path: string;
  id: string;
}

const DOCUMENT_PATH = /\.(?:smd|md|markdown)$/i;
/** A scheme (`https:`, `javascript:`) or a protocol-relative `//host`: never a path to another document. */
const URL_START = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** What an id as written names: `other.smd#R1` is `R1` in `other.smd`, `R1` is `R1` here. */
export function splitIdRef(raw: string): IdTarget {
  const hash = raw.lastIndexOf('#');
  if (hash <= 0 || hash === raw.length - 1) return { path: '', id: raw };
  const path = raw.slice(0, hash);
  if (!DOCUMENT_PATH.test(path) || URL_START.test(path) || /\s/.test(path)) return { path: '', id: raw };
  return { path, id: raw.slice(hash + 1) };
}

/** The href of an id in another document, for rendered links: the path as written, then `#id`. */
export const idHref = (target: IdTarget): string => `${target.path}#${target.id}`;
