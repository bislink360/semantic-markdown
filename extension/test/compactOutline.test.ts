import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outline, readSmd } from '../src/core';
import { parseOutline } from './eval/outlineUse';

/** The compact outline that `smd read` returns for a long document (4.1.0). */

const doc = [
  '---', 'smd: 2', 'title: Plan', 'summary: What we build.', '---', '',
  '## Overview', '', 'Text '.repeat(400), '',
  '## Rules', '', ':::decision{status=accepted} Use one store', 'Body.', ':::', '',
  '### Limits', '', 'More text '.repeat(400), '',
].join('\n');

test('the compact outline has one unpadded row per heading with range, level, cost and notes, and a short footer', () => {
  const text = outline(doc, { compactOutline: true });
  const rows = text.split('\n').filter((l) => /^\d+-\d+ /.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^7-10 ## Overview ≈\d+$/);
  assert.match(rows[1], /^11-20 ## Rules ≈\d+ decision$/);
  assert.match(rows[2], /^17-20 ### Limits ≈\d+$/);
  assert.ok(!/ {2}/.test(rows.join('\n')), 'no column padding');
  assert.match(text, /\nRead: smd agent <file> --section "<heading>"\n$/);
  assert.match(text, /^Plan · /);
  assert.match(text, /\nsummary: What we build\.\n/);
});

test('smd read returns the compact outline over its budget, and the aligned table stays the default of outline()', () => {
  const r = readSmd(doc, { maxTokens: 50 });
  assert.equal(r.shown, 'outline');
  assert.match(r.text, /^11-20 ## Rules ≈\d+ decision$/m);
  assert.match(outline(doc), /^L11-20 {2,}## Rules/m);
});

test('the outline-use parser reads both outline forms the same way', () => {
  const compact = parseOutline(outline(doc, { compactOutline: true }));
  const aligned = parseOutline(outline(doc));
  assert.deepEqual(compact, aligned);
  assert.deepEqual(compact?.map((r) => [r.lines, r.level, r.heading]), [[[7, 10], 2, 'Overview'], [[11, 20], 2, 'Rules'], [[17, 20], 3, 'Limits']]);
});
