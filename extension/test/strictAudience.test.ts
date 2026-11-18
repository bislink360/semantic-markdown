import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentView, queryDocuments, queryView, querySmd, readSmd, renderSmd, taskView, validateSmd, withheldMatches } from '../src/core';
import { runQuery } from '../src/queryCommand';

/**
 * Strict audience filtering: audience exclusion takes precedence over every way of asking. A section marked
 * {agent=skip} (subsections included) and a `:::human` block are never in a normal agent view, whether the caller
 * named the section, a query matched a block in it, a task view pinned its lines or a dependency walk reached it.
 * The view records the exclusion, offers no command that would still exclude it, and is incomplete only when a
 * visible requirement depends on hidden content.
 */

const DOC = [
  '---', 'smd: 2', 'title: Audience', '---', '',
  ':::danger Visible danger', 'VISIBLE-DANGER stays whichever section is read.', ':::', '',
  '## Work', '',
  'Work prose WORK-TEXT.', '',
  ':::requirement{#R1 depends-on=R2} Needs the hidden base', 'R1-BODY', ':::', '',
  '## Notes {agent=skip}', '',
  'Notes prose NOTES-TEXT.', '',
  ':::agent', 'NOTES-AGENT', ':::', '',
  ':::danger Hidden danger', 'NOTES-DANGER', ':::', '',
  ':::requirement{#R2} Hidden base', 'R2-BODY', ':::', '',
  ':::include{file=part.smd}', ':::', '',
  '### Detail', '',
  'Detail prose DETAIL-TEXT.', '',
  ':::requirement{#R3} Nested hidden', 'R3-BODY', ':::', '',
  '## People', '',
  ':::human', 'HUMAN-TEXT', '', ':::requirement{#RH} Human requirement', 'RH-BODY', ':::', ':::', '',
  '## Later', '',
  'Later prose LATER-TEXT.', '',
  ':::requirement{#R5 depends-on=RH} Needs the human block', 'R5-BODY', ':::', '',
].join('\n');

const PART = ['---', 'smd: 2', 'title: Part', '---', '', '## Part', '', 'Included prose PART-TEXT.', ''].join('\n');
const HIDDEN_WORDS = ['NOTES-TEXT', 'NOTES-AGENT', 'NOTES-DANGER', 'R2-BODY', 'DETAIL-TEXT', 'R3-BODY', 'PART-TEXT'];

const asked = (reads: string[]) => (p: string) => { reads.push(p); return p === 'part.smd' ? PART : undefined; };
const noHidden = (text: string, words = HIDDEN_WORDS) => { for (const w of words) assert.doesNotMatch(text, new RegExp(w), `${w} must not appear`); };

const lineOf = (needle: string) => DOC.split('\n').findIndex((l) => l.includes(needle)) + 1;

test('naming the skipped section, a subsection under it, or both with a visible one shows none of it', () => {
  for (const sections of [['Notes'], ['Detail'], ['Work', 'Notes'], ['Notes', 'Detail'], ['detail']]) {
    for (const options of [{}, { brief: true }, { maxTokens: 400 }, { brief: true, maxTokens: 400 }]) {
      const view = agentView(DOC, { sections, readFile: asked([]), provenance: true, ...options });
      noHidden(view.text);
      assert.match(view.text, /VISIBLE-DANGER/, `${sections} ${JSON.stringify(options)}: a danger outside the sections is still carried`);
      const skipped = view.provenance!.omissions.find((o) => o.kind === 'skipped-section');
      assert.deepEqual([skipped?.heading, skipped?.lines], ['Notes', [lineOf('## Notes'), lineOf('## People') - 1]], `${sections}: the exclusion is recorded though the section was named`);
    }
  }
});

