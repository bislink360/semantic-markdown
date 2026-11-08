// The Pages workflow's staging step (scripts/stage-site.mjs): the user guide's links that leave the site point at GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GITHUB, isPublished, rewriteLinks, stageSite } from '../scripts/stage-site.mjs';

const file = 'docs/guides/install.md';

test('links between published folders stay relative', () => {
  const text = 'See the [features](../reference/features.md#tasks), [setup](agent-setup.md) and ![shot](../images/01-overview.png).';
  assert.equal(rewriteLinks(text, file), text);
});

test('links that leave the site point at the file on GitHub, keeping the anchor and title', () => {
  assert.equal(
    rewriteLinks('[npm](../../npm/README.md#markdown-it-plugin "The plugin")', file),
    `[npm](${GITHUB}/blob/main/npm/README.md#markdown-it-plugin "The plugin")`,
  );
  assert.equal(rewriteLinks('[RFC](../rfcs/spec-v2.smd)', 'docs/reference/spec.md'), `[RFC](${GITHUB}/blob/main/docs/rfcs/spec-v2.smd)`);
});

test('folders use /tree/', () => {
  const isDir = (p: string) => p === 'integrations/tree-sitter-smd';
  assert.equal(rewriteLinks('[grammar](../../integrations/tree-sitter-smd/)', file, isDir), `[grammar](${GITHUB}/tree/main/integrations/tree-sitter-smd)`);
});

test('absolute, anchor-only and outside-the-repository links are left alone', () => {
  const text = '[a](https://example.com/x.md) [b](#install) [c](/abs.md) [d](mailto:x@example.com) [e](../../../outside.md)';
  assert.equal(rewriteLinks(text, file), text);
});

test('examples in code blocks and inline code are left alone', () => {
  const text = ['```markdown', '[draft](../gone.md)', '```', '`[x](../../npm/README.md)` and [y](../../SECURITY.md)'].join('\n');
  assert.equal(
    rewriteLinks(text, file),
    ['```markdown', '[draft](../gone.md)', '```', `\`[x](../../npm/README.md)\` and [y](${GITHUB}/blob/main/SECURITY.md)`].join('\n'),
  );
});

test('a longer fence is closed only by a fence at least as long', () => {
  const text = ['````markdown', '```', '[x](../../SECURITY.md)', '```', '````', '[y](../../SECURITY.md)'].join('\n');
  const out = rewriteLinks(text, file).split('\n');
  assert.equal(out[2], '[x](../../SECURITY.md)');
  assert.equal(out[5], `[y](${GITHUB}/blob/main/SECURITY.md)`);
});

test('only the guides, the reference and the images are published', () => {
  assert.ok(isPublished('docs/guides/install.md'));
  assert.ok(isPublished('docs/images'));
  assert.ok(!isPublished('docs/rfcs/spec-v2.smd'));
  assert.ok(!isPublished('docs/guidesX/a.md'));
});

test('stageSite gathers the homepage and the user guide, with no link left pointing outside', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'smd-stage-')), 'site');
  try {
    const files = stageSite(out);
    for (const expected of ['index.smd', 'guides/index.smd', 'guides/install.md', 'reference/features.md', 'reference/index.smd']) {
      assert.ok(files.includes(expected), `${expected} is staged`);
    }
    assert.ok(files.some((f) => f.startsWith('images/')));
    assert.ok(!existsSync(join(out, 'rfcs')));
    for (const page of files.filter((f) => f.endsWith('.md'))) {
      const leaving = rewriteLinks(readFileSync(join(out, page), 'utf8'), `docs/${page}`);
      assert.equal(leaving, readFileSync(join(out, page), 'utf8'), `${page} has no link left to rewrite`);
    }
    assert.throws(() => stageSite(out), /not empty/);
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});
