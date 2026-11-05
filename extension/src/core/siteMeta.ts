import { escapeHtml } from './attrs';
import type { SitePage } from './siteNav';

/**
 * What search engines, link previews and AI tools read about a built site: the `<head>` tags of each page
 * (description, Open Graph, Twitter card, canonical link), `sitemap.xml`, `robots.txt` and `llms.txt`.
 */

/** The site's public address, `https://example.com/docs/`, from `--url`, else from an absolute `--base`. */
export function siteUrl(url?: string, base?: string): string | undefined {
  for (const candidate of [url, base]) {
    const trimmed = candidate?.trim();
    if (trimmed && isHttpUrl(trimmed)) return trimmed.endsWith('/') ? trimmed : trimmed + '/';
  }
  return undefined;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^/\s]+/i.test(value.trim());
}

/** A page's public address: `index.html` pages are addressed by their folder. */
export function pageUrl(root: string, output: string): string {
  const path = output.replace(/(?:^|\/)index\.html$/, (m) => (m.startsWith('/') ? '/' : ''));
  return root + path.split('/').map(encodeURIComponent).join('/');
}

/** The social image as an absolute URL: as given, or resolved against the site URL; none without one. */
export function imageUrl(image: string | undefined, root: string | undefined): string | undefined {
  const trimmed = image?.trim();
  if (!trimmed) return undefined;
  if (isHttpUrl(trimmed)) return trimmed;
  return root ? root + trimmed.replace(/^\.?\//, '') : undefined;
}

/** A description on one line, as search results and link previews show it. */
export function plainDescription(text: string | null | undefined): string | undefined {
  const flat = text?.replace(/\s+/g, ' ').trim();
  return flat || undefined;
}

export interface HeadMeta {
  title: string;
  siteTitle: string;
  description?: string;
  /** The page's public address, when the site URL is known. */
  url?: string;
  image?: string;
}

/** The `<head>` lines after `<title>`: description, canonical link, Open Graph and Twitter card. */
export function headMetaHtml(meta: HeadMeta): string {
  const lines: string[] = [];
  const tag = (attr: string, key: string, value: string) => lines.push(`<meta ${attr}="${key}" content="${escapeHtml(value)}">`);
  if (meta.description) tag('name', 'description', meta.description);
  if (meta.url) lines.push(`<link rel="canonical" href="${escapeHtml(meta.url)}">`);
  tag('property', 'og:type', 'website');
  tag('property', 'og:site_name', meta.siteTitle);
  tag('property', 'og:title', meta.title);
  if (meta.description) tag('property', 'og:description', meta.description);
  if (meta.url) tag('property', 'og:url', meta.url);
  if (meta.image) tag('property', 'og:image', meta.image);
  tag('name', 'twitter:card', meta.image ? 'summary_large_image' : 'summary');
  return lines.join('\n') + '\n';
}

/** Every page of the site, for search engines. */
export function sitemapXml(root: string, pages: SitePage[]): string {
  const urls = pages.map((p) => `  <url><loc>${escapeHtml(pageUrl(root, p.output))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/**
 * `robots.txt` pointing crawlers at the sitemap. Crawlers read it only at the root of a host, so it is written
 * only for a site served from one (not for a project page such as `https://user.github.io/project/`).
 */
export function robotsTxt(root: string): string | undefined {
  if (new URL(root).pathname !== '/') return undefined;
  return `User-agent: *\nAllow: /\n\nSitemap: ${root}sitemap.xml\n`;
}

export interface LlmsPage { title: string; href: string; summary?: string }

/** `llms.txt` (llmstxt.org): the site's title, summary and a linked list of its documents for AI tools. */
export function llmsTxt(title: string, summary: string | undefined, pages: LlmsPage[]): string {
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
  const intro = summary ? `\n> ${oneLine(summary)}\n` : '';
  const items = pages.map((p) => `- [${oneLine(p.title).replace(/[[\]]/g, '\\$&')}](${p.href})${p.summary ? `: ${oneLine(p.summary)}` : ''}`);
  return `# ${oneLine(title)}\n${intro}\n## Documents\n\n${items.join('\n')}\n`;
}
