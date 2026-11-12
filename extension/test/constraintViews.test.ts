import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, readSmd, type DocumentRead } from '../src/core';
import { CLOSURE_LIMITS } from '../src/core/graph';
import { readDocument } from '../src/readView';

/**
 * Constraint applicability and mandatory dependencies in section views and budgets (semantic tags "Constraint",
 * feedback loop "Dependencies", research contract "Scope and applicability"; R25 to R29, AC6 to AC8, AF13 to AF17,
 * AC-C).
 */

const FILES: Record<string, string> = {
  'rules.smd': [
    '---', 'smd: 2', '---', '',
    ':::constraint{#C9} Refunds go through the ledger', 'LEDGER_BODY, unless the amount is zero.', ':::', '',
  ].join('\n'),
  'global.smd': ['---', 'smd: 2', '---', '', ':::constraint{#CG scope=document} Included document rule', 'GLOBAL_BODY', ':::', ''].join('\n'),
};
const readFile = (p: string) => FILES[p];

const DOC = [
  '---', 'smd: 2', 'title: Payments plan', '---', '',
  ':::agent', 'AGENT_TEXT', ':::', '',
  ':::constraint{#C0} Above the first heading', 'TOP_BODY', ':::', '',
  '## Overview {#overview}', '',
  ':::constraint{#C1 scope=document} Stay in the workspace', 'DOC_BODY', ':::', '',
  'Overview text.', '',
  '## Payments {#payments}', '',
  ':::include{file="rules.smd"}', ':::', '',
  ':::constraint{#C2} Payments only', 'PAY_BODY', ':::', '',
  ':::danger Never drop the ledger', 'DANGER_BODY', ':::', '',
  '### Refunds {#refunds}', '',
  ':::requirement{#R1} Refund within a day', 'R1_BODY', ':::', '',
  '## Elsewhere {#elsewhere}', '',
  ':::include{file="global.smd"}', ':::', '',
  ':::constraint{#C3 applies-to=R1 level=should} Refunds are logged', 'APPLIES_BODY', ':::', '',
  ':::constraint{#C4 applies-to=payments} Payments heading rule', 'HEADING_BODY', ':::', '',
  ':::constraint{#C5} Elsewhere only', 'ELSE_BODY', ':::', '',
  '## Notes {agent=skip}', '',
  ':::constraint{#C6 scope=document} Skipped rule', 'SKIP_BODY', ':::', '',
  '## People', '',
  '::::human', ':::constraint{#C7 scope=document} Human rule', 'HUMAN_BODY', ':::', '::::', '',
  'People text.', '',
].join('\n');

const lineOf = (text: string) => DOC.split('\n').indexOf(text) + 1;
const view = (sections?: string[], options = {}) => agentView(DOC, { readFile, file: 'plan.smd', ...(sections ? { sections } : {}), ...options });
const head = (text: string) => /Constraints that apply here:\n([\s\S]*?)\n\n/.exec(text)?.[1] ?? '';
const count = (text: string, word: string) => text.split(word).length - 1;

test('R25: a scope=document constraint is in every section view, in full and with its line', () => {
  for (const section of ['Refunds', 'Elsewhere', 'People']) {
    const text = head(view([section]).text);
    assert.match(text, new RegExp(`^<constraint id="C1" scope="document" level="must"> Stay in the workspace \\[L${lineOf(':::constraint{#C1 scope=document} Stay in the workspace')}\\]\\nDOC_BODY\\n</constraint>`, 'm'));
  }
  assert.doesNotMatch(head(view(['Overview']).text), /DOC_BODY/, 'shown in place in its own section');
  assert.equal(count(view(['Overview']).text, 'DOC_BODY'), 1);
});

test('R25: a scope=document constraint in an included file applies to the including document', () => {
  const text = head(view(['Refunds']).text);
  assert.match(text, /<included file="global.smd">\n<constraint id="CG" scope="document" level="must"> Included document rule \[L5\]\nGLOBAL_BODY\n<\/constraint>\n<\/included>/);
});

