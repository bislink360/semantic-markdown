import { CDN_PINS } from './cdnPins';
import { escapeHtml } from './attrs';

/**
 * The CDN assets exported pages and sites load (improvement roadmap t-14, CL-08): the KaTeX stylesheet for math
 * and the Mermaid library for diagrams. Each is the exact version the extension bundles, with an integrity hash of
 * its bytes (scripts/cdn-pins.mjs writes them into cdnPins.ts at build time), so a page never picks up a new
 * release, and a browser refuses a file whose bytes differ.
 */

export interface CdnAsset {
  /** The npm package the file comes from. */
  package: string;
  /** The exact version, the one the extension bundles. */
  version: string;
  /** The file inside the package. */
  file: string;
  url: string;
  /** `sha384-…` of the file's bytes, for the tag's `integrity` attribute. */
  integrity: string;
}

/** The pinned assets, by the name the renderers use. Read-only build metadata for content policies and tests. */
export const CDN_ASSETS: Readonly<Record<keyof typeof CDN_PINS, CdnAsset>> = CDN_PINS;

/** What a rendered body needs from the CDN: the stylesheet when it has math, the library when it has diagrams. */
export function cdnNeeds(body: string): { math: boolean; diagrams: boolean } {
  return { math: body.includes('class="katex'), diagrams: body.includes('class="smd-mermaid"') };
}

/** The KaTeX stylesheet's `<link>`, pinned, with its hash and an anonymous cross-origin request. */
export function katexStylesheetTag(): string {
  const { url, integrity } = CDN_ASSETS.katexCss;
  return `<link rel="stylesheet" href="${url}" integrity="${integrity}" crossorigin="anonymous">\n`;
}

/** The Mermaid library's `<script>`, pinned, with its hash, an anonymous cross-origin request and the page's nonce. */
export function mermaidScriptTag(nonce?: string): string {
  const { url, integrity } = CDN_ASSETS.mermaidJs;
  const nonceAttr = nonce === undefined ? '' : ` nonce="${escapeHtml(nonce)}"`;
  return `<script${nonceAttr} src="${url}" integrity="${integrity}" crossorigin="anonymous"></script>\n`;
}
