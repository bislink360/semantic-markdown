import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSmd } from '../src/core';

/** Rules that sit where agent views leave text out (4.1.0): `audience/rule-in-skip` and `audience/normative-in-skip`. */

const codes = (text: string) => validateSmd(text).filter((d) => d.code.startsWith('audience/')).map((d) => [d.code, d.line + 1, d.severity]);

test('a constraint, danger, requirement or accepted decision in a section for people is a warning', () => {
  const text = [
    '---', 'smd: 2', '---', '',
    '## Work', '', 'Work text.', '',
    '## History {agent=skip}', '',
    ':::constraint{#C1} Old rule', 'Keep it.', ':::', '',
    ':::danger Careful', 'Never do this.', ':::', '',
    ':::decision{#D1 status=accepted} Chosen', 'We chose it.', ':::', '',
    ':::decision{#D2 status=rejected} Not chosen', 'We did not.', ':::', '',
  ].join('\n');
  assert.deepEqual(codes(text), [
    ['audience/rule-in-skip', 11, 'warning'],
    ['audience/rule-in-skip', 15, 'warning'],
    ['audience/rule-in-skip', 19, 'warning'],
  ]);
});

test('a rule inside a :::human block is flagged as well', () => {
  const text = ['---', 'smd: 2', '---', '', '## Work', '', ':::human', ':::requirement{#R1} For people', 'Body.', ':::', ':::', ''].join('\n');
  assert.deepEqual(codes(text), [['audience/rule-in-skip', 8, 'warning']]);
  assert.match(validateSmd(text).find((d) => d.code === 'audience/rule-in-skip')!.message, /the :::human block at line 7/);
});

test('prose that reads like a rule in a section for people is one info per section', () => {
  const text = [
    '---', 'smd: 2', '---', '',
    '## Background {agent=skip}', '',
    'The old script was retired and should not be used even if you find it.', '',
    'Never run it twice either.', '',
    '## Work', '', 'You must not skip the check.', '',
  ].join('\n');
  assert.deepEqual(codes(text), [['audience/normative-in-skip', 7, 'info']]);
});

test('text outside people-only parts, code, and :::agent blocks (warned about on their own) stay quiet', () => {
  const text = [
    '---', 'smd: 2', '---', '',
    '## Work', '', 'Never skip the check.', '',
    '## Notes {agent=skip}', '', '```', 'never in code', '```', '',
    ':::agent', 'Do not touch this.', ':::', '',
  ].join('\n');
  assert.deepEqual(codes(text), []);
  assert.ok(validateSmd(text).some((d) => d.code === 'container/agent-in-skip'));
});
