import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentView, applyFixes, extractTasks, indexEntry, querySmd, renderSmd, smdToMarkdown, validateSmd,
} from '../src/core';
import { exportTree } from '../src/core/exportTree';
import { taskLine, taskSummary } from '../src/workspace';

/**
 * Semantic tags phase 2 as the feedback loop RFC builds it (docs/rfcs/feedback-loop.smd): assumption, evidence, the
 * question lifecycle, decision supersedes and `:depends` on tasks. Test names give the requirement ids of
 * docs/requirements/semantic-tags.smd (R, AC) and the research items (AF, GAP) they cover.
 */

const TODAY = '2026-11-07';
const v2 = (body: string) => `---\nsmd: 2\ntitle: T\n---\n\n${body}\n`;
const v1 = (body: string) => `---\nsmd: 1\ntitle: T\n---\n\n${body}\n`;
const found = (text: string, code: string) => validateSmd(text, { today: TODAY }).filter((d) => d.code === code);

// --- Assumption ---------------------------------------------------------------------------------------------------

test('AC10 (R38): an unvalidated assumption past its review-by date is assumption/overdue, and renders "overdue"', () => {
  const text = v2(':::assumption{#A1 owner=@maya review-by=2026-01-01} Readers use the CLI\n:::');
  const diags = found(text, 'assumption/overdue');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'info');
  assert.deepEqual(found(text.replace('review-by', 'status=validated review-by'), 'assumption/overdue'), []);
  const html = renderSmd(text, { today: TODAY }).html;
  assert.match(html, /<span class="smd-pill smd-pill-status smd-pill-status-unvalidated">unvalidated<\/span>/);
  assert.match(html, /review by 2026-01-01<span class="smd-due-note"> · overdue<\/span>/);
  assert.match(agentView(text).text, /^<assumption id="A1" status="unvalidated" owner="@maya" review-by="2026-01-01"> Readers use the CLI$/m);
  assert.match(smdToMarkdown(text), /^> \[!WARNING\]\n> \*\*Assumption A1\*\* · unvalidated · @maya · review by 2026-01-01$/m);
});

test('R39: an accepted requirement or decision that depends on an invalid assumption warns assumption/invalid', () => {
  const text = v2([
    ':::assumption{#A1 status=invalid} Wrong premise', ':::', '',
    ':::requirement{#R1 status=accepted depends-on=A1} Built on it', ':::', '',
    ':::decision{#D1 status=accepted depends-on=A1} Also built on it', ':::', '',
    ':::requirement{#R2 status=proposed depends-on=A1} Not settled', ':::',
  ].join('\n'));
  assert.deepEqual(found(text, 'assumption/invalid').map((d) => d.line + 1), [9, 12]);
});

test('R40: an unvalidated assumption is key content under a budget; a validated one is not', () => {
  const filler = 'Filler words here. '.repeat(60);
  // The premise section is the larger, so it goes first unless it holds key content. The budget leaves room for one.
  const doc = (status: string) => v2(`## Plain\n\n${filler}\n\n## Premise\n\n:::assumption{#A1${status}} Premise\n${filler}\n:::`);
  const omitted = (text: string) => agentView(text, { maxTokens: agentView(text).tokens - 100 }).budget!.omitted.map((o) => o.heading);
  assert.deepEqual(omitted(doc('')), ['Plain'], 'an unvalidated premise is kept longer');
  assert.deepEqual(omitted(doc(' status=validated')), ['Premise'], 'a validated premise is ordinary content');
});

// --- Evidence ------------------------------------------------------------------------------------------------------

