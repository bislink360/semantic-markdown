import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

/**
 * Fixtures shared by the content policy tests (improvement roadmap t-12, t-14 and t-54): a document whose raw HTML
 * would run, embed or navigate if a page let it, and two local web servers, one standing in for the CDN on another
 * origin and one hosting the pages.
 */

/** Raw HTML that would run, embed or navigate if the page let it. Each part only sets a marker, so it is inert. */
export const HOSTILE = [
  '---', 'smd: 2', 'title: Print policy', '---', '',
  '# Print policy', '',
  '<script>window.__smdDocScript = 1</script>', '',
  '<p>Image <img id="bad-img" src="data:," onerror="window.__smdOnError = 1"> and <a id="js-link" href="javascript:window.__smdJsUrl = 1">link</a></p>', '',
  '<iframe id="frame" srcdoc="<script>parent.__smdSrcdoc = 1</script><p>inside</p>"></iframe>', '',
  '<object id="obj" data="data:text/html,<p>object</p>">object fallback</object>', '',
  '<embed id="emb" src="data:text/html,<p>embed</p>">', '',
  '<IFRAME\nsrc="data:text/html,x"></IFRAME>', '',
  '<meta http-equiv="refresh" content="1;url=data:text/html,moved">', '',
  '<base href="https://example.invalid/">', '',
  '<svg width="10" height="10"><script>window.__smdSvgScript = 1</script></svg>', '',
  '<form id="form" action="https://example.invalid/submit"><button>Send</button></form>', '',
  '<div id="raw" style="color: rgb(200, 0, 0)">Raw <b>bold</b> HTML</div>', '',
  '```mermaid', 'graph TD; A-->B', '```', '',
  'Math $x^2$ inline.', '',
].join('\n');

/** The markers HOSTILE's parts set when they run; under the policy each stays undefined. */
export const HOSTILE_MARKERS = ['docScript', 'onError', 'jsUrl', 'srcdoc', 'svgScript'] as const;

/** A page expression that reads the markers and what the page rendered, as JSON. */
export const HOSTILE_STATE = `JSON.stringify({
  href: location.href, base: document.baseURI,
  docScript: window.__smdDocScript, onError: window.__smdOnError, jsUrl: window.__smdJsUrl,
  srcdoc: window.__smdSrcdoc, svgScript: window.__smdSvgScript,
  frames: document.querySelectorAll('iframe, frame, object, embed, meta[http-equiv], base').length,
  ready: document.documentElement.getAttribute('data-smd-ready'),
  raw: getComputedStyle(document.getElementById('raw')).color,
  bold: !!document.querySelector('#raw b'),
  math: document.querySelectorAll('.katex').length,
  mermaidLoaded: typeof window.mermaid !== 'undefined',
  diagrams: document.querySelectorAll('.smd-diagram svg').length,
  styled: getComputedStyle(document.body).fontFamily !== '',
})`;

export interface LocalServer {
  origin: string;
  /** The requests it answered: path, and the `Origin` and `Sec-Fetch-Mode` headers they came with. */
  requests: Array<{ path: string; origin?: string; mode?: string }>;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml',
};

/** Serve `handler`'s answers on 127.0.0.1 at a free port. */
async function serve(handler: (path: string) => { body: Buffer; type: string } | undefined, headers: Record<string, string> = {}): Promise<LocalServer> {
  const requests: LocalServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    requests.push({ path, origin: req.headers.origin, mode: req.headers['sec-fetch-mode'] as string | undefined });
    const answer = handler(path);
    if (!answer) {
      res.writeHead(404, headers).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': answer.type, 'Cache-Control': 'no-store', ...headers }).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** A file under `root` for a URL path, or undefined when the path leaves it or names no file. */
function fileUnder(root: string, path: string): string | undefined {
  const file = normalize(join(root, path.replace(/\/$/, '/index.html')));
  if (file !== root && !file.startsWith(root + sep)) return undefined;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : undefined;
}

/** A host for the pages in `dir`, as a static web server would serve them. */
export function hostServer(dir: string): Promise<LocalServer> {
  return serve((path) => {
    const file = fileUnder(dir, path);
    return file ? { body: fs.readFileSync(file), type: TYPES[extname(file)] ?? 'application/octet-stream' } : undefined;
  });
}

/**
 * A stand-in for jsDelivr on another origin: `/npm/<package>@<version>/<file>` is that file of the package installed
 * in `nodeModules`, with `Access-Control-Allow-Origin: *` as jsDelivr sends it. Under `/tampered/` every file has
 * a comment appended, so its bytes no longer match a pinned hash. `/npm/unpinned.js` is a script nobody pinned.
 */
export function cdnServer(nodeModules: string): Promise<LocalServer> {
  return serve((path) => {
    if (path === '/npm/unpinned.js') return { body: Buffer.from('window.__smdUnpinned = 1;\n'), type: TYPES['.js'] };
    const tampered = path.startsWith('/tampered/');
    const match = /^\/npm\/((?:@[^/]+\/)?[^/@]+)@[^/]+\/(.+)$/.exec(tampered ? path.slice('/tampered'.length) : path);
    const file = match ? fileUnder(join(nodeModules, match[1]), `/${match[2]}`) : undefined;
    if (!file) return undefined;
    const bytes = fs.readFileSync(file);
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    return { body: tampered && /\.(js|css)$/.test(file) ? Buffer.concat([bytes, Buffer.from('\n/* changed */\n')]) : bytes, type };
  }, { 'Access-Control-Allow-Origin': '*' });
}

/** A page's CDN links pointed at the stand-in (`/tampered` after it for altered bytes). */
export const viaCdn = (html: string, cdn: LocalServer, prefix = ''): string => html.replaceAll('https://cdn.jsdelivr.net', cdn.origin + prefix);
