import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentView, estimateTokens, querySmd } from '../src/core';
import { readDocument } from '../src/readView';

/**
 * The research contract (docs/RESEARCH-CONTRACT-RFC.smd), G0.
 *
 * The first group locks what the agent view and queries do today, so later gates change it only on purpose
 * (AF01, AF16, AF21). The GAP group covers the gaps the contract found and fixed in G0 (contract section "Gaps the
 * contract found").
 */

const FILES: Record<string, string> = {
  'shared.smd': [
    '---', 'smd: 2', 'title: Shared', '---', '',
    ':::agent Included rule', 'INCLUDED_RULE', ':::', '',
    '## Private notes {agent=skip}', '', 'PRIVATE_TEXT', '',
  ].join('\n'),
};
const readFile = (p: string) => FILES[p];

const doc = [
  '---', 'smd: 2', 'title: Contract', '---', '',
  '## Intro', '',
  'Intro text.', '',
  ':::details Advanced',
  '::::danger Deep danger', 'NESTED_DANGER', '::::',
  ':::', '',
  '## Shared', '',
  ':::include{file=shared.smd}', ':::', '',
  '## Plan', '',
  ':::timeline', '- [x] **2026-09-01** — Discovery', '- [ ] **2026-12-01** — Launch', ':::', '',
  '- [x] Write the spec @pat', '- [ ] Ship it :priority[P1]', '',
  ':::question Which database?', 'Undecided.', ':::', '',
  ':::question{status=answered} Which queue?', 'SQS.', ':::', '',
  ':::decision Use Kafka', 'No status written.', ':::', '',
  ':::danger Never delete data', 'DANGER_TEXT', ':::', '',
  '## Notes', '',
  'Filler. '.repeat(120), '',
].join('\n');

// ---------------------------------------------------------------------------
// Locked: current behavior the contract records
// ---------------------------------------------------------------------------

test('AF21: a bare question selector matches every question, in document order, whatever is written on it', () => {
  const matches = querySmd(doc, 'question', { today: '2026-11-06' });
  assert.deepEqual(matches.map((m) => m.title), ['Which database?', 'Which queue?']);
  assert.equal(matches[1].attrs.status, 'answered', 'a written attribute is kept on the match');
});

test('AF21: a decision with no status queries as proposed, and "open" is not a status a selector knows', () => {
  assert.deepEqual(querySmd(doc, 'decision[status=proposed]').map((m) => m.title), ['Use Kafka']);
  assert.equal(querySmd(doc, 'decision[status=open]').length, 0);
});

test('AF01: cues keep their role as a tag or as text in the full view', () => {
  const view = agentView(doc, { readFile, today: '2026-11-06' }).text;
  assert.match(view, /<question title="Which database\?">/);
  assert.match(view, /<danger title="Never delete data">\s*DANGER_TEXT/);
  assert.match(view, /<decision> Use Kafka/, 'a decision with no status shows no status (the view does not add the default)');
  assert.match(view, /- \[x\] Write the spec @pat/, 'a checked box is passed through as written: an implementation claim');
  assert.doesNotMatch(view, /verified|accepted by/i, 'nothing in the view says a checked task was verified');
  assert.match(view, /- \[x\] \*\*2026-09-01\*\* — Discovery/, 'timeline items are tasks as written, with no tag of their own');
});

test('AF16: read routes on its budget and never truncates', () => {
  const routed = readDocument(doc, { maxTokens: 50, readFile, today: '2026-11-06' });
  assert.equal(routed.shown, 'outline', 'over the routing budget, read returns the outline');
  const sections = readDocument(doc, { maxTokens: 10, sections: ['Plan'], readFile, today: '2026-11-06' });
  assert.equal(sections.shown, 'sections');
  assert.ok(estimateTokens(sections.text) > 10, 'with sections, the routing budget does not cap the result');
  assert.match(sections.text, /Ship it/);
});

