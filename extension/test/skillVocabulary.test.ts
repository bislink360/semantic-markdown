import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINERS, INLINE_DIRECTIVES } from '../src/core/spec';

/**
 * The writer skill's rule "Only known names" is a closed list, so a block or directive that spec.ts defines and the
 * rule leaves out reads as a name the writer must not use. The list must name the whole vocabulary, and nothing else.
 */

const skill = readFileSync(join(__dirname, '..', '..', 'skills', 'semantic-markdown-writer', 'SKILL.md'), 'utf8');
const rule = skill.split('\n').find((line) => /^\d+\. \*\*Only known names\.\*\*/.test(line));

/** The names in code spans of `text`: `` `tabs`/`tab` `` is two names, and a file path such as `syntax/review.md` is none. */
const names = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]).sort((a, b) => a.localeCompare(b));
const sorted = (keys: string[]) => [...keys].sort((a, b) => a.localeCompare(b));

test('writer skill: the "Only known names" rule lists every block of the vocabulary', () => {
  assert.ok(rule, 'the writer SKILL.md has the "Only known names" rule on one line');
  const [blocks] = rule.split('Inline:');
  assert.deepEqual(names(blocks, /`([a-z][a-z-]*)`/g), sorted(Object.keys(CONTAINERS)));
});

test('writer skill: the "Only known names" rule lists every inline directive', () => {
  assert.ok(rule, 'the writer SKILL.md has the "Only known names" rule on one line');
  const inline = rule.split('Inline:')[1];
  assert.ok(inline, 'the rule has an "Inline:" part');
  assert.deepEqual(names(inline, /`:([a-z]+)`/g), sorted(Object.keys(INLINE_DIRECTIVES)));
});