test('R41: evidence linked to nothing is info evidence/unlinked; an empty supports= is evidence/target; evidence/rev hints without rev', () => {
  const unlinked = found(v2(':::evidence{#E1 method=test result=pass} Run\n:::'), 'evidence/unlinked');
  assert.equal(unlinked.length, 1);
  assert.equal(unlinked[0].severity, 'info');
  assert.deepEqual(found(v2(':::evidence{#E1 method=test result=pass} Run\n:::'), 'evidence/target'), [], 'evidence/unlinked replaces the warning');
  const empty = found(v2(':::evidence{#E1 supports="" result=pass} Run\n:::'), 'evidence/target');
  assert.equal(empty.length, 1);
  assert.equal(empty[0].severity, 'warning');
  assert.equal(v2(':::evidence{#E1 supports="" result=pass} Run\n:::').split('\n')[empty[0].line].slice(empty[0].column, empty[0].endColumn), 'supports=""');
  assert.deepEqual(found(v2(':::evidence{#E1 supports="" result=pass} Run\n:::'), 'evidence/unlinked'), []);
  // An id that names no block is ref/unknown, not evidence/unlinked.
  const unknown = v2(':::evidence{#E1 supports=R9 rev=R9@3f2a9c1b0d4e} Run\n:::');
  assert.equal(found(unknown, 'ref/unknown').length, 1);
  assert.deepEqual([...found(unknown, 'evidence/unlinked'), ...found(unknown, 'evidence/target')], []);
  assert.deepEqual(found(v2(':::requirement{#R1} X\n:::\n\n:::evidence{#E1 contradicts=R1 rev=R1@3f2a9c1b0d4e} Run\n:::'), 'evidence/unlinked'), []);
  const noRev = found(v2(':::requirement{#R1} X\n:::\n\n:::evidence{#E1 supports=R1 result=pass} Run\n:::'), 'evidence/rev');
  assert.equal(noRev.length, 1);
  assert.equal(noRev[0].severity, 'hint');
  assert.deepEqual(found(v2(':::requirement{#R1} X\n:::\n\n:::evidence{#E1 supports=R1 rev=R1@3f2a9c1b0d4e} Run\n:::'), 'evidence/rev'), []);
});

test('evidence shows its result and targets on every surface; contradicts renders as a conflicting link', () => {
  const text = v2(':::requirement{#R1} X\n:::\n\n:::evidence{#E1 supports=R1 contradicts=R1 method=test result=fail commit=1a2b3c4 by=@ci source="https://ci.example.com/run/42"} CI run\n:::');
  const html = renderSmd(text).html;
  assert.match(html, /<span class="smd-pill smd-pill-result smd-pill-result-fail">fail<\/span>/);
  assert.match(html, /contradicts <a class="smd-ref smd-conflict" href="#R1"/);
  assert.match(html, /<a href="https:\/\/ci.example.com\/run\/42">https:\/\/ci.example.com\/run\/42<\/a>/);
  assert.match(agentView(text).text, /^<evidence id="E1" supports="R1" contradicts="R1" method="test" result="fail" commit="1a2b3c4" by="@ci" source="https:\/\/ci.example.com\/run\/42"> CI run$/m);
  assert.match(smdToMarkdown(text), /^> \[!CAUTION\]\n> \*\*Evidence E1\*\* · supports R1 · contradicts R1 · test · fail · 1a2b3c4 · @ci · https:\/\/ci.example.com\/run\/42$/m);
  assert.equal(querySmd(text, 'evidence[supports=R1][result=fail]').length, 1);
  assert.deepEqual(validateSmd(text).filter((d) => d.code === 'evidence/source' || d.code === 'evidence/commit'), []);
});

test('AC11 (R42): source="javascript:alert(1)" on evidence renders with no link, is left out of every output, and is evidence/source', () => {
  const text = v2(':::requirement{#R1} X\n:::\n\n:::evidence{#E1 supports=R1 result=pass by=@ci source="javascript:alert(1)" rev=R1@3f2a9c1b0d4e} CI run\n:::');
  const diags = found(text, 'evidence/source');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'warning');
  assert.equal(text.split('\n')[diags[0].line].slice(diags[0].column, diags[0].endColumn), 'source="javascript:alert(1)"');
  const html = renderSmd(text).html;
  assert.match(html, /smd-pill-result-pass/, 'the document renders');
  assert.doesNotMatch(html, /javascript/);
  assert.doesNotMatch(agentView(text).text, /javascript|source=/);
  assert.match(agentView(text).text, /^<evidence id="E1" supports="R1" result="pass" by="@ci" rev="R1@3f2a9c1b0d4e"> CI run$/m);
  assert.doesNotMatch(smdToMarkdown(text), /javascript/);
  assert.doesNotMatch(JSON.stringify(exportTree(text)), /javascript/);
  // The same check as :::quote{cite}: http(s) and relative URLs pass, other schemes, `//host` and spaces don't.
  const check = (source: string) => found(v2(`:::requirement{#R1} X\n:::\n\n:::evidence{#E1 supports=R1 source="${source}"} Run\n:::`), 'evidence/source').length;
  assert.deepEqual(['https://ci.example.com/1', 'http://x.test', 'logs/run-42.txt', '../ci/run.log', '#R1'].map(check), [0, 0, 0, 0, 0]);
  assert.deepEqual(['data:text/html,x', 'JAVASCRIPT:alert(1)', '//evil.example', 'file:///etc/passwd', 'CI run 42', ''].map(check), [1, 1, 1, 1, 1, 1]);
  const relative = v2(':::requirement{#R1} X\n:::\n\n:::evidence{#E1 supports=R1 source=logs/run.txt} Run\n:::');
  assert.match(renderSmd(relative).html, /<a href="logs\/run.txt">logs\/run.txt<\/a>/);
  assert.match(JSON.stringify(exportTree(relative)), /"href":"logs\/run.txt"/);
});