test('AF16: agent --max-tokens omits sections with pointers and reports, rather than drops, mandatory overflow', () => {
  const view = agentView(doc, { readFile, maxTokens: 120, today: '2026-11-06' });
  assert.match(view.text, /\[section omitted: ## Notes, L\d+-L\d+, ≈\d+ tokens — smd agent <file> --section "Notes"\]/);
  const tiny = agentView(doc, { readFile, maxTokens: 5, today: '2026-11-06' });
  assert.equal(tiny.budget?.fits, false, 'a budget that cannot hold the mandatory content is reported as not fitting');
});

// ---------------------------------------------------------------------------
// Gaps found and fixed in G0 (contract section "Gaps the contract found").
// ---------------------------------------------------------------------------

test('GAP-1 (AF15): :::agent from an include is kept in a section view of another section', () => {
  const view = agentView(doc, { readFile, sections: ['Notes'], today: '2026-11-06' }).text;
  assert.match(view, /INCLUDED_RULE/);
});

test('GAP-2 (AF15, AF17): {agent=skip} inside an included file is honoured', () => {
  const view = agentView(doc, { readFile, today: '2026-11-06' }).text;
  assert.doesNotMatch(view, /PRIVATE_TEXT/);
});

test('GAP-3 (AF01, AF15): --brief does not hide a danger inside :::details without a pointer to it', () => {
  const view = agentView(doc, { readFile, brief: true, today: '2026-11-06' }).text;
  assert.match(view, /NESTED_DANGER|danger: Deep danger/);
});

test('GAP-4 (AF16): a budget pointer says when the omitted section holds a danger', () => {
  const view = agentView(doc, { readFile, maxTokens: 60, today: '2026-11-06' }).text;
  const pointer = view.split('\n').find((l) => l.startsWith('[section omitted: ## Plan'));
  assert.ok(pointer, 'the Plan section is omitted at this budget');
  assert.match(pointer, /danger/);
});

test('GAP-5 (AF15): --max-tokens never omits a section whose :::agent block comes from an include', () => {
  const view = agentView(doc, { readFile, maxTokens: 60, today: '2026-11-06' }).text;
  assert.match(view, /INCLUDED_RULE/);
});

// ---------------------------------------------------------------------------
// The fixes' edges
// ---------------------------------------------------------------------------

const edges = (body: string[]) => ['---', 'smd: 2', 'title: Edges', '---', '', ...body, ''].join('\n');
const edgeFiles: Record<string, string> = {
  ...FILES,
  'plain.smd': ['---', 'smd: 2', 'title: Plain', '---', '', 'PLAIN_TEXT', ''].join('\n'),
  'nested.smd': ['---', 'smd: 2', 'title: Nested', '---', '', ':::include{file=shared.smd}', ':::', ''].join('\n'),
};
const edgeRead = (p: string) => edgeFiles[p];

test('GAP-1: an include without :::agent blocks adds nothing to a section view of another section', () => {
  const view = agentView(edges(['## A', '', ':::include{file=plain.smd}', ':::', '', '## B', '', 'B text.']), { readFile: edgeRead, sections: ['B'] }).text;
  assert.doesNotMatch(view, /included|PLAIN_TEXT|Document-wide/);
});

test('GAP-1: rules from an include inside an include, or inside a condensed :::details, are kept', () => {
  const nested = agentView(edges(['## A', '', ':::include{file=nested.smd}', ':::', '', '## B', '', 'B text.']), { readFile: edgeRead, sections: ['B'] }).text;
  assert.equal(nested.split('INCLUDED_RULE').length - 1, 1, nested);
  const details = agentView(edges(['## A', '', ':::details More', ':::include{file=shared.smd}', ':::', ':::']), { readFile: edgeRead, brief: true }).text;
  assert.match(details, /\[details: More — omitted, see L\d+\]/);
  assert.match(details, /INCLUDED_RULE/);
  assert.doesNotMatch(details, /PRIVATE_TEXT/);
});

test('GAP-1: an include inside :::human gives no rules, as a :::agent block there gives none', () => {
  const view = agentView(edges(['## A', '', ':::human', ':::include{file=shared.smd}', ':::', ':::', '', '## B', '', 'B text.']), { readFile: edgeRead, sections: ['B'] }).text;
  assert.doesNotMatch(view, /INCLUDED_RULE/);
  assert.doesNotMatch(agentView(edges(['## A', '', ':::human', ':::include{file=shared.smd}', ':::', ':::']), { readFile: edgeRead }).text, /INCLUDED_RULE/);
});

test('GAP-1: with includes off, a section view adds no pointer for an include elsewhere', () => {
  const view = agentView(edges(['## A', '', ':::include{file=shared.smd}', ':::', '', '## B', '', 'B text.']), { readFile: edgeRead, sections: ['B'], includes: false }).text;
  assert.doesNotMatch(view, /include/);
});

test('GAP-2: provenance records the skipped section of an included file', () => {
  const view = agentView(doc, { readFile, provenance: true, file: 'doc.smd', today: '2026-11-06' });
  const skipped = view.provenance!.omissions.filter((o) => o.kind === 'skipped-section' && o.file === 'shared.smd');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].heading, 'Private notes');
});