test('R26/AC7: a section constraint applies to its section and subsections, also from an include, and not elsewhere', () => {
  const refunds = head(view(['Refunds']).text);
  assert.match(refunds, /<constraint id="C2" level="must"> Payments only \[L\d+\]\nPAY_BODY/);
  assert.match(refunds, /<included file="rules.smd">\n<constraint id="C9" level="must"> Refunds go through the ledger \[L5\]\nLEDGER_BODY/);
  const elsewhere = view(['Elsewhere']).text;
  assert.doesNotMatch(elsewhere, /PAY_BODY|LEDGER_BODY/);
  const payments = view(['Payments']).text;
  assert.doesNotMatch(payments, /Constraints that apply here:[\s\S]*PAY_BODY[\s\S]*## Payments/);
  assert.equal(count(payments, 'PAY_BODY'), 1);
  assert.equal(count(payments, 'LEDGER_BODY'), 1);
});

test('R27/AC8: applies-to brings a constraint into views that show its target block or part of its target section', () => {
  const refunds = head(view(['Refunds']).text);
  assert.match(refunds, /<constraint id="C3" applies-to="R1" level="should"> Refunds are logged \[L\d+\]\nAPPLIES_BODY/);
  assert.match(refunds, /<constraint id="C4" applies-to="payments" level="must"> Payments heading rule/);
  const overview = view(['Overview']).text;
  assert.doesNotMatch(overview, /APPLIES_BODY|HEADING_BODY/);
  assert.deepEqual(view(['Refunds']).mandatory?.constraints.map((c) => [c.id, c.applies]),
    [['C0', 'document'], ['C1', 'document'], ['C9', 'section'], ['C2', 'section'], ['CG', 'document'], ['C3', 'applies-to'], ['C4', 'applies-to']]);
});

test('R26: a scope=section constraint above the first heading applies to every view', () => {
  for (const section of ['Overview', 'Refunds', 'People']) assert.match(head(view([section]).text), /^<constraint id="C0" level="must"> Above the first heading \[L\d+\]\nTOP_BODY/m);
});

test('AF13: constraints in {agent=skip} sections and :::human blocks never appear', () => {
  for (const sections of [['Refunds'], ['People'], undefined]) {
    const text = view(sections).text;
    assert.doesNotMatch(text, /SKIP_BODY|HUMAN_BODY/);
  }
  assert.doesNotMatch(view(['Refunds'], { constraints: true }).text, /Skipped rule|Human rule/);
});

test('D6: the head blocks come in order: agent instructions, constraints, dependencies, dangers; the dangers block is unchanged', () => {
  const text = agentView(DOC.replace(':::requirement{#R1}', ':::requirement{#R1 depends-on=R9}'), { readFile, sections: ['Refunds'] }).text;
  const at = (s: string) => text.indexOf(s);
  assert.ok(at('Document-wide agent instructions:') >= 0);
  assert.ok(at('Document-wide agent instructions:') < at('Constraints that apply here:'));
  assert.ok(at('Constraints that apply here:') < at('Dependencies of the selected content:'));
  assert.ok(at('Dependencies of the selected content:') < at('Dangers elsewhere in the document:'));
  assert.ok(at('Dangers elsewhere in the document:') < at('### Refunds'));
  assert.match(text, /Dangers elsewhere in the document:\n<danger title="Never drop the ledger">\nDANGER_BODY\n<\/danger>\n\n### Refunds/);
});

test('R25: --brief keeps applying constraints whole', () => {
  const doc = DOC.replace('DOC_BODY', ':::details More\nDETAIL_BODY\n:::');
  const text = agentView(doc, { readFile, sections: ['Refunds'], brief: true }).text;
  assert.match(head(text), /Stay in the workspace \[L\d+\]\n<details title="More">\nDETAIL_BODY\n<\/details>\n<\/constraint>/);
});

test('R25: a whole-document view shows each constraint once, in place, with no head block', () => {
  const text = view().text;
  assert.doesNotMatch(text, /Constraints that apply here/);
  for (const word of ['TOP_BODY', 'DOC_BODY', 'PAY_BODY', 'LEDGER_BODY', 'GLOBAL_BODY', 'APPLIES_BODY', 'ELSE_BODY']) assert.equal(count(text, word), 1, word);
  assert.equal(view().mandatory?.complete, true);
});

test('AF17: provenance leaves the text unchanged and maps the applying constraints to their files and lines', () => {
  const traced = view(['Refunds'], { provenance: true });
  assert.equal(traced.text, view(['Refunds']).text);
  const spans = traced.provenance!.sourceMap;
  assert.ok(spans.some((s) => s.kind === 'source' && s.file === 'rules.smd' && s.source?.[0] === 5));
  assert.ok(spans.some((s) => s.kind === 'source' && s.file === 'plan.smd' && s.source?.[0] === lineOf(':::constraint{#C1 scope=document} Stay in the workspace')));
  assert.deepEqual(traced.provenance!.mandatory, traced.mandatory);
});

test('R25: a document without constraints or dependencies has no mandatory context', () => {
  const plain = agentView('---\nsmd: 2\n---\n\n## A\n\nThe word depends-on in prose.\n\n## B\n\nb', { sections: ['B'], provenance: true });
  assert.equal(plain.mandatory, undefined);
  assert.equal(Object.hasOwn(plain.provenance!, 'mandatory'), false);
});

test('R25: MCP-style reads with sections show the applying constraints', () => {
  const read = readDocument(DOC, { readFile, sections: ['Refunds'] });
  assert.match(read.text, /Constraints that apply here:[\s\S]*DOC_BODY[\s\S]*### Refunds/);
});

test('R28: --constraints points only at constraints that apply nowhere, as policy constraints/2', () => {
  const r = view(['Refunds'], { constraints: true });
  assert.equal(r.constraints?.policy, 'constraints/2');
  assert.match(r.text, /- constraint C5 "Elsewhere only" \[L\d+\] in "Elsewhere"/);
  assert.doesNotMatch(r.text, /- constraint C3|- constraint C1|- constraint C4/);
  assert.match(r.text, /Constraints that apply here:[\s\S]*Constraints elsewhere in the document:\n<danger/);
  const plain = agentView('---\nsmd: 2\n---\n\n## A\n\n:::warning W\nx\n:::\n\n## B\n\nb', { sections: ['B'], constraints: true });
  assert.equal(plain.constraints?.policy, 'constraints/1', 'a document without constraint blocks keeps constraints/1');
  assert.equal(view(['Refunds'], { constraints: true, provenance: true }).provenance?.constraints?.policy, 'constraints/2');
});

const DEPS = [
  '---', 'smd: 2', 'title: Deps', '---', '',
  '## Work', '',
  ':::requirement{#R1 depends-on=R2,R9} Refund quickly', 'R1_BODY', ':::', '',
  '- [ ] Ship it :depends[R4]', '',
  '## Basis', '',
  ':::requirement{#R2 depends-on=R3} Ledger exists', 'R2_BODY', ':::', '',
  ':::requirement{#R3 depends-on=R1} Cycle back', 'R3_BODY', ':::', '',
  ':::requirement{#R4} Task target', 'R4_BODY', ':::', '',
  '## Unrelated', '',
  ':::requirement{#R5} Not needed', 'R5_BODY', ':::', '',
].join('\n');

test('AF15: a section view adds the dependency closure of what it shows, with line refs', () => {
  const r = agentView(DEPS, { sections: ['Work'], file: 'deps.smd' });
  const deps = /Dependencies of the selected content:\n([\s\S]*?)\n\n/.exec(r.text)?.[1] ?? '';
  assert.match(deps, /^<requirement id="R2" status="proposed" depends-on="R3"> Ledger exists \[L16\]\nR2_BODY/m);
  assert.match(deps, /^<requirement id="R3" status="proposed" depends-on="R1"> Cycle back \[L20\]\nR3_BODY/m);
  assert.match(deps, /^<requirement id="R4" status="proposed"> Task target \[L24\]\nR4_BODY/m);
  assert.doesNotMatch(r.text, /R5_BODY/);
  assert.deepEqual(r.mandatory?.dependencies.map((d) => [d.id, d.via, d.depth]), [['R2', 'R1', 1], ['R3', 'R2', 2], ['R4', 'task "Ship it"', 1]]);
});

test('AF15/AF20: a cycle and a missing target are reported as unsatisfied and mark the view incomplete', () => {
  const r = agentView(DEPS, { sections: ['Work'], file: 'deps.smd', provenance: true });
  assert.match(r.text, /Not satisfied:\n- R3 depends on R1 \[L20\]: the chain returns to its start \(R1 → R2 → R3 → R1\)\n- R1 depends on R9 \[L8\]: no block has this id\n\[incomplete: 2 mandatory dependencies are not satisfied\]/);
  assert.equal(r.mandatory?.complete, false);
  assert.deepEqual(r.mandatory?.unsatisfied.map((u) => u.kind), ['cycle', 'missing']);
  assert.deepEqual(r.provenance?.mandatory, r.mandatory);
  assert.deepEqual(r.provenance?.omissions.filter((o) => o.kind === 'dependency').map((o) => o.lines), [[8, 8], [20, 20]]);
  assert.equal(agentView(DEPS, { sections: ['Work'], file: 'deps.smd' }).text, r.text, 'provenance leaves the text unchanged');
});

test('AF15: a dependency the view already shows is not repeated, and a whole view only reports what is unsatisfied', () => {
  const both = agentView(DEPS, { sections: ['Work', 'Basis'] }).text;
  assert.equal(count(both, 'R2_BODY'), 1);
  const whole = agentView(DEPS).text;
  assert.equal(count(whole, 'R2_BODY'), 1);
  assert.match(whole, /Dependencies of the selected content:\nNot satisfied:\n- R1 depends on R9 \[L8\]: no block has this id\n\[incomplete: 1 mandatory dependency is not satisfied\]/);
});

test('AF15: an applying constraint brings its own dependencies, and a constraint whose applies-to names a dependency applies', () => {
  const doc = DEPS.replace('## Unrelated', [
    '## Rules', '',
    ':::constraint{#C1 scope=document depends-on=R5} Needs R5', 'C1_BODY', ':::', '',
    ':::constraint{#C2 applies-to=R2} About the ledger', 'C2_BODY', ':::', '',
    '## Unrelated',
  ].join('\n'));
  const r = agentView(doc, { sections: ['Work'] });
  assert.match(r.text, /Constraints that apply here:\n<constraint id="C1"[^\n]*\nC1_BODY[\s\S]*<constraint id="C2"[^\n]*\nC2_BODY/);
  assert.match(r.text, /Dependencies of the selected content:[\s\S]*R5_BODY/);
  assert.deepEqual(r.mandatory?.constraints.map((c) => [c.id, c.applies]), [['C1', 'document'], ['C2', 'applies-to']]);
});

test('AF15: a dependency in an {agent=skip} section is not shown and is unsatisfied', () => {
  const doc = DEPS.replace('## Basis', '## Basis {agent=skip}');
  const r = agentView(doc, { sections: ['Work'] });
  assert.doesNotMatch(r.text, /R2_BODY/);
  assert.ok(r.mandatory?.unsatisfied.some((u) => u.kind === 'hidden' && u.target === 'R2'));
});

test('AF15: dependencies survive brief condensation', () => {
  const doc = DEPS.replace('R2_BODY', ':::details Why\nWHY_BODY\n:::');
  assert.match(agentView(doc, { sections: ['Work'], brief: true }).text, /WHY_BODY/);
});

// --- Budgets ------------------------------------------------------------------------------------------------------

const filler = (word: string) => Array.from({ length: 150 }, (_, i) => `${word}${i}`).join(' ');

test('AC6 (R25, R29): a scope=document constraint in section 1 stays in full when the budget cannot hold it and section 4', () => {
  const doc = [
    '---', 'smd: 2', '---', '',
    '## One', '', ':::constraint{#C1 scope=document} Workspace only', filler('rule'), ':::', '',
    '## Two', '', filler('two'), '', '## Three', '', filler('three'), '',
    '## Four', '', filler('four'), '',
  ].join('\n');
  const r = agentView(doc, { sections: ['Four'], maxTokens: 300 });
  assert.match(r.text, /Constraints that apply here:\n<constraint id="C1" scope="document" level="must"> Workspace only \[L7\]\nrule0 [\s\S]*rule149\n<\/constraint>/);
  assert.equal(r.budget?.fits, false);
  assert.match(r.text, /\[budget: ≈\d+ of 300 tokens, required content does not fit\]\n$/);
});

test('R29: under a budget a section with an applying constraint stays, and a section constraint goes with its section', () => {
  const doc = [
    '---', 'smd: 2', '---', '',
    '## Target', '', ':::requirement{#R1} Target', 'short', ':::', '',
    '## Document rule', '', ':::constraint{#C1 scope=document} Everywhere', filler('doc'), ':::', '',
    '## Linked rule', '', ':::constraint{#C2 applies-to=R1} Linked', filler('link'), ':::', '',
    '## Local rule', '', ':::constraint{#C3} Local', filler('local'), ':::', '',
    '## Plain', '', filler('plain'), '',
  ].join('\n');
  const r = agentView(doc, { maxTokens: 50 });
  const omitted = r.budget?.omitted.map((o) => o.heading);
  assert.deepEqual(omitted, ['Local rule', 'Plain']);
  assert.match(r.text, /\[section omitted: ## Local rule, L\d+-L\d+, ≈\d+ tokens, holds constraint — /);
  assert.match(r.text, /doc149/);
  assert.match(r.text, /link149/);
  // With its target unknown, the linked constraint is unplaced and stays, and the view says why (research contract,
  // 2026-11-10). Before that decision it could be omitted, which let a mistyped target switch the rule off.
  const unlinked = agentView(doc.replace('applies-to=R1', 'applies-to=R7'), { maxTokens: 50 });
  assert.ok(!unlinked.budget?.omitted.some((o) => o.heading === 'Linked rule'));
  assert.match(unlinked.text, /link149/);
  assert.equal(unlinked.mandatory?.complete, false);
});

test('AF15: under a budget the section of a dependency of kept content stays', () => {
  // A level-1 section is never omitted, so Work is kept and what it depends on stays.
  const doc = [
    '---', 'smd: 2', '---', '',
    '## Basis', '', ':::requirement{#R2} Basis', filler('basis'), ':::', '',
    '## Plain', '', filler('plain'), '',
    '# Work', '', ':::requirement{#R1 depends-on=R2} Work', 'short', ':::', '',
  ].join('\n');
  const r = agentView(doc, { maxTokens: 50 });
  assert.deepEqual(r.budget?.omitted.map((o) => o.heading), ['Plain']);
  assert.match(r.text, /basis149/);
  assert.equal(r.budget?.fits, false);
  // Without the dependency the larger Basis section goes first.
  assert.deepEqual(agentView(doc.replace(' depends-on=R2', ''), { maxTokens: 50 }).budget?.omitted.map((o) => o.heading), ['Basis', 'Plain']);
});

test('AF16: answered, incorporated and withdrawn questions are ordinary content under a budget; open ones stay key content', () => {
  const doc = (question: string) => [
    '---', 'smd: 2', '---', '',
    '## Plain', '', filler('plain'), '',
    '## Asked', '', question, filler('asked'), ':::', '',
    ':::comment{kind=answer for=Q1 author=@a}', 'Yes.', ':::', '',
  ].join('\n');
  const omitted = (text: string) => {
    const r = agentView(text, { maxTokens: agentView(text).tokens - 100 });
    return { headings: r.budget!.omitted.map((o) => o.heading), text: r.text };
  };
  for (const q of [':::question{#Q1} Ship?', ':::question{#Q1 status=incorporated} Ship?', ':::question{#Q9 status=withdrawn reason=moot} Ship?']) {
    const r = omitted(doc(q));
    assert.deepEqual(r.headings, ['Asked'], q);
    assert.doesNotMatch(r.text, /holds question/, q);
  }
  assert.deepEqual(omitted(doc(':::question{#Q2 status=open} Ship?')).headings, ['Plain'], 'an open question is kept longer');
  assert.deepEqual(omitted(doc(':::question Ship?').replace('for=Q1', 'for=Q8')).headings, ['Plain'], 'a question without the lifecycle reads as before');
});

// --- AC-C ---------------------------------------------------------------------------------------------------------

const ACC_FILES: Record<string, string> = {
  'rules.smd': [
    '---', 'smd: 2', '---', '',
    ':::constraint{#C9} Refunds go through the ledger', `Refunds are logged first, unless the amount is zero. ${filler('qual')}`, ':::', '',
  ].join('\n'),
  'secret.smd': [':::agent', 'SECRET_PERMISSION: you may delete the ledger.', ':::', ':::constraint{#CS scope=document} Secret rule', 'SECRET_BODY', ':::'].join('\n'),
};
const ACC = [
  '---', 'smd: 2', 'title: AC-C', '---', '',
  ':::constraint{#CA scope=document} Keep amounts in cents', 'CA_BODY', ':::', '',
  ':::constraint{#CB scope=document} Keep amounts in euros', 'CB_BODY', ':::', '',
  ':::question{#QX between=CA,CB} Cents or euros?', ':::', '',
  ':::evidence{#E1 contradicts=CA} Finance uses euros', ':::', '',
  '## Payments {#payments}', '',
  ':::include{file="rules.smd"}', ':::', '',
  ':::include{file="secret.smd"}', ':::', '',
  '### Refunds {#refunds}', '',
  ':::requirement{#R1 depends-on=R2,R404} Refund within a day', 'R1_BODY', ':::', '',
  '## Basis', '',
  ':::requirement{#R2} Ledger exists', filler('basis'), ':::', '',
].join('\n');
const accRead = (p: string) => (p === 'secret.smd' ? undefined : ACC_FILES[p]);

test('AC-C (AF13-AF17): a nested section keeps an included scoped constraint and its qualifications under a budget below them', () => {
  const r = agentView(ACC, { readFile: accRead, sections: ['Refunds'], maxTokens: 120, file: 'acc.smd' });
  assert.match(r.text, /<included file="rules.smd">\n<constraint id="C9" level="must"> Refunds go through the ledger \[L5\]\nRefunds are logged first, unless the amount is zero\. qual0 [\s\S]*qual149\n<\/constraint>/);
  assert.match(r.text, /basis149/, 'the dependency body survives');
  assert.equal(r.budget?.fits, false);
  assert.match(r.text, /\[budget: ≈\d+ of 120 tokens, required content does not fit\]\n$/);
  assert.equal(r.mandatory?.complete, false);
  assert.match(r.text, /- R1 depends on R404 \[L\d+\]: no block has this id/);
});

test('AC-C: conflicting constraints both stay visible and unresolved', () => {
  const r = agentView(ACC, { readFile: accRead, sections: ['Refunds'], file: 'acc.smd' });
  const text = head(r.text);
  assert.match(text, /<constraint id="CA" scope="document" level="must"> Keep amounts in cents \[L6\]\nCA_BODY/);
  assert.match(text, /<constraint id="CB" scope="document" level="must"> Keep amounts in euros \[L10\]\nCB_BODY/);
  assert.doesNotMatch(r.text, /superseded|winner|resolved/);
});

test('AC-C (AF17): an include the host denies grants nothing: its text is not shown and the view is incomplete', () => {
  const r = agentView(ACC, { readFile: accRead, sections: ['Refunds'], file: 'acc.smd', provenance: true });
  assert.doesNotMatch(r.text, /SECRET_PERMISSION|SECRET_BODY/);
  assert.equal(r.mandatory?.complete, false);
  const denied = r.mandatory?.unsatisfied.find((u) => u.kind === 'include');
  assert.deepEqual([denied?.target, denied?.line], ['secret.smd', 25]);
  assert.match(r.text, /- included file secret\.smd \[L25\]: not read \(cannot read the file\)/);
  assert.ok(r.provenance?.omissions.some((o) => o.kind === 'dependency' && o.lines[0] === 25));
  // Whole views report it too.
  assert.equal(agentView(ACC, { readFile: accRead }).mandatory?.complete, false);
});

// Constraints and dependencies bring each other in, in rounds (research contract "Scope and applicability", AF15).

/** R1 under Work, R2 to Rn under Prerequisites, and rules C1 to Cn: Ck applies to Rk and depends on Rk+1. */
const chain = (n: number) => [
  '---', 'smd: 2', 'title: Chain', '---', '',
  '## Work', '', ':::requirement{#R1} Do the work', 'R1_BODY', ':::', '',
  '## Prerequisites', '',
  ...Array.from({ length: n - 1 }, (_, i) => [`:::requirement{#R${i + 2}} Prerequisite ${i + 2}`, `R${i + 2}_BODY`, ':::', '']).flat(),
  '## Rules', '',
  ...Array.from({ length: n }, (_, i) => [`:::constraint{#C${i + 1} applies-to=R${i + 1}${i + 1 < n ? ` depends-on=R${i + 2}` : ''}} Rule ${i + 1}`, `C${i + 1}_BODY`, ':::', '']).flat(),
].join('\n');
const ids = (n: number, letter: string, from = 1) => Array.from({ length: n - from + 1 }, (_, i) => `${letter}${i + from}`);

test('AF15: a rule on a dependency that another rule added applies too, however long the chain', () => {
  for (const n of [3, 6]) {
    const r = agentView(chain(n), { sections: ['Work'] });
    assert.deepEqual(r.mandatory?.constraints.map((c) => c.id), ids(n, 'C'), `${n} rules`);
    assert.deepEqual(r.mandatory?.dependencies.map((d) => d.id).sort(), ids(n, 'R', 2).sort(), `${n - 1} dependencies`);
    assert.equal(r.mandatory?.complete, true);
    for (const id of [...ids(n, 'C'), ...ids(n, 'R')]) assert.equal(count(r.text, `${id}_BODY`), 1, `${id} is shown once`);
    // The head blocks keep their order: the rules, then the dependencies, then the section.
    const at = (word: string) => r.text.indexOf(word);
    assert.ok(at('Constraints that apply here:') < at(`C${n}_BODY`) && at(`C${n}_BODY`) < at('Dependencies of the selected content:'));
    assert.ok(at('Dependencies of the selected content:') < at(`R${n}_BODY`) && at(`R${n}_BODY`) < at('## Work'));
  }
  // A read that follows edges carries the last rule as well, and repeats nothing.
  const followed = readSmd(chain(3), { sections: ['Work'], follow: '*' });
  assert.equal(count(followed.text, 'C3_BODY'), 1);
  assert.equal(followed.mandatory?.complete, true);
});

test('AF15/AF20: a chain past the block limit is cut there, reported, and makes the view incomplete', () => {
  const r = agentView(chain(CLOSURE_LIMITS.blocks + 3), { sections: ['Work'] });
  assert.equal(r.mandatory?.dependencies.length, CLOSURE_LIMITS.blocks);
  assert.equal(r.mandatory?.complete, false);
  assert.ok(r.mandatory?.unsatisfied.some((u) => u.kind === 'limit'));
  assert.match(r.text, /\[incomplete: 1 mandatory dependency is not satisfied\]/);
});

const BASE = [
  '---', 'smd: 2', 'title: Base', '---', '',
  '## Shared', '',
  ':::requirement{#B1} Shared base', 'B1_BODY', ':::', '',
  ':::requirement{#B2} Second base', 'B2_BODY', ':::', '',
  '## Elsewhere', '',
  ':::requirement{#B9} Unrelated base', 'B9_BODY', ':::', '',
  '## Rules', '',
  ':::constraint{#X1 applies-to=B1 depends-on=B2} Rule on the base', 'X1_BODY', ':::', '',
  ':::constraint{#X2 applies-to=B2} Rule on the second base', 'X2_BODY', ':::', '',
  ':::constraint{#X3 applies-to=B9} Rule on the unrelated base', 'X3_BODY', ':::', '',
  '## Private {agent=skip}', '',
  ':::constraint{#X4 applies-to=B1} Skipped rule', 'X4_BODY', ':::', '',
  '## People', '',
  '::::human', ':::constraint{#X5 applies-to=B1} Human rule', 'X5_BODY', ':::', '::::', '',
].join('\n');
const SPEC = [
  '---', 'smd: 2', 'title: Spec', '---', '',
  '## Work', '', ':::requirement{#R1 depends-on=base.smd#B1} Do the work', 'R1_BODY', ':::', '',
  '## Rules', '',
  ':::constraint{#C1 applies-to=base.smd#B1} Local rule on the base', 'C1_BODY', ':::', '',
  ':::constraint{#C2 applies-to=base.smd#B9} Local rule on the unrelated base', 'C2_BODY', ':::', '',
  '## Other', '', 'Other text.', '',
].join('\n');
const baseReader = (p: string): DocumentRead => (p === 'base.smd' ? { text: BASE } : { status: 'missing' });

test('R19/AF15: a dependency read from another document brings the rules that name it, from that document and this one', () => {
  const r = agentView(SPEC, { file: 'docs/spec.smd', sections: ['Work'], readDocument: baseReader });
  assert.deepEqual(r.mandatory?.constraints.map((c) => [c.id, c.file, c.applies]), [
    ['C1', 'docs/spec.smd', 'applies-to'], ['X1', 'base.smd', 'applies-to'], ['X2', 'base.smd', 'applies-to'],
  ]);
  // X1 depends on B2, so B2 is a dependency, and X2 on B2 applies in turn.
  assert.deepEqual(r.mandatory?.dependencies.map((d) => d.id).sort(), ['B1', 'B2']);
  assert.equal(r.mandatory?.complete, true);
  assert.match(r.text, /Constraints that apply here:\n<constraint id="C1"[^\n]*\nC1_BODY\n<\/constraint>\n<included file="base\.smd">\n<constraint id="X1"[^\n]*\nX1_BODY\n<\/constraint>\n<\/included>\n<included file="base\.smd">\n<constraint id="X2"[^\n]*\nX2_BODY\n<\/constraint>\n<\/included>\n\nDependencies of the selected content:/);
  for (const body of ['C1_BODY', 'X1_BODY', 'X2_BODY', 'B1_BODY', 'B2_BODY']) assert.equal(count(r.text, body), 1, body);
  // Rules on blocks the view did not read, and rules for people only, stay out.
  assert.doesNotMatch(r.text, /C2_BODY|X3_BODY|X4_BODY|X5_BODY|B9_BODY/);
});

test('R19: a section that reads nothing from the other document carries none of its rules', () => {
  const r = agentView(SPEC, { file: 'docs/spec.smd', sections: ['Other'], readDocument: baseReader });
  assert.deepEqual(r.mandatory?.constraints ?? [], []);
  assert.doesNotMatch(r.text, /X\d_BODY|C\d_BODY/);
});

// A dependency the view adds is content of the view: it brings the rules of its own section and, from another
// document, that document's document-wide rules (research contract "Scope and applicability", decided 2026-11-10).

const HOME = [
  '---', 'smd: 2', 'title: Home', '---', '',
  '## Work', '', ':::requirement{#R1 depends-on=R2} Do the work', 'R1_BODY', ':::', '',
  '## Prerequisites {#prereqs}', '',
  ':::requirement{#R2} Prerequisite', 'R2_BODY', ':::', '',
  ':::constraint{#S1} Rule for the whole prerequisites section', 'S1_BODY', ':::', '',
  '### Detail', '', 'Detail text.', '',
  '## Rules', '',
  ':::constraint{#S2 applies-to=prereqs} Rule naming the prerequisites heading', 'S2_BODY', ':::', '',
  ':::constraint{#S3} Rule for the rules section only', 'S3_BODY', ':::', '',
  '## Notes {agent=skip}', '',
  ':::requirement{#R9} Hidden prerequisite', 'R9_BODY', ':::', '',
  ':::constraint{#S9} Rule beside a hidden prerequisite', 'S9_BODY', ':::', '',
  '## Other', '', ':::requirement{#R5 depends-on=R9} Needs the hidden one', 'R5_BODY', ':::', '',
].join('\n');

test('AF15 (2026-11-10): a dependency brings the section rules of the section it sits in, and rules on a heading above it', () => {
  const r = agentView(HOME, { sections: ['Work'] });
  assert.deepEqual(r.mandatory?.constraints.map((c) => [c.id, c.applies]), [['S1', 'section'], ['S2', 'applies-to']]);
  assert.deepEqual(r.mandatory?.dependencies.map((d) => d.id), ['R2']);
  assert.equal(r.mandatory?.complete, true);
  for (const body of ['S1_BODY', 'S2_BODY', 'R2_BODY']) assert.equal(count(r.text, body), 1, body);
  // A section rule elsewhere stays out.
  assert.doesNotMatch(r.text, /S3_BODY/);
  // The selected section's own view is unchanged when it adds nothing.
  assert.deepEqual(agentView(HOME, { sections: ['Rules'] }).mandatory?.constraints ?? [], []);
});

test('AF13/AF15 (2026-11-10): a dependency hidden from agents brings no rule of its section and leaves the view incomplete', () => {
  const r = agentView(HOME, { sections: ['Other'] });
  assert.doesNotMatch(r.text, /S9_BODY|R9_BODY/);
  assert.equal(r.mandatory?.complete, false);
  assert.ok(r.mandatory?.unsatisfied.some((u) => u.kind === 'hidden' && u.target === 'R9'));
});

const LIB = [
  '---', 'smd: 2', 'title: Library', '---', '',
  ':::constraint{#L0} Above the first heading', 'L0_BODY', ':::', '',
  '## Shared', '',
  ':::requirement{#B1} Shared base', 'B1_BODY', ':::', '',
  ':::constraint{#L1} Rule for the shared section', 'L1_BODY', ':::', '',
  '## Policy', '',
  ':::constraint{#L2 scope=document} Library-wide rule', 'L2_BODY', ':::', '',
  ':::constraint{#L3} Rule for the policy section only', 'L3_BODY', ':::', '',
  '## Private {agent=skip}', '',
  ':::constraint{#L4 scope=document} Skipped library-wide rule', 'L4_BODY', ':::', '',
].join('\n');
const USER = [
  '---', 'smd: 2', 'title: User', '---', '',
  '## Work', '', ':::requirement{#R1 depends-on=lib.smd#B1} Do the work', 'R1_BODY', ':::', '',
  '## Other', '', 'Other text.', '',
].join('\n');
const libReader = (p: string): DocumentRead => (p === 'lib.smd' ? { text: LIB } : { status: 'missing' });

test('R19/AF15 (2026-11-10): a dependency from another document brings its section rules and that document\'s document-wide rules', () => {
  const r = agentView(USER, { file: 'user.smd', sections: ['Work'], readDocument: libReader });
  assert.deepEqual(r.mandatory?.constraints.map((c) => [c.id, c.file, c.applies]), [
    ['L0', 'lib.smd', 'document'], ['L1', 'lib.smd', 'section'], ['L2', 'lib.smd', 'document'],
  ]);
  for (const body of ['L0_BODY', 'L1_BODY', 'L2_BODY', 'B1_BODY']) assert.equal(count(r.text, body), 1, body);
  assert.doesNotMatch(r.text, /L3_BODY|L4_BODY/);
  assert.equal(r.mandatory?.complete, true);
  // A section that reads nothing from the library carries none of its rules.
  assert.deepEqual(agentView(USER, { file: 'user.smd', sections: ['Other'], readDocument: libReader }).mandatory?.constraints ?? [], []);
});

// A constraint whose applies-to names nothing is unplaced: shown in every read, and every read is incomplete until an
// author fixes the target (research contract, decided 2026-11-10, option A).

const TYPO = [
  '---', 'smd: 2', 'title: Typo', '---', '',
  '## Work', '', ':::requirement{#R1} Do the work', 'R1_BODY', ':::', '',
  '## Rules', '',
  ':::constraint{#C9 applies-to=R99} Rule with a mistyped target', 'C9_BODY', ':::', '',
  ':::constraint{#C8 applies-to=R1,R98 level=should} Rule with one good and one bad target', 'C8_BODY', ':::', '',
  '## Other', '', 'Other text.', '',
  '## Notes {agent=skip}', '',
  ':::constraint{#C7 applies-to=R97} Skipped rule with a bad target', 'C7_BODY', ':::', '',
].join('\n');

test('NV-06: a constraint whose applies-to names nothing is shown in every section read and makes it incomplete', () => {
  for (const section of ['Work', 'Other']) {
    const r = agentView(TYPO, { sections: [section], file: 'typo.smd' });
    assert.equal(count(r.text, 'C9_BODY'), 1, `${section}: C9 shown once`);
    assert.equal(count(r.text, 'C8_BODY'), 1, `${section}: C8 shown once`);
    assert.equal(r.mandatory?.complete, false, section);
    assert.match(r.text, /- C9 applies to R99 \[L14\]: no block has this id, so the constraint is shown in every read/);
    assert.match(r.text, /- C8 applies to R98 \[L18\]: no block has this id, so the constraint is shown in every read/);
    // A rule for people only stays out, typo or not.
    assert.doesNotMatch(r.text, /C7_BODY|R97/);
  }
  const work = agentView(TYPO, { sections: ['Work'], file: 'typo.smd' });
  // C8 also names R1, which Work shows, so it applies for that reason. C9 applies only because its target is unknown.
  assert.deepEqual(work.mandatory?.constraints.map((c) => [c.id, c.applies]), [['C9', 'unplaced'], ['C8', 'applies-to']]);
  assert.deepEqual(agentView(TYPO, { sections: ['Other'] }).mandatory?.constraints.map((c) => [c.id, c.applies]), [['C9', 'unplaced'], ['C8', 'unplaced']]);
  assert.deepEqual(work.mandatory?.unsatisfied.map((u) => [u.kind, u.via, u.target]), [['unresolved-target', 'C9', 'R99'], ['unresolved-target', 'C8', 'R98']]);
});

test('NV-06: a whole view reports an unresolved target, and a budget never omits the section that holds the rule', () => {
  const whole = agentView(TYPO, { file: 'typo.smd' });
  assert.equal(count(whole.text, 'C9_BODY'), 1);
  assert.equal(whole.mandatory?.complete, false);
  assert.match(whole.text, /- C9 applies to R99 \[L14\]/);
  const tight = agentView(TYPO, { file: 'typo.smd', maxTokens: 1 });
  assert.match(tight.text, /C9_BODY/);
  assert.match(tight.text, /C8_BODY/);
});

test('NV-06: a target in another document that cannot be read is unresolved, and a resolved one is not', () => {
  const doc = TYPO.replace('applies-to=R99', 'applies-to=gone.smd#X1');
  const missing = agentView(doc, { file: 'typo.smd', sections: ['Other'], readDocument: () => ({ status: 'missing' }) });
  assert.match(missing.text, /- C9 applies to gone\.smd#X1 \[L14\]: no block has this id, so the constraint is shown in every read/);
  const denied = agentView(doc, { file: 'typo.smd', sections: ['Other'], readDocument: () => ({ status: 'denied' }) });
  assert.match(denied.text, /- C9 applies to gone\.smd#X1 \[L14\]: outside what the host allows, so the constraint is shown in every read/);
  // Once the target exists, the rule is placed again: it leaves reads that do not show its target.
  const fixed = TYPO.replace('applies-to=R99', 'applies-to=R1').replace('applies-to=R1,R98', 'applies-to=R1');
  const other = agentView(fixed, { sections: ['Other'] });
  assert.doesNotMatch(other.text, /C9_BODY|C8_BODY/);
  assert.equal(other.mandatory?.complete, true);
});