test('R43: a commit that is not 7 to 40 hex characters is evidence/commit; existence is not checked', () => {
  const check = (commit: string) => found(v2(`:::requirement{#R1} X\n:::\n\n:::evidence{#E1 supports=R1 commit="${commit}"} Run\n:::`), 'evidence/commit');
  assert.deepEqual(['1a2b3c4', 'DEADBEEF', 'a'.repeat(40), '0000000'].map((c) => check(c).length), [0, 0, 0, 0]);
  assert.deepEqual(['1a2b3c', 'a'.repeat(41), 'main', 'v1.2.0', '1a2b3c4g', ''].map((c) => check(c).length), [1, 1, 1, 1, 1, 1]);
  const [d] = check('main');
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /7 to 40 hex characters/);
  // Still shown as written: the value is not a link and not dropped.
  assert.match(agentView(v2(':::evidence{#E1 commit=main} Run\n:::')).text, /commit="main"/);
});

// --- Questions -----------------------------------------------------------------------------------------------------

const QUESTIONS = v2([
  ':::question Plain question', 'Body.', ':::', '',
  ':::question{#Q1 status=answered owner=@maya due=2026-01-01} Written answered, no answer', ':::', '',
  ':::question{#Q2} Answered elsewhere', ':::', '',
  ':::comment{kind=answer for=Q2 author=@sam}', 'Yes.', ':::', '',
  ':::question{#Q3 status=incorporated} Answered inside', '', ':::comment{kind=answer author=@sam}', 'No.', ':::', ':::', '',
  ':::question{#Q4 status=withdrawn} Withdrawn without a reason', ':::', '',
  ':::question{#Q5 between=D1,D2} Which store?', ':::', '',
  ':::decision{#D1 status=accepted} Use files', ':::', '',
  ':::decision{#D2 status=accepted} Use a database', ':::',
].join('\n'));

test('GAP-8 (AF07, AF11): the agent view shows a question\'s id and state, answered only when an answer exists', () => {
  const view = agentView(QUESTIONS, { today: TODAY }).text;
  assert.match(view, /^<question title="Plain question">$/m, 'a question without lifecycle attributes reads as before');
  assert.match(view, /^<question id="Q1" status="open" owner="@maya" due="2026-01-01" title="Written answered, no answer">$/m);
  assert.match(view, /^<question id="Q2" status="answered" title="Answered elsewhere">$/m);
  assert.match(view, /^<question id="Q3" status="incorporated" title="Answered inside">$/m);
  assert.match(view, /^<question id="Q4" status="withdrawn" title="Withdrawn without a reason">$/m);
  assert.match(view, /^<question id="Q5" status="open" between="D1,D2" title="Which store\?">$/m);
});

test('AF11: question/unanswered, question/reason and question/overdue', () => {
  assert.deepEqual(found(QUESTIONS, 'question/unanswered').map((d) => d.message), [
    'Question Q1 says status=answered, but no answer exists, so it reads as open. Add a :::comment{kind=answer for=Q1} with the answer.',
  ]);
  assert.equal(found(QUESTIONS, 'question/reason').length, 1);
  assert.deepEqual(found(QUESTIONS.replace('status=withdrawn', 'status=withdrawn reason="Out of scope"'), 'question/reason'), []);
  const overdue = found(QUESTIONS, 'question/overdue');
  assert.deepEqual(overdue.map((d) => [d.line + 1, d.severity]), [[10, 'info']]);
});