test('GAP-3: a CAUTION alert inside :::details is kept in brief views, and other callouts are still condensed', () => {
  const view = agentView(edges(['## A', '', ':::details More', '> [!CAUTION]', '> ALERT_DANGER', '', ':::warning W', 'WARN_TEXT', ':::', ':::']), { brief: true }).text;
  assert.match(view, /<danger>\s*ALERT_DANGER\s*<\/danger>/);
  assert.doesNotMatch(view, /WARN_TEXT/);
});

test('GAP-4: pointers name warnings and questions too, and a section with none of them gets the old pointer', () => {
  const body = ['## Keep', '', 'K.', '', '## Cues', '', ':::warning Careful', 'W '.repeat(80), ':::', '', ':::question Open?', 'Q.', ':::', '',
    '## Plain', '', 'P '.repeat(200)];
  const view = agentView(edges(body), { maxTokens: 40 }).text;
  assert.match(view, /\[section omitted: ## Cues, L\d+-L\d+, ≈\d+ tokens, holds warning, question — /);
  assert.match(view, /\[section omitted: ## Plain, L\d+-L\d+, ≈\d+ tokens — /);
});

test('GAP-4: a section with a CAUTION alert is kept longer than one without key content', () => {
  const body = ['## Alert', '', '> [!CAUTION]', '> ' + 'A '.repeat(60), '', '## Plain', '', 'P '.repeat(60)];
  const all = agentView(edges(body)).tokens;
  const view = agentView(edges(body), { maxTokens: all - 5 }).text;
  assert.match(view, /\[section omitted: ## Plain/);
  assert.doesNotMatch(view, /\[section omitted: ## Alert/);
});

test('GAP-7 (AF13, AF23): --constraints lists an include outside the sections without opening it, as policy constraints/1 says', () => {
  const files: Record<string, string> = {
    'risky.smd': ['---', 'smd: 2', 'title: Risky', '---', '', '## Inner', '', ':::danger Included danger', 'INCLUDED_DANGER', ':::', ''].join('\n'),
  };
  const text = edges(['## A', '', ':::include{file=risky.smd}', ':::', '', '## B', '', 'B text.']);
  const view = agentView(text, { readFile: (p) => files[p], sections: ['B'], constraints: true });
  assert.doesNotMatch(view.text, /INCLUDED_DANGER/);
  assert.equal(view.constraints?.complete, false);
  assert.equal(view.constraints?.shown, 0, 'a danger the view does not show is not counted as shown');
  assert.deepEqual(view.constraints?.pointers.map((p) => [p.type, p.title, p.line, p.section]), [['include', 'risky.smd', 7, 'A']]);
});

// ---------------------------------------------------------------------------
// C04 constraint scope, decided 2026-11-06: dangers apply to the whole document
// ---------------------------------------------------------------------------

const scoped = edges([
  '## A', '', ':::danger Never drop the ledger', 'ROOT_DANGER', ':::', '', '> [!CAUTION]', '> ALERT_DANGER', '',
  ':::warning Careful', 'WARN_TEXT', ':::', '',
  '## B', '', 'B text.', '',
  '## Notes {agent=skip}', '', ':::danger Skipped', 'SKIP_DANGER', ':::', '',
  '## C', '', ':::agent Rules', '::::danger In rules', 'AGENT_DANGER', '::::', ':::', '',
  ':::human', '::::danger Human only', 'HUMAN_DANGER', '::::', ':::', '',
  '## D', '', ':::include{file=risky.smd}', ':::',
]);
const riskyFiles: Record<string, string> = {
  'risky.smd': ['---', 'smd: 2', 'title: Risky', '---', '', ':::danger Included danger', 'INCLUDED_DANGER', ':::', ''].join('\n'),
};
const riskyRead = (p: string) => riskyFiles[p];
const once = (text: string, word: string) => assert.equal(text.split(word).length - 1, 1, `${word} once`);

test('C04: a section view shows the dangers of other sections and included files in full, once each', () => {
  const view = agentView(scoped, { readFile: riskyRead, sections: ['B'] }).text;
  assert.match(view, /Dangers elsewhere in the document:\n<danger title="Never drop the ledger">\nROOT_DANGER\n<\/danger>/);
  for (const word of ['ROOT_DANGER', 'ALERT_DANGER', 'INCLUDED_DANGER', 'AGENT_DANGER']) once(view, word);
  assert.match(view, /<included file="risky.smd">\n<danger title="Included danger">/);
});

test('C04: warnings, skipped sections and :::human blocks stay out of a section view by default', () => {
  const view = agentView(scoped, { readFile: riskyRead, sections: ['B'] }).text;
  for (const word of ['WARN_TEXT', 'SKIP_DANGER', 'HUMAN_DANGER']) assert.doesNotMatch(view, new RegExp(word));
});

test('C04: a danger inside the selected sections is shown in place, not repeated in the head', () => {
  const view = agentView(scoped, { readFile: riskyRead, sections: ['A'] }).text;
  once(view, 'ROOT_DANGER');
  once(view, 'ALERT_DANGER');
  once(view, 'INCLUDED_DANGER');
});

test('C04: with --constraints the dangers are listed once, in the constraints block', () => {
  const view = agentView(scoped, { readFile: riskyRead, sections: ['B'], constraints: true }).text;
  assert.doesNotMatch(view, /Dangers elsewhere in the document:/);
  assert.match(view, /Constraints elsewhere in the document:/);
  once(view, 'ROOT_DANGER');
  assert.match(view, /warning "Careful"/, 'warnings are pointers');
});

test('C04: a whole-document view and a document without dangers are unchanged', () => {
  assert.doesNotMatch(agentView(scoped, { readFile: riskyRead }).text, /Dangers elsewhere/);
  assert.doesNotMatch(agentView(edges(['## A', '', 'a', '', '## B', '', 'b']), { sections: ['B'] }).text, /Dangers elsewhere/);
});

test('C04: the dangers survive a budget and brief section views, and MCP-style reads with sections', () => {
  const tiny = agentView(scoped, { readFile: riskyRead, sections: ['B'], maxTokens: 10 });
  assert.match(tiny.text, /ROOT_DANGER/);
  assert.equal(tiny.budget?.fits, false);
  assert.match(agentView(scoped, { readFile: riskyRead, sections: ['B'], brief: true }).text, /INCLUDED_DANGER/);
  const read = readDocument(scoped, { readFile: riskyRead, sections: ['B'] });
  assert.match(read.text, /Dangers elsewhere in the document:[\s\S]*ROOT_DANGER/);
});

test('C04: provenance leaves the text unchanged and maps the head dangers to their lines', () => {
  const plain = agentView(scoped, { readFile: riskyRead, sections: ['B'] }).text;
  const traced = agentView(scoped, { readFile: riskyRead, sections: ['B'], provenance: true, file: 'doc.smd' });
  assert.equal(traced.text, plain);
  const json = JSON.stringify(traced.provenance);
  assert.match(json, /risky\.smd/);
});
