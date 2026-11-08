#!/usr/bin/env node
// Gathers the website's sources into one folder for `smd build`: the homepage and its pages (site/), and the user
// guide from docs/ (guides, reference and the images they show). Run by the Pages workflow:
//
//   node extension/scripts/stage-site.mjs --out <dir>
//
//   site/**             → <dir>/            the homepage, and the overview page of each docs folder
//   docs/guides/        → <dir>/guides/
//   docs/reference/     → <dir>/reference/
//   docs/images/        → <dir>/images/
//
// The docs folders keep their names and their places next to each other, so links between them work on the site
// as they do on GitHub. A relative link in a guide that leaves those folders (to an RFC, a package README, the
// changelog) would be dead on the site, so it is rewritten to the file on GitHub, on the main branch.
// Links inside code are examples and stay as they are.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GITHUB = 'https://github.com/bislink360/semantic-markdown';

/** Repository folders published on the site, and where they go in it. */
export const SECTIONS = [
  { from: 'docs/guides', to: 'guides' },
  { from: 'docs/reference', to: 'reference' },
  { from: 'docs/images', to: 'images' },
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Whether a repository path is published on the site (in one of SECTIONS). */
export function isPublished(repoPath) {
  return SECTIONS.some((s) => repoPath === s.from || repoPath.startsWith(s.from + '/'));
}

/**
 * The Markdown of a published document, with every relative link that leaves the site pointed at GitHub.
 * `file` is the document's repository path (`docs/guides/install.md`); `isDir` tells a folder from a file, which
 * GitHub shows under /tree/ and /blob/.
 * @param {string} text
 * @param {string} file
 * @param {(repoPath: string) => boolean} [isDir]
 * @returns {string}
 */
export function rewriteLinks(text, file, isDir = () => false) {
  let fence;
  return text.split('\n').map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      return line;
    }
    if (fence) return line;
    // Odd parts are inline code spans: leave those alone.
    return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : rewritePart(part, file, isDir))).join('');
  }).join('\n');
}

function rewritePart(text, file, isDir) {
  return text.replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (whole, target, title) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return whole;
    const hash = target.indexOf('#');
    const path = hash < 0 ? target : target.slice(0, hash);
    const anchor = hash < 0 ? '' : target.slice(hash);
    const repoPath = posix.normalize(posix.join(posix.dirname(file), path)).replace(/\/$/, '');
    if (!path || repoPath.startsWith('..') || isPublished(repoPath)) return whole;
    const kind = isDir(repoPath) ? 'tree' : 'blob';
    return `](${GITHUB}/${kind}/main/${repoPath}${anchor}${title})`;
  });
}

/**
 * Copies the sources into `out` (a new or empty folder) and rewrites the guides' links. Returns the files written.
 * @param {string} out
 * @param {string} [root]
 * @returns {string[]}
 */
export function stageSite(out, root = repoRoot) {
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty.`);
  cpSync(join(root, 'site'), out, { recursive: true });
  const isDir = (repoPath) => existsSync(join(root, repoPath)) && statSync(join(root, repoPath)).isDirectory();
  for (const section of SECTIONS) {
    const target = join(out, section.to);
    cpSync(join(root, section.from), target, { recursive: true });
    for (const file of filesIn(target).filter((f) => f.endsWith('.md'))) {
      const repoPath = `${section.from}/${relative(target, file).split(sep).join('/')}`;
      writeFileSync(file, rewriteLinks(readFileSync(file, 'utf8'), repoPath, isDir));
    }
  }
  return filesIn(out).map((f) => relative(out, f).split(sep).join('/')).sort();
}

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : undefined;
  if (!out) {
    console.error('Usage: node stage-site.mjs --out <dir>');
    process.exit(2);
  }
  try {
    const files = stageSite(resolve(out));
    console.log(`Staged ${files.length} file(s) into ${out}.`);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