test('a named skipped section is recorded in block accounting, with no command that would still exclude it', () => {
  const view = agentView(DOC, { sections: ['Notes'], readFile: asked([]), provenance: true });
  const p = view.provenance!;
  const skipped = p.omissions.find((o) => o.kind === 'skipped-section')!;
  assert.equal(skipped.retrieve, undefined, 'no agent-section command is advertised');
  assert.match(skipped.noRetrieve!, /never show it/);
  const outcome = (marker: string) => p.blocks.find((b) => b.lines[0] === lineOf(marker));
  for (const marker of ['NOTES-AGENT', 'NOTES-DANGER', 'Hidden base', 'Nested hidden']) {
    // The container's opening line is the block's first line, which is the line before its text.
    const block = p.blocks.find((b) => b.lines[0] <= lineOf(marker) && lineOf(marker) <= b.lines[1] && b.kind !== 'heading' && b.kind !== 'paragraph');
    assert.ok(block, marker);
    assert.deepEqual([block!.outcome, block!.omission?.kind], ['omitted', 'skipped-section'], marker);
  }
  assert.deepEqual([outcome('Notes prose')?.outcome, outcome('Notes prose')?.omission?.kind], ['omitted', 'skipped-section']);
  assert.equal(view.skippedSections.join(), 'Notes');
});

test('a hidden include is not fetched or expanded because its containing section was named', () => {
  const reads: string[] = [];
  const view = agentView(DOC, { sections: ['Notes'], readFile: asked(reads), provenance: true });
  assert.doesNotMatch(view.text, /PART-TEXT|<included/);
  assert.equal(view.provenance!.omissions.some((o) => o.kind === 'include'), false, 'no include is attempted, so none fails or is recorded as a pointer');
  // The document's figures and ids are read for every view, so naming the section adds no read of its own.
  const other: string[] = [];
  agentView(DOC, { sections: ['Work'], readFile: asked(other), provenance: true });
  assert.deepEqual(reads, other);
  // Elsewhere it would be: an include outside the skipped section is still expanded.
  const visible = DOC.replace('## Notes {agent=skip}', '## Notes');
  assert.match(agentView(visible, { sections: ['Notes'], readFile: asked([]) }).text, /PART-TEXT/);
});

test('a requirement that depends on hidden content reports it as hidden, not missing, and the read is incomplete', () => {
  for (const sections of [['Work'], ['Work', 'Notes']]) {
    const view = agentView(DOC, { sections, readFile: asked([]), provenance: true });
    assert.deepEqual(view.mandatory?.unsatisfied.map((u) => [u.kind, u.target, u.via]), [['hidden', 'R2', 'R1']], `${sections}`);
    assert.equal(view.mandatory?.complete, false);
    assert.deepEqual(view.mandatory?.completeness, { coverage: false, resolution: true, budget: true });
    noHidden(view.text);
    assert.match(view.text, /R1-BODY/);
    assert.ok(view.provenance!.omissions.some((o) => o.kind === 'dependency' && /not carried/.test(o.reason)));
  }
});

test('naming a skipped section alone creates no unsatisfied dependency: its exclusion is recorded apart from completeness', () => {
  const view = agentView(DOC, { sections: ['Notes'], readFile: asked([]), provenance: true });
  assert.deepEqual((view.mandatory?.unsatisfied ?? []).map((u) => u.target), []);
  assert.notEqual(view.mandatory?.complete, false);
  assert.ok(view.provenance!.omissions.some((o) => o.kind === 'skipped-section'));
});

test('a requirement that depends on a block inside :::human is hidden too, and --include-human is the explicit way to show it', () => {
  const view = agentView(DOC, { sections: ['Later'], readFile: asked([]) });
  assert.deepEqual(view.mandatory?.unsatisfied.map((u) => [u.kind, u.target]), [['hidden', 'RH']]);
  assert.doesNotMatch(view.text, /RH-BODY|HUMAN-TEXT/);
  // The explicit human-inclusive option keeps its documented contract: it shows :::human blocks, and nothing else.
  const human = agentView(DOC, { sections: ['Later'], readFile: asked([]), includeHuman: true });
  assert.match(human.text, /RH-BODY/);
  assert.equal(human.mandatory?.unsatisfied.some((u) => u.target === 'RH'), false);
  noHidden(agentView(DOC, { includeHuman: true, readFile: asked([]) }).text);
  noHidden(agentView(DOC, { sections: ['Notes'], includeHuman: true, readFile: asked([]) }).text);
});

test('a hidden danger never shows, and dangers outside the requested section still do', () => {
  for (const sections of [['Work'], ['Notes'], ['Later']]) {
    const view = agentView(DOC, { sections, readFile: asked([]) }).text;
    assert.match(view, /VISIBLE-DANGER/, `${sections}`);
    assert.doesNotMatch(view, /NOTES-DANGER/, `${sections}`);
  }
  const constraints = agentView(DOC, { sections: ['Notes'], constraints: true, readFile: asked([]) }).text;
  assert.doesNotMatch(constraints, /NOTES-DANGER|Hidden danger/);
});