test('AF21: a bare question selector matches every question; question[status=open] also matches the ones without a status', () => {
  assert.equal(querySmd(QUESTIONS, 'question').length, 6);
  assert.deepEqual(querySmd(QUESTIONS, 'question[status=open]').map((m) => m.title), ['Plain question', 'Written answered, no answer', 'Which store?']);
  assert.deepEqual(querySmd(QUESTIONS, 'question[status=answered]').map((m) => m.title), ['Answered elsewhere']);
  assert.equal(querySmd(QUESTIONS, 'question[id=Q1]')[0].attrs.status, 'answered', 'attributes stay as written on the match');
});

test('R51 (AF11): between= renders both blocks as conflicting links, and nothing picks a winner', () => {
  const html = renderSmd(QUESTIONS, { today: TODAY }).html;
  assert.match(html, /conflict between <a class="smd-ref smd-conflict" href="#D1" title="Use files"[^>]*>D1<\/a> and <a class="smd-ref smd-conflict" href="#D2" title="Use a database"[^>]*>D2<\/a>/);
  assert.match(html, /<div class="smd-question-facts"><span class="smd-pill smd-pill-status smd-pill-status-open">open<\/span><span class="smd-block-facts">@maya<span class="smd-dot">·<\/span>Due 2026-01-01<span class="smd-due-note"> · overdue<\/span><\/span><\/div>/);
  assert.match(smdToMarkdown(QUESTIONS), /^> \*\*Question Q5\*\* · open · conflict between D1 and D2$/m);
});

test('R63: questions without lifecycle attributes render, export and view as before', () => {
  const text = v2(':::question{#Q1 title="Must acceptance blocks nest?"}\nBody.\n:::\n\n:::question Plain\n:::');
  assert.doesNotMatch(renderSmd(text).html, /smd-question-facts/);
  assert.match(agentView(text).text, /^<question title="Must acceptance blocks nest\?">$/m);
  assert.match(smdToMarkdown(text), /^> \[!IMPORTANT\]\n> \*\*Must acceptance blocks nest\?\*\*$/m);
});

test('AC14 (R50): the catalog counts open questions only, once a question uses the lifecycle', () => {
  const text = v2(':::question{#Q1} Open\n:::\n\n:::question{#Q2 status=answered} Answered\n:::\n\n:::comment{kind=answer for=Q2}\nYes.\n:::');
  assert.equal(indexEntry(text, 'q.smd', { today: TODAY }).counts.questions, 1);
  assert.equal(indexEntry(v2(':::question A\n:::\n\n:::question B\n:::'), 'q.smd', { today: TODAY }).counts.questions, 2);
});

// --- Decisions -----------------------------------------------------------------------------------------------------

const SUPERSEDES = v2(':::decision{#D3 status=accepted} Use files\n:::\n\n:::decision{#D7 status=accepted supersedes=D3} Use a database\n:::\n\n:::decision{#D4} No status\n:::\n\n:::decision{#D8 supersedes=D4} Replaces it\n:::');

