import { sha256Hex } from './sha256';

/**
 * The content policy for pages made from a document (improvement roadmap t-12 and t-54, CL-04): the page printed to
 * PDF, the page Export to HTML writes and the pages of a site. A document can carry raw HTML, and these pages run
 * in a real browser, so each loads under a content security policy that lets only its own scripts run: they carry
 * the page's nonce, and the document's scripts, event attributes and `javascript:` URLs don't. A policy can't stop
 * everything, so the document's frames, plug-ins and `<meta>` and `<base>` elements are also renamed to inert
 * elements before the page is written.
 */

/** Elements a document may not bring into the page; a policy alone doesn't cover `meta` refresh or `srcdoc`. */
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
 * The policy. Scripts need the page's nonce, so the page runtime, the site script and the pinned diagram library
 * (cdnAssets.ts) run and nothing the document wrote does. Styles, images, fonts and media load from the page's
 * folder, the web and `data:` URLs, so ordinary documents look as they did. Frames, plug-ins, workers, forms,
 * `<base>` and network requests from scripts are refused.
 */
export function contentPolicy(nonce: string): string {
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(nonce)) throw new Error('A page nonce needs at least 16 base64 characters.');
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

/** The `<meta>` that carries the policy, which goes right after `<meta charset>`. */
export const contentPolicyMeta = (nonce: string): string => `<meta http-equiv="Content-Security-Policy" content="${contentPolicy(nonce)}">\n`;

/** The nonce a page is first drafted with, before its own nonce is known. */
const DRAFT_NONCE = 'smd-draft-page-nonce';

/**
 * A page written to a file under the policy, with a nonce derived from the page itself: `render` drafts the page
 * with a placeholder, and the nonce is the first 128 bits of the draft's SHA-256. The same document then gives the
 * same page, so builds stay reproducible, and the document can't carry the nonce: it would have to contain the
 * hash of a text that contains it. The page is rendered again with the nonce rather than patched, so a document
 * that writes the placeholder gains nothing. PDF export prints a page nobody keeps and passes a random nonce instead.
 */
export function withPageNonce(render: (nonce: string) => string): string {
  return render(sha256Hex(render(DRAFT_NONCE)).slice(0, 32));
}
