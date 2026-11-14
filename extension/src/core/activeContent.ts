/**
 * The content policy for a page printed to PDF (improvement roadmap t-12, CL-04). A document can carry raw HTML,
 * and the print page runs in a real browser, so the page loads under a content security policy that lets only
 * its own scripts run: they carry a fresh nonce, and the document's scripts, event attributes and `javascript:`
 * URLs don't. A policy can't stop everything, so the document's frames, plug-ins and `<meta>` and `<base>`
 * elements are also renamed to inert elements before the page is written.
 */

/** Elements a document may not bring into the print page; a policy alone doesn't cover `meta` refresh or `srcdoc`. */
export const BLOCKED_ELEMENTS = ['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe', 'meta', 'base'] as const;

/**
 * A start or end tag of a blocked element, as the HTML tokenizer reads one: `<` or `</`, the name in any case,
 * then whitespace, `/`, `>` or the end of the text. Attributes are left as they are: the renamed element has none
 * that do anything.
 */
const BLOCKED_TAG = new RegExp(`<(/?)(${BLOCKED_ELEMENTS.join('|')})(?=[\\t\\n\\f\\r />]|$)`, 'gi');

/** The prefix a blocked element's tag gets, which makes it an unknown, inert element (`<smd-blocked-iframe …>`). */
export const BLOCKED_PREFIX = 'smd-blocked-';

/** Rename the blocked elements in a document's rendered HTML, so frames, plug-ins, `meta` refresh and `base` do nothing. */
export function blockActiveContent(html: string): string {
  return html.replace(BLOCKED_TAG, (_tag, slash: string, name: string) => `<${slash}${BLOCKED_PREFIX}${name.toLowerCase()}`);
}

/**
 * The policy for the print page. Scripts need the page's nonce, so the page runtime and the diagram library run
 * and nothing the document wrote does. Styles, images, fonts and media load from the page's folder, the web and
 * `data:` URLs, so ordinary documents print as they look. Frames, plug-ins, workers, forms, `<base>` and network
 * requests from scripts are refused.
 */
export function printPolicy(nonce: string): string {
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(nonce)) throw new Error('A print nonce needs at least 16 base64 characters.');
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline' file: http: https: data:",
    'img-src file: http: https: data: blob:',
    'font-src file: http: https: data:',
    'media-src file: http: https: data: blob:',
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