test('AC15 (R52): decision/supersedes warns on the superseded decision, and the fix sets status=superseded', () => {
  const diags = found(SUPERSEDES, 'decision/supersedes');
  assert.deepEqual(diags.map((d) => d.message), [
    'Decision D3 is superseded by D7, but its status is accepted. Set status=superseded.',
    'Decision D4 is superseded by D8, but its status is proposed. Set status=superseded.',
  ]);
  const fixed = applyFixes(SUPERSEDES, diags).text;
  assert.match(fixed, /^:::decision\{#D3 status=superseded\} Use files$/m);
  assert.match(fixed, /^:::decision\{#D4 status=superseded\} No status$/m);
  assert.deepEqual(found(fixed, 'decision/supersedes'), []);
});

test('R53: a view that shows a superseded decision adds superseded-by, and decisions without links read as before', () => {
  const view = agentView(SUPERSEDES).text;
  assert.match(view, /^<decision id="D3" status="accepted" superseded-by="D7"> Use files$/m);
  assert.match(view, /^<decision id="D7" status="accepted" supersedes="D3"> Use a database$/m);
  assert.match(agentView(v2(':::decision{#D1 status=accepted} Plain\n:::')).text, /^<decision status="accepted"> Plain$/m);
  assert.match(renderSmd(SUPERSEDES).html, /superseded by <a class="smd-ref" href="#D7"/);
  assert.match(smdToMarkdown(SUPERSEDES), /^> \*\*Decision D3 \(accepted · superseded by D7\): Use files\*\*$/m);
});

// --- Dependencies --------------------------------------------------------------------------------------------------

const TASKS = v2([
  ':::requirement{#R7 status=proposed} Proposed', ':::', '',
  ':::requirement{#R8 status=implemented} Done', ':::', '',
  ':::question{#Q1} Open', ':::', '',
  '## Tasks', '',
  '- [ ] Build it :depends[R7] {#T1}',
  '- [ ] Ship it :depends[T1,R8]',
  '- [x] Done first {#T0}',
  '- [ ] After that :depends[T0, R8]',
  '- [ ] Ask first :depends[Q1] @maya',
  '- [ ] No dependency',
].join('\n'));

test('AC12 (R47): smd tasks shows a task as blocked while what it depends on is not done', () => {
  const rows = extractTasks(TASKS, TODAY).filter((t) => !t.done).map((t) => ({ ...t, file: 'plan.smd' }));
  assert.deepEqual(rows.map((r) => [r.text, r.depends, r.blocked]), [
    ['Build it', ['R7'], ['R7']],
    ['Ship it', ['T1', 'R8'], ['T1']],
    ['After that', ['T0', 'R8'], []],
    ['Ask first', ['Q1'], ['Q1']],
    ['No dependency', undefined, undefined],
  ]);
  assert.equal(taskLine(rows[0]), 'plan.smd:17  [ ] Build it (depends on R7; BLOCKED by R7) {#T1}  — Tasks');
  assert.equal(taskLine(rows[2]), 'plan.smd:20  [ ] After that (depends on T0, R8)  — Tasks');
  assert.equal(taskLine(rows[3]), 'plan.smd:21  [ ] Ask first @maya (depends on Q1; BLOCKED by Q1)  — Tasks');
  assert.equal(taskLine(rows[4]), 'plan.smd:22  [ ] No dependency  — Tasks');
  assert.equal(taskSummary(rows, false), '5 task(s) open, 3 blocked.');
});

test('R47: task[depends=R1] selects the tasks that depend on a block', () => {
  assert.deepEqual(querySmd(TASKS, 'task[depends=R8]', { today: TODAY }).map((m) => m.title), ['Ship it', 'After that']);
  assert.deepEqual(querySmd(TASKS, 'task[blocked=true]', { today: TODAY }).map((m) => m.title), ['Build it', 'Ship it', 'Ask first']);
});

test('R47: :depends renders as "depends on" with links, and the agent view keeps the ids readable', () => {
  assert.match(renderSmd(TASKS).html, /<span class="smd-depends">depends on <a class="smd-ref" href="#T1">T1<\/a>, <a class="smd-ref" href="#R8">R8<\/a><\/span>/);
  assert.match(agentView(TASKS).text, /^- \[ \] Ship it \(depends on T1, R8\)$/m);
  assert.match(smdToMarkdown(TASKS), /^- \[ \] Ship it \(depends on T1, R8\)$/m);
});

test('AC17 (R61): in spec v1 :depends stays text, and tasks have no dependencies', () => {
  const text = v1('- [ ] Build it :depends[R7]');
  assert.match(renderSmd(text).html, /Build it :depends\[R7\]/);
  assert.match(agentView(text).text, /Build it :depends\[R7\]/);
  assert.equal(extractTasks(text)[0].depends, undefined);
});

test('R47: tasks without :depends list as before', () => {
  const rows = extractTasks(v2('## T\n\n- [ ] Plain @maya :due[2026-12-01]'), TODAY).map((t) => ({ ...t, file: 'a.smd' }));
  assert.equal(taskLine(rows[0]), 'a.smd:8  [ ] Plain @maya (due 2026-12-01)  — T');
  assert.equal(Object.hasOwn(rows[0], 'depends') || Object.hasOwn(rows[0], 'blocked'), false);
  assert.equal(taskSummary(rows, false), '1 task(s) open.');
});

test('R46: depends-on is shown on the blocks that take it', () => {
  const text = v2(':::requirement{#R1 depends-on=A1} X\n:::\n\n:::risk{#K1 impact=high depends-on=R1} Y\n:::\n\n:::assumption{#A1} Z\n:::');
  const view = agentView(text).text;
  assert.match(view, /^<requirement id="R1" status="proposed" depends-on="A1"> X$/m);
  assert.match(view, /^<risk id="K1" impact="high" depends-on="R1"> Y$/m);
  assert.match(renderSmd(text).html, /depends on <a class="smd-ref" href="#A1"/);
});
