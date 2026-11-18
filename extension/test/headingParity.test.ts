import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { headingAt, renameHeading } from '../src/core/anchors';
import { parseSmd, resetParseCache } from '../src/core/parse';
import { renderSmd } from '../src/core/render';

/**
 * The heading lookups of the editors (outline, the heading under the cursor, previews and heading rename) read the
 * cached parse instead of rendering the document (improvement roadmap t-16, CL-09). That holds only while the parse
 * gives the headings a render without a reader gives, so this checks every document of both corpora, the focused
 * fixtures and the samples. Lookups that resolve includes still render (includeCheck.ts, toMarkdown.ts).
 */

const root = join(__dirname, '..', '..');
const FOLDERS = ['extension/test/compat/corpus', 'research/data/corpus', 'extension/test/snapshots/fixtures', 'extension/test/samples', 'docs'];

function documents(): string[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...FOLDERS], { cwd: root, encoding: 'utf8' }); // NOSONAR(typescript:S4036): the maintainer's or CI runner's own git, as the snapshot harness runs it
  const files = listed.status === 0 ? listed.stdout.split('\0').filter((f) => /\.(smd|md)$/.test(f)) : [];
  if (files.length) return files;
  // Without Git, the folders as they are on disk.
  const walk = (dir: string): string[] => fs.readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return walk(`${dir}/${e.name}`);
    return /\.(smd|md)$/.test(e.name) ? [`${dir}/${e.name}`] : [];
  });
  return FOLDERS.filter((d) => fs.existsSync(join(root, d))).flatMap(walk);
}

test('t-16: parseSmd gives the headings renderSmd gives, for every document of both corpora, the fixtures, the samples and the docs', () => {
  const files = documents();
  assert.ok(files.length > 200, `${files.length} documents`);
  const differ: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(join(root, file), 'utf8');
    resetParseCache();
    const parsed = parseSmd(text).headings;
    const rendered = renderSmd(text).headings;
    if (JSON.stringify(parsed) !== JSON.stringify(rendered)) differ.push(file);
  }
  assert.deepEqual(differ, [], 'documents whose headings differ');
});

test('t-16: the heading under the cursor and a heading rename follow the parse, after edits too', () => {
  const text = '# Guide\n\n## Pricing rules\n\nSee [p](#pricing-rules).\n\n## Pricing rules\n';
  assert.deepEqual(headingAt(text, 2), { line: 2, start: 3, end: 16, text: 'Pricing rules', slug: 'pricing-rules' });
  assert.equal(headingAt(text, 6)?.slug, 'pricing-rules-1', 'repeats are numbered as the render numbers them');
  assert.equal(headingAt(text, 4), undefined);
  // An edit that changes which heading is the repeat: the parse cache must not answer for the old text.
  const edited = text.replace('## Pricing rules\n\nSee', '## Prices\n\nSee');
  assert.equal(headingAt(edited, 6)?.slug, 'pricing-rules');
  assert.deepEqual(renameHeading(text, 2, 'Prices')?.changes, [{ from: 'pricing-rules', to: 'prices' }, { from: 'pricing-rules-1', to: 'pricing-rules' }]);
});
