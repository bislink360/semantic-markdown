import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentView, findTaskView, formatTaskViewInspection, formatTaskViewList, taskView, TaskViewError, taskViewProblems, taskViews, validateSmd,
} from '../src/core';
import { runTaskView } from '../src/taskViewCommand';

const code = Array.from({ length: 20 }, (_, i) => `step ${i + 1}`);

const doc = [
  '---',
  'smd: 2',
  'title: Checkout',
  'views:',
  '  implement-r1:',
  '    description: Implement card payments',
  '    sections: [Goals]',
  '    query: "requirement[id=R1]"',
  '    mandatory: [R3]',
  '    optional: [AC1, R1]',
  '    budget: 2000',
  '    evidence: full',
  '  missing-dep:',
  '    mandatory: [R9, R3]',
  '---',
  '',
  ':::agent',
  'Never log card numbers.',
  ':::',
  '',
  '## Goals',
  '',
  'Make checkout fast.',
  '',
  '## Requirements',
  '',
  ':::requirement{#R1 status=accepted} Pay with a saved card',
  'The user can pay with a saved card.',
  ':::',
  '',
  ':::requirement{#R3 depends-on=A1} Show a receipt',
  'After payment the user sees a receipt.',
  '',
  '```text',
  ...code,
  '```',
  ':::',
  '',
  '## Constraints',
  '',
  ':::constraint{#C1 applies-to=R3} No full card numbers',
  'Receipts never show the full card number.',
  ':::',
  '',
  ':::assumption{#A1} Emails are fast',
  'Receipt emails arrive within a minute.',
  ':::',
  '',
  '## Acceptance',
  '',
  ':::acceptance{#AC1 verifies=R1} Saved card payment',
  'Given a saved card, when the user pays, then the order is placed.',
  ':::',
  '',
  '## Background',
  '',
  ...Array.from({ length: 30 }, (_, i) => `Background paragraph ${i + 1} with words that only cost tokens.`),
  '',
].join('\n');

const options = { file: 'plan.smd', today: '2026-11-07' };

test('AF14: a task view shows the author\'s sections, query and mandatory blocks, and optional blocks as pointers', () => {
  const r = taskView(doc, 'implement-r1', options);
  assert.match(r.text, /^\(task view "implement-r1" — sections: Goals; query: requirement\[id=R1\]; mandatory: R3\)$/m);
  assert.match(r.text, /Never log card numbers\./, 'document-wide agent instructions apply');
  assert.match(r.text, /Make checkout fast\./);
  assert.match(r.text, /The user can pay with a saved card\./, 'the query matches R1');
  assert.match(r.text, /After payment the user sees a receipt\./, 'R3 is mandatory');
  // The headings the blocks sit under are kept, so they read in place.
  assert.match(r.text, /^## Requirements {2}\[L25\]$/m);
  assert.doesNotMatch(r.text, /Background paragraph/, 'unselected sections stay out');
  assert.match(r.text, /^Optional context \(pointers, not read\):$/m);
  assert.match(r.text, /^-> AC1 {2}acceptance {2}Saved card payment {2}\[L70\] {2}§Acceptance {2}≈\d+ tokens — smd query "\*\[id=AC1\]" plan\.smd$/m);
  assert.match(r.text, /^-> R1 {2}requirement .*\(shown in this view\)$/m);
  assert.doesNotMatch(r.text, /Given a saved card/, 'an optional block is only a pointer');
  assert.equal(r.view.complete, true);
  assert.equal(r.view.policy.evidence, 'full');
  assert.equal(r.view.applied.evidence, 'full');
});

test('AF14: sections and flags the agent adds are recorded apart from the author\'s policy', () => {
  const r = taskView(doc, 'implement-r1', { ...options, sections: ['Background'], brief: true, maxTokens: 5000 });
  assert.match(r.text, /the agent added sections: Background\)$/m);
  assert.match(r.text, /Background paragraph 1 /);
  assert.deepEqual(r.view.policy.sections, ['Goals']);
  assert.deepEqual(r.view.agent, { sections: ['Background'], maxTokens: 5000, brief: true, exactSections: false, constraints: false });
  assert.deepEqual(r.view.applied.sections, ['Goals', 'Background']);
  assert.equal(r.view.applied.maxTokens, 5000);
  assert.equal(r.view.policy.budget, 2000);
});

test('AF15: mandatory blocks come with their dependency closure, and stay whole when the view is condensed', () => {
  const r = taskView(doc, 'implement-r1', { ...options, brief: true });
  assert.match(r.text, /Receipt emails arrive within a minute\./, 'A1: R3 depends on it');
  assert.match(r.text, /Receipts never show the full card number\./, 'C1 applies to R3');
  assert.match(r.text, /step 20/, 'a mandatory block\'s long code is not cut in brief views');
  assert.deepEqual(r.view.paths.map((p) => `${p.from.id} ${p.edge} ${p.to.id}`), ['R3 depends-on A1', 'R3 applies-to C1']);
});

