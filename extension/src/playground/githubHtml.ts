/**
 * Raw HTML in a `.md` file filtered the way GitHub filters it, for the playground's Compare tab: elements and
 * attributes outside GitHub's allowlist (from its html-pipeline sanitization filter) are removed, `id` and `name`
 * get GitHub's `user-content-` prefix, and links and images keep only the protocols GitHub keeps. So the GitHub
 * side shows `<span style="color:red">` as plain text, as github.com does.
 *
 * This is for fidelity, not safety. The Compare frame is sandboxed under a CSP that runs no document script
 * whatever this lets through (playground/README.md), so a tag this simple filter misreads costs accuracy only.
 */

const ELEMENTS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'br', 'b', 'i', 'strong', 'em', 'a', 'pre', 'code', 'img', 'tt',
  'div', 'ins', 'del', 'sup', 'sub', 'p', 'picture', 'ol', 'ul', 'table', 'thead', 'tbody', 'tfoot', 'blockquote',
  'dl', 'dt', 'dd', 'kbd', 'q', 'samp', 'var', 'hr', 'ruby', 'rt', 'rp', 'li', 'tr', 'td', 'th', 's', 'strike',
  'summary', 'details', 'caption', 'figure', 'figcaption', 'abbr', 'bdo', 'cite', 'dfn', 'mark', 'small', 'source',
  'span', 'time', 'wbr',
]);

/** Attributes any allowed element keeps. */
const COMMON = new Set([
  'abbr', 'accept', 'accept-charset', 'accesskey', 'action', 'align', 'alt', 'aria-describedby', 'aria-hidden',
  'aria-label', 'aria-labelledby', 'axis', 'border', 'char', 'charoff', 'charset', 'checked', 'clear', 'cols',
  'colspan', 'compact', 'coords', 'datetime', 'dir', 'disabled', 'enctype', 'for', 'frame', 'headers', 'height',
  'hreflang', 'hspace', 'id', 'ismap', 'itemprop', 'label', 'lang', 'maxlength', 'media', 'method', 'multiple',
  'name', 'nohref', 'noshade', 'nowrap', 'open', 'progress', 'prompt', 'readonly', 'rel', 'rev', 'role', 'rows',
  'rowspan', 'rules', 'scope', 'selected', 'shape', 'size', 'span', 'start', 'summary', 'tabindex', 'title', 'type',
  'usemap', 'valign', 'value', 'width',
]);

/** Attributes only some elements keep. */
const BY_ELEMENT: Record<string, ReadonlySet<string>> = {
  a: new Set(['href']),
  img: new Set(['src', 'longdesc']),
  div: new Set(['itemscope', 'itemtype']),
  blockquote: new Set(['cite']),
  del: new Set(['cite']),
  ins: new Set(['cite']),
  q: new Set(['cite']),
  source: new Set(['srcset']),
};

/** Elements removed with everything inside them, not just their tags. */
const DROP_WITH_CONTENT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>/g;
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** A link or image address GitHub keeps: its own protocols, or a relative address. */
function allowedUrl(value: string, protocols: readonly string[]): boolean {
  const scheme = /^\s*([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  return !scheme || protocols.includes(scheme[1].toLowerCase());
}

function attribute(element: string, name: string, value: string | undefined): string | undefined {
  const key = name.toLowerCase();
  if (!COMMON.has(key) && !BY_ELEMENT[element]?.has(key)) return undefined;
  if (value === undefined) return key;
  if (key === 'href' && !allowedUrl(value, ['http', 'https', 'mailto'])) return undefined;
  if ((key === 'src' || key === 'longdesc') && !allowedUrl(value, ['http', 'https'])) return undefined;
  const shown = key === 'id' || key === 'name' ? `user-content-${value}` : value;
  return `${key}="${escapeAttr(shown)}"`;
}

function tag(whole: string, close: string, name: string, attrs: string, selfClose: string): string {
  const element = name.toLowerCase();
  if (!ELEMENTS.has(element)) return '';
  if (close) return `</${element}>`;
  const kept = [...attrs.matchAll(ATTRIBUTE)]
    .map((m) => attribute(element, m[1], m[2] ?? m[3] ?? m[4]))
    .filter((a): a is string => a !== undefined);
  return `<${element}${kept.map((a) => ` ${a}`).join('')}${selfClose ? ' /' : ''}>`;
}

/** A piece of raw HTML (one markdown-it `html_block` or `html_inline` token) as GitHub would keep it. */
export function githubHtml(html: string): string {
  return html.replace(DROP_WITH_CONTENT, '').replace(COMMENT, '').replace(TAG, tag).replace(/<\/?(?:script|style)\b[^>]*>/gi, '');
}
