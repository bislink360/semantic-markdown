import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, validateSmd } from '../src/core';

/**
 * An accepted decision with `applies-to` is carried into the views of what it names, as a constraint is, and never by
 * scope (4.1.0). The running example of the view laws: D2 governs the cutover in R1.
 */

const doc = (d2: string) => [
  '---', 'smd: 2', 'title: Ledger', '---', '',
  '## Rules', '',
  ':::decision{#D1 status=superseded} Dual write', 'D1_BODY', ':::', '',
  d2, 'D2_BODY', ':::', '',
  ':::decision{#D3 status=accepted} Unlinked choice', 'D3_BODY', ':::', '',
  '## Cutover', '',
  ':::requirement{#R1 status=accepted} Switch writes', 'R1_BODY', ':::', '',
].join('\n');

test('an accepted decision with applies-to is carried into the section view of its target, under its own head word', () => {
  const r = agentView(doc(':::decision{#D2 status=accepted supersedes=D1 applies-to=R1} Single cutover'), { sections: ['Cutover'] });
  assert.match(r.text, /Constraints and decisions that apply here:\n<decision id="D2" status="accepted" applies-to="R1" supersedes="D1"> Single cutover[^\n]*\nD2_BODY/);
  assert.deepEqual(r.mandatory?.decisions?.map((d) => [d.id, d.applies]), [['D2', 'applies-to']]);
  assert.deepEqual(r.mandatory?.constraints, []);
  assert.equal(r.mandatory?.complete, true);
  // A decision without applies-to and a superseded one stay pointers or are left out, as before.
  assert.doesNotMatch(r.text, /D3_BODY|D1_BODY/);
});

test('a decision that is not accepted, or names nothing shown, is not carried', () => {
  const proposed = agentView(doc(':::decision{#D2 status=proposed applies-to=R1} Single cutover'), { sections: ['Cutover'] });
  assert.doesNotMatch(proposed.text, /D2_BODY/);
  assert.equal(proposed.mandatory?.decisions, undefined);
  const elsewhere = agentView(doc(':::decision{#D2 status=accepted applies-to=D1} Single cutover'), { sections: ['Cutover'] });
  assert.doesNotMatch(elsewhere.text, /D2_BODY/);
});

test('a document without linked decisions renders as before, with the constraints head word', () => {
  const plain = [
    '---', 'smd: 2', '---', '',
    '## Rules', '', ':::constraint{#C1 applies-to=R1} Rule', 'C1_BODY', ':::', '',
    ':::decision{#D3 status=accepted} Unlinked', 'D3_BODY', ':::', '',
    '## Work', '', ':::requirement{#R1} Work', 'R1_BODY', ':::', '',
  ].join('\n');
  const r = agentView(plain, { sections: ['Work'] });
  assert.match(r.text, /^Constraints that apply here:$/m);
  assert.doesNotMatch(r.text, /decisions that apply/);
  assert.equal(r.mandatory?.decisions, undefined);
});

test('a linked decision whose target is mistyped is unplaced: shown in every read, and the view is incomplete', () => {
  const r = agentView(doc(':::decision{#D2 status=accepted applies-to=R9} Single cutover'), { sections: ['Cutover'] });
  assert.match(r.text, /D2_BODY/);
  assert.deepEqual(r.mandatory?.decisions?.map((d) => d.applies), ['unplaced']);
  assert.equal(r.mandatory?.complete, false);
  assert.ok(r.mandatory?.unsatisfied.some((u) => u.kind === 'unresolved-target' && u.via === 'D2' && /decision is shown in every read/.test(u.reason)));
});

test('a linked decision on a target hidden from agents is carried with the hidden-target mark', () => {
  const text = [
    '---', 'smd: 2', '---', '',
    '## Work', '', ':::requirement{#R1 depends-on=R2} Work', 'R1_BODY', ':::', '',
    '## Basis {agent=skip}', '', ':::requirement{#R2} Hidden base', 'R2_BODY', ':::', '',
    '## Rules', '', ':::decision{#D2 status=accepted applies-to=R2} Choice on the base', 'D2_BODY', ':::', '',
  ].join('\n');
  const r = agentView(text, { sections: ['Work'] });
  assert.match(r.text, /<decision id="D2" status="accepted" applies-to="R2" hidden-target="R2">/);
  assert.deepEqual(r.mandatory?.decisions?.map((d) => d.hiddenTargets), [['R2']]);
});

test('the validator accepts applies-to on a decision and checks the ids it names', () => {
  const ok = validateSmd(doc(':::decision{#D2 status=accepted applies-to=R1} Single cutover'));
  assert.ok(!ok.some((d) => d.code === 'attrs/unknown'), JSON.stringify(ok));
  const bad = validateSmd(doc(':::decision{#D2 status=accepted applies-to=R9} Single cutover'));
  assert.ok(bad.some((d) => d.code === 'ref/unknown'), JSON.stringify(bad.map((d) => d.code)));
});
