import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, validateSmd } from '../src/core';
import { blockquoteToCallout } from '../src/core/refactors';

// 6.0.0: `> [!CAUTION]` stays GitHub's spelling of a danger (spec §3.8) and agent views carry it like one. The
// `alert/caution` hint asks authors for `:::danger` or `:::warning`, so the kind is written out.

const doc = [
  '---', 'smd: 2', '---', '',
  '## Work', '', 'Work text.', '',
  '## Reference', '',
  '> [!CAUTION]', '> Production keys live in the vault.', '',
  '> [!caution]', '> Lower case is an alert too.', '',
  '> [!WARNING]', '> Only slow.', '',
  '```', '> [!CAUTION]', '> In code, not an alert.', '```', '',
].join('\n');

test('alert/caution is an info on the marker of each [!CAUTION] alert, and nowhere else', () => {
  const found = validateSmd(doc).filter((d) => d.code === 'alert/caution');
  assert.deepEqual(found.map((d) => [d.line, d.column, d.endColumn, d.severity]), [[10, 2, 12, 'info'], [13, 2, 12, 'info']]);
  assert.match(found[0].message, /`:::danger` for a hard constraint or `:::warning` for a caveat/);
  // A hint, not an error: the document stays valid.
  assert.ok(!validateSmd(doc).some((d) => d.severity === 'error'));
});

test('a [!CAUTION] alert is still a danger: a section read of another section carries it', () => {
  const view = agentView(doc, { sections: ['Work'] }).text;
  assert.match(view, /Production keys live in the vault\./);
  assert.doesNotMatch(view, /Only slow\./);
});

test('the quick fixes rewrite the whole blockquote as :::danger, or as :::warning with the same body', () => {
  const quote = blockquoteToCallout(doc, 10)!;
  assert.equal(quote.type, 'danger');
  assert.deepEqual([quote.edit.startLine, quote.edit.endLine], [10, 11]);
  assert.deepEqual(quote.edit.lines, [':::danger', 'Production keys live in the vault.', ':::']);
  // The :::warning fix swaps only the opening line (see cautionFixes in language.ts).
  const warning = [':::warning', ...quote.edit.lines.slice(1)];
  const fixed = doc.split('\n');
  fixed.splice(10, 2, ...warning);
  assert.ok(!validateSmd(fixed.join('\n')).some((d) => d.code === 'alert/caution' && d.line === 10));
});