test('a query never matches content for people, and says how many matches it left out', () => {
  const view = queryView(DOC, 'requirement', { readFile: asked([]), provenance: true })!;
  assert.deepEqual(view.matches.map((m) => m.attrs.id), ['R1', 'R5']);
  noHidden(view.text);
  assert.doesNotMatch(view.text, /RH-BODY/);
  assert.equal(queryView(DOC, 'requirement[id=R2]', { readFile: asked([]) }), null, 'a match inside a skipped section is no match');
  assert.equal(queryView(DOC, 'requirement[id=RH]', { readFile: asked([]) }), null, 'nor one inside :::human');
  assert.equal(queryView(DOC, 'agent', { readFile: asked([]) }), null);
  assert.equal(withheldMatches(DOC, 'requirement'), 3, 'R2, R3 and RH');
  // A heading match holds a skipped subsection without showing it.
  const section = ['---', 'smd: 2', '---', '', '## Plan', '', 'PLAN-TEXT.', '', '### Old {agent=skip}', '', 'OLD-TEXT.', '', '### Next', '', 'NEXT-TEXT.', ''].join('\n');
  const plan = querySmd(section, 'heading[title=Plan]', { forAgents: true });
  assert.match(plan[0].text, /PLAN-TEXT/);
  assert.match(plan[0].text, /NEXT-TEXT/);
  assert.doesNotMatch(plan[0].text, /OLD-TEXT/);
  assert.deepEqual(querySmd(section, 'heading', { forAgents: true }).map((m) => m.title), ['Plan', 'Next']);
});

test('the plain query used by reports and registers for people is unchanged', () => {
  assert.deepEqual(querySmd(DOC, 'requirement').map((m) => m.attrs.id), ['R1', 'R2', 'R3', 'RH', 'R5']);
  const human = querySmd(DOC, 'human');
  assert.equal(human.length, 1);
  assert.match(human[0].text, /HUMAN-TEXT/);
});

test('smd query and the contract-aware query leave hidden matches out and name the number', () => {
  const dir = mkWorkspace({ 'doc.smd': DOC, 'part.smd': PART });
  try {
    const flags = { json: false, titles: false, brief: false, lineRefs: true, today: '2026-11-17' };
    const plain = runQuery('requirement', [dir], flags);
    assert.equal(plain.code, 0);
    noHidden(plain.stdout);
    assert.match(plain.stderr, /\[smd\] 3 matching block\(s\) in content for people .* left out: a query does not unlock them\.\n$/);
    const none = runQuery('requirement[id=R2]', [dir], flags);
    assert.deepEqual([none.code, none.stdout], [1, '']);
    assert.match(none.stderr, /1 matching block\(s\) in content for people/);
    const contract = runQuery('requirement', [dir], { ...flags, contract: true });
    noHidden(contract.stdout);
    assert.match(contract.stderr, /3 matching block\(s\) in content for people/);
    const result = queryDocuments([{ path: 'doc.smd', text: DOC }], 'requirement', { forAgents: true });
    assert.equal(result.withheld, 3);
  } finally {
    rmWorkspace(dir);
  }
});

test('dependency traversal while following edges never reaches into hidden content', () => {
  const doc = ['---', 'smd: 2', '---', '', '## Work', '', ':::requirement{#R1 depends-on=R2} Needs a hidden base', 'R1-BODY', ':::', '', '## Basis {agent=skip}', '', ':::requirement{#R2} Hidden', 'R2-BODY', ':::', ''].join('\n');
  const result = queryDocuments([{ path: 'doc.smd', text: doc }], 'requirement[id=R1]', { forAgents: true, follow: 'depends-on' });
  assert.deepEqual(result.graph![0].dependencies, [], 'the hidden dependency is not included');
  assert.deepEqual(result.graph![0].unsatisfied.map((u) => [u.kind, u.edge.target]), [['hidden', 'R2']]);
  assert.equal(result.complete, false);
  // A read that follows edges from a named skipped section does not expand it either.
  const read = readSmd(doc, { file: 'doc.smd', sections: ['Basis'], follow: '*' });
  assert.doesNotMatch(read.text, /R2-BODY/);
});