test('AF15: a mandatory id that names nothing is unsatisfied, reported in the view, and the view is incomplete', () => {
  const r = taskView(doc, 'missing-dep', options);
  assert.match(r.text, /^Unsatisfied requirements of this view:$/m);
  assert.match(r.text, /^- mandatory "R9" names no block of this document$/m);
  assert.match(r.text, /^This view is incomplete: 1 requirement is unsatisfied\.$/m);
  assert.match(r.text, /After payment the user sees a receipt\./, 'what can be shown is still shown');
  assert.equal(r.view.complete, false);
  assert.deepEqual(r.view.mandatory.map((m) => `${m.id}:${m.status}`), ['R9:missing', 'R3:resolved']);
});

test('AF16: a budget below the mandatory content reports the overflow and drops none of it', () => {
  const small = doc.replace('    budget: 2000', '    budget: 60');
  const r = taskView(small, 'implement-r1', options);
  assert.ok(r.budget && !r.budget.fits);
  assert.match(r.text, /\[budget: ≈\d+ of 60 tokens, required content does not fit\]\n$/);
  assert.match(r.text, /step 20/);
  assert.match(r.text, /Receipt emails arrive within a minute\./);
  assert.equal(r.view.complete, false);
});

test('AF16: under a budget, sections outside the view are omitted before anything the view selected', () => {
  const r = taskView(doc, 'implement-r1', { ...options, sections: ['Background'], maxTokens: 450 });
  assert.match(r.text, /After payment the user sees a receipt\./);
  assert.match(r.text, /Make checkout fast\./);
});

test('AF23: the manifest records the author\'s policy and the agent\'s choices apart, with paths and what is unsatisfied', () => {
  const r = taskView(doc, 'missing-dep', { ...options, provenance: true, sections: ['Goals'] });
  const view = r.provenance?.view;
  assert.ok(view);
  assert.deepEqual(view.policy, { source: 'author', view: 'missing-dep', sections: [], query: null, mandatory: ['R9', 'R3'], optional: [], budget: null, evidence: 'pointers' });
  assert.deepEqual(view.agent.sections, ['Goals']);
  assert.equal(view.paths.length, 2);
  assert.equal(view.paths[0].line, 31, 'one-based line of the edge');
  assert.deepEqual(view.unsatisfied.map((u) => `${u.kind} ${u.target}`), ['missing R9']);
  assert.equal(view.complete, false);
  // A section the view shows only part of is not reported as left out whole, only the part it leaves out: here R1,
  // beside the pinned R3 (t-67).
  assert.deepEqual(r.provenance!.omissions.filter((o) => o.heading === 'Requirements').map((o) => o.lines), [[27, 29]]);
  assert.ok(r.provenance!.omissions.some((o) => o.kind === 'not-selected' && o.heading === 'Background'));
});

test('AF23: --inspect gives people an account of the view', () => {
  const out = formatTaskViewInspection(taskView(doc, 'missing-dep', { ...options, sections: ['Goals'] }), 'plan.smd');
  assert.match(out, /^Task view "missing-dep" of plan\.smd$/m);
  assert.match(out, /^ {2}mandatory: R9 \(missing\), R3 requirement "Show a receipt" L31-L56$/m);
  assert.match(out, /^The agent added: sections: Goals \(L21\)$/m);
  assert.match(out, /^ {2}R3 --depends-on \(L31\)-> A1 assumption "Emails are fast" L64-L66$/m);
  assert.match(out, /^ {2}R3 <-applies-to \(L60\)-- C1 constraint "No full card numbers" L60-L62$/m);
  assert.match(out, /^Complete: no\.$/m);
});

test('AF14: --views lists the views; an unknown view is an error that names them', () => {
  const list = formatTaskViewList(doc, 'plan.smd');
  assert.match(list, /^ {2}implement-r1 {2}Implement card payments — sections: Goals · query: requirement\[id=R1\] · 1 mandatory · 2 optional · budget 2000 · evidence in full$/m);
  assert.match(list, /^ {2}missing-dep {3}2 mandatory$/m);
  assert.throws(() => findTaskView(doc, 'implement-r2'), (e: unknown) => e instanceof TaskViewError && /Did you mean "implement-r1"\? Views: implement-r1, missing-dep\./.test(e.message));
  const out = runTaskView(doc, 'plan.smd', { view: 'nope' });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /Views: implement-r1, missing-dep/);
  assert.match(formatTaskViewList('# No views\n', 'a.smd'), /declares no task views/);
});