test('an author task view never shows content for people: a pinned, queried or mandatory block in it is reported as hidden', () => {
  const doc = [
    '---', 'smd: 2', 'views:', '  by-query:', '    query: "requirement"', '  by-id:', '    mandatory: [R2]', '    optional: [R3]',
    '  by-section:', '    sections: [Notes]', '---', '',
    '## Work', '', 'WORK-TEXT.', '', ':::requirement{#R1} Visible', 'R1-BODY', ':::', '',
    '## Notes {agent=skip}', '', 'NOTES-TEXT.', '', ':::requirement{#R2} Hidden', 'R2-BODY', ':::', '', ':::requirement{#R3} Hidden too', 'R3-BODY', ':::', '',
  ].join('\n');
  const query = taskView(doc, 'by-query');
  assert.deepEqual(query.view.query?.matches.map((m) => m.id), ['R1']);
  noHidden(query.text, ['R2-BODY', 'R3-BODY', 'NOTES-TEXT']);
  const byId = taskView(doc, 'by-id', { provenance: true });
  noHidden(byId.text, ['R2-BODY', 'R3-BODY', 'NOTES-TEXT']);
  assert.deepEqual(byId.view.mandatory.map((m) => [m.id, m.status, m.block]), [['R2', 'hidden', undefined]]);
  assert.deepEqual(byId.view.unsatisfied.map((u) => [u.kind, u.target]), [['hidden', 'R2']]);
  assert.equal(byId.view.complete, false);
  assert.deepEqual(byId.view.optional.map((o) => [o.id, o.status, o.retrieve]), [['R3', 'hidden', undefined]]);
  assert.match(byId.text, /-> R3 {2}hidden: for people only/);
  const bySection = taskView(doc, 'by-section', { provenance: true });
  noHidden(bySection.text, ['R2-BODY', 'R3-BODY', 'NOTES-TEXT']);
  assert.ok(bySection.provenance!.omissions.some((o) => o.kind === 'skipped-section'));
});

test('pinned ranges cannot put lines of a skipped section in a view', () => {
  const lines = DOC.split('\n');
  const from = lineOf('## Notes') - 1;
  const view = agentView(DOC, {
    readFile: asked([]),
    pinned: { ranges: [[from, lines.length - 1]], whole: [[from, lines.length - 1]], selects: true, label: '(pinned)', appendix: '' },
  });
  noHidden(view.text);
  assert.doesNotMatch(view.text, /HUMAN-TEXT|RH-BODY/);
});

test('the validator still warns about rules and instructions that agents never receive, and says selection does not change that', () => {
  const doc = [
    '---', 'smd: 2', '---', '',
    '## Work', '', 'Work text.', '',
    '## History {agent=skip}', '', ':::agent', 'Prefer the old importer.', ':::', '',
    '### Old rules', '', ':::danger Careful', 'Never do this.', ':::', '', ':::constraint{#C1} Old rule', 'Keep it.', ':::', '',
    '## People', '', ':::human', ':::requirement{#R1} For people', 'Body.', ':::', ':::', '',
  ].join('\n');
  const found = validateSmd(doc).filter((d) => d.code.startsWith('audience/') || d.code === 'container/agent-in-skip');
  assert.deepEqual(found.map((d) => [d.code, d.line + 1]), [
    ['container/agent-in-skip', 11], ['audience/rule-in-skip', 17], ['audience/rule-in-skip', 21], ['audience/rule-in-skip', 28],
  ]);
  for (const d of found) assert.match(d.message, /even when a read names the section/);
  for (const d of found) assert.match(d.message, /visible content|outside that part|remove (the mark|agent=skip)/);
  // Diagnostics only: the document is never changed, and a visible rule is quiet.
  assert.deepEqual(validateSmd(doc.replace(/^:::danger Careful[\s\S]*?:::\n/m, '')).filter((d) => d.line + 1 === 17), []);
});

test('human-facing rendering is unchanged: a section marked {agent=skip} and a :::human block are still rendered', () => {
  const html = renderSmd(DOC, { readFile: (p) => (p === 'part.smd' ? PART : undefined) }).html;
  for (const word of ['NOTES-TEXT', 'DETAIL-TEXT', 'HUMAN-TEXT', 'WORK-TEXT']) assert.match(html, new RegExp(word));
});

function mkWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-audience-'));
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
  return dir;
}

function rmWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