test('AF14: the CLI command prints the view and warns on stderr when it is incomplete', () => {
  const out = runTaskView(doc, 'plan.smd', { view: 'missing-dep', today: '2026-11-07' });
  assert.equal(out.code, 0);
  assert.match(out.stdout, /This view is incomplete/);
  assert.match(out.stderr, /warning: the view "missing-dep" is incomplete: 1 unsatisfied requirement/);
  const inspect = runTaskView(doc, 'plan.smd', { view: 'implement-r1', inspect: true });
  assert.match(inspect.stdout, /^Complete: yes\.$/m);
});

test('AF14: the agent view header names the views instead of printing them as JSON; documents without views are unchanged', () => {
  const header = agentView(doc, options).text.split('\n').slice(0, 3).join('\n');
  assert.match(header, /^views: implement-r1, missing-dep$/m);
  assert.doesNotMatch(header, /\{"/);
  const plain = doc.replace(/^views:[\s\S]*?(?=^---$)/m, '');
  assert.equal(agentView(plain, options).text, agentView(plain, { ...options, evidence: 'pointers' }).text);
  assert.doesNotMatch(agentView(plain, options).text, /views|task view/);
});

test('AF14: views are read leniently; a budget spelled as digits counts', () => {
  const text = '---\nsmd: 2\nviews:\n  a:\n    budget: "1500"\n    sections: Goals, and more\n    mandatory: "R1, R2"\n  b: nope\n---\n';
  assert.deepEqual(taskViews(text), [{ name: 'a', sections: ['Goals, and more'], mandatory: ['R1', 'R2'], optional: [], budget: 1500 }]);
});

test('AF14: the validator checks the views key', () => {
  const text = [
    '---', 'smd: 2', 'views:', '  a:', '    sections: [Goals, Nowhere]', '    query: "requirement[nope=1"', '    mandatory: [R1, R7, D]',
    '    optional: [AC2]', '    budget: -3', '    evidence: some', '    title: x', '  b: 3', '  c:', '    budget: "1500"', '---', '', '## Goals', '',
    ':::requirement{#R1} One', ':::', '', ':::decision{#D} First', ':::', '', ':::decision{#D} Second', ':::', '',
  ].join('\n');
  const found = taskViewProblems(text).map((p) => `${p.line}:${p.code}`);
  assert.deepEqual(found, [
    '4:views/section', '5:views/query', '6:ref/unknown', '6:ref/ambiguous', '7:ref/unknown', '8:views/value', '9:views/value', '10:views/key', '11:views/value',
  ]);
  const diagnostics = validateSmd(text);
  assert.ok(!diagnostics.some((d) => d.code === 'frontmatter/type'), 'views is a mapping, not a wrong type');
  const unknown = diagnostics.find((d) => d.code === 'ref/unknown')!;
  assert.equal(text.split('\n')[unknown.line].slice(unknown.column, unknown.endColumn), 'R7');
  // The sample's only problem is the id the missing-dep view names on purpose.
  assert.deepEqual(validateSmd(doc).filter((d) => d.code.startsWith('views/') || d.code.startsWith('ref/')).map((d) => `${d.line}:${d.code}`), ['13:ref/unknown']);
});

test('AC-C: a nested section that depends on a constraint from an include keeps it under a budget below the required bodies', () => {
  const main = [
    '---', 'smd: 2', 'title: Rollout', 'views:', '  canary:', '    sections: [Canary]', '    mandatory: [R1]', '    budget: 40', '---', '',
    '## Rollout', '', '### Canary', '', ':::requirement{#R1 depends-on=C9} Start with 1% of traffic', 'Route one percent of requests to the new build.', ':::', '',
    ':::include{file=rules.smd}', ':::', '', '### Full', '', ...Array.from({ length: 20 }, (_, i) => `Full rollout step ${i + 1}.`), '',
  ].join('\n');
  const rules = '---\nsmd: 2\n---\n\n:::constraint{#C2 scope=section} Keep the old build warm\nThe old build serves traffic until the canary passes.\n:::\n';
  const read = (p: string) => (p === 'rules.smd' ? rules : undefined);
  const r = taskView(main, 'canary', { file: 'rollout.smd', readFile: read, today: '2026-11-07' });
  // The included constraint and the requirement's body survive; the budget failure and the missing dependency are reported.
  assert.match(r.text, /The old build serves traffic until the canary passes\./);
  assert.match(r.text, /Route one percent of requests to the new build\./);
  assert.match(r.text, /\[budget: ≈\d+ of 40 tokens, required content does not fit\]\n$/);
  assert.match(r.text, /^- depends-on "C9" \(L15\) names nothing that exists$/m);
  assert.doesNotMatch(r.text, /Full rollout step/);
  assert.equal(r.view.complete, false);
  assert.ok(r.budget && !r.budget.fits);
});
