import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptSuggestion, addComment, addSuggestion, answerQuestion, incorporateQuestion, rebaseItem, rejectSuggestion, reopenItem, resolveComment,
  reviewItems, withdrawItem, type ReviewResult,
} from '../src/core/review';
import { blockRevision } from '../src/core/revision';

/**
 * The review writes (feedback loop RFC, "Review comments and suggestions"; research contract, "Responses and
 * transitions"). Every transition records by and on (AF08, AF09), stale items are refused (AF10), and every line no
 * transition touches stays byte for byte (collaboration RFC, implementation constraints).
 */

const doc = (body: string) => `---\nsmd: 2\ntitle: T\n---\n\n${body}\n`;
const who = { by: '@maya', today: '2026-11-07' };

function ok(result: ReviewResult): string {
  if (!result.ok) assert.fail(result.error);
  return result.text;
}

function refused(result: ReviewResult, pattern: RegExp): void {
  assert.equal(result.ok, false, 'expected a refusal');
  if (!result.ok) assert.match(result.error, pattern);
}

const REQ = ':::requirement{#R1} Cache results\nThe cache keeps results for 10 minutes.\n:::';

/** Lines of `after` that are not in `before`, and the other way round, as multisets. */
function changedLines(before: string, after: string): { added: string[]; removed: string[] } {
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const a = count(before.split('\n'));
  const b = count(after.split('\n'));
  const added = [...b].flatMap(([l, n]) => Array(Math.max(0, n - (a.get(l) ?? 0))).fill(l));
  const removed = [...a].flatMap(([l, n]) => Array(Math.max(0, n - (b.get(l) ?? 0))).fill(l));
  return { added, removed };
}

test('AF08: a comment goes after its target with for, author, date and the target revision', () => {
  const text = doc(`${REQ}\n\nAfter.`);
  const out = ok(addComment(text, 'R1', { ...who, text: 'Pricing changes hourly.', title: 'Too long?' }));
  const rev = (blockRevision(text, 'R1') as { revision: string }).revision;
  assert.ok(out.includes(`:::\n\n:::comment{for=R1 author=@maya date=2026-11-07 rev=${rev}} Too long?\nPricing changes hourly.\n:::\n\nAfter.`), out);
  assert.deepEqual(changedLines(text, out).removed, []);
  const [item] = reviewItems(out);
  assert.equal(item.type, 'comment');
  assert.equal(item.kind, 'remark');
  assert.equal(item.status, 'open');
  assert.equal(item.stale, false);
});

test('AF10: an item is stale once its target text changes, and an attribute change does not make it stale', () => {
  let text = ok(addSuggestion(doc(REQ), 'R1', { ...who, text: 'The cache keeps results for 5 minutes.' }));
  assert.equal(reviewItems(text)[0].stale, false);
  text = text.replace(':::requirement{#R1}', ':::requirement{#R1 status=accepted}');
  assert.equal(reviewItems(text)[0].stale, false);
  text = text.replace('10 minutes', '15 minutes');
  assert.equal(reviewItems(text)[0].stale, true);
});

test('AF09, AF10: accept replaces the target body, records accepted by and on, and is refused when stale', () => {
  const text = ok(addSuggestion(doc(`${REQ}\n\nAfter.`), 'R1', { ...who, text: 'The cache keeps results for 5 minutes.' }));
  const stale = text.replace('10 minutes', '20 minutes');
  const line = String(reviewItems(text)[0].line + 1);
  refused(acceptSuggestion(stale, line, who), /stale/);
  const out = ok(acceptSuggestion(text, line, { by: 'lee', today: '2026-11-08' }));
  assert.match(out, /:::requirement\{#R1\} Cache results\nThe cache keeps results for 5 minutes\.\n:::/);
  assert.match(out, /:::suggestion\{for=R1 author=@maya date=2026-11-07 rev=[0-9a-f]{12} status=accepted by=@lee on=2026-11-08\}/);
  const { added, removed } = changedLines(text, out);
  assert.equal(added.length, 2);
  assert.equal(removed.length, 2);
  // The record stays and is closed.
  const [item] = reviewItems(out);
  assert.equal(item.open, false);
  refused(acceptSuggestion(out, line, who), /accepted: reopen/);
});

test('AC-B: accept keeps review blocks nested in the target, and every other line', () => {
  const body = ':::requirement{#R1} Cache\nOld text.\n\n:::comment{for=R1 author=@a rev=000000000000} Note\nKeep me.\n:::\n:::\n\nTail line.';
  const text = ok(addSuggestion(doc(body), 'R1', { ...who, text: 'New text.' }));
  const out = ok(acceptSuggestion(text, String(reviewItems(text)[1].line + 1), who));
  assert.match(out, /:::requirement\{#R1\} Cache\nNew text\.\n\n:::comment\{for=R1 author=@a rev=000000000000\} Note\nKeep me\.\n:::\n:::/);
  assert.ok(out.endsWith('Tail line.\n'));
});

test('accept on a task replaces its text and keeps the checkbox and id', () => {
  const text = ok(addSuggestion(doc('- [x] Ship the cache {#T1}\n- [ ] Other'), 'T1', { ...who, text: 'Ship the cache behind a flag' }));
  assert.match(text, /- \[ \] Other\n\n:::suggestion\{for=T1/);
  const out = ok(acceptSuggestion(text, String(reviewItems(text)[0].line + 1), who));
  assert.match(out, /- \[x\] Ship the cache behind a flag \{#T1\}\n- \[ \] Other/);
  refused(addSuggestion(doc('- [ ] A {#T1}'), 'T1', { ...who, text: 'one\ntwo' }), /one line/);
});

test('accept on a heading replaces its own section body and keeps the suggestion in it', () => {
  const body = '## Cache {#cache}\n\nOld words.\n\n## Next\n\nStays.';
  const text = ok(addSuggestion(doc(body), 'cache', { ...who, text: 'New words.' }));
  assert.match(text, /Old words\.\n\n:::suggestion\{for=cache[^\n]*\nNew words\.\n:::\n\n## Next/);
  const result = acceptSuggestion(text, String(reviewItems(text)[0].line + 1), who);
  const out = ok(result);
  assert.match(out, /## Cache \{#cache\}\n\nNew words\.\n\n:::suggestion\{for=cache[^\n]*status=accepted[^\n]*\}\nNew words\.\n:::\n\n## Next\n\nStays\.\n$/);
  assert.ok(result.ok && out.split('\n')[result.line].startsWith(':::suggestion'));
});

test('CRLF documents keep CRLF on every line, including the inserted ones', () => {
  const text = doc(`${REQ}\n\nAfter.`).replaceAll('\n', '\r\n');
  const out = ok(addSuggestion(text, 'R1', { ...who, text: 'New.' }));
  assert.ok(!/[^\r]\n/.test(out), 'a bare LF crept in');
  const accepted = ok(acceptSuggestion(out, String(reviewItems(out)[0].line + 1), who));
  assert.ok(!/[^\r]\n/.test(accepted));
  assert.match(accepted, /:::requirement\{#R1\} Cache results\r\nNew\.\r\n:::/);
});

test('a document without a final line break keeps none', () => {
  const text = `---\nsmd: 2\n---\n\n${REQ}`;
  const out = ok(addComment(text, 'R1', { ...who, text: 'Hm.' }));
  assert.ok(out.endsWith(':::\n\n:::comment{for=R1 author=@maya date=2026-11-07 rev=' + (blockRevision(text, 'R1') as { revision: string }).revision + '}\nHm.\n:::'));
});

test('reject, withdraw, resolve and reopen record by and on and refuse the wrong state', () => {
  let text = ok(addSuggestion(doc(REQ), 'R1', { ...who, text: 'X.' }));
  text = ok(addComment(text, 'R1', { ...who, text: 'Y.' }));
  const [comment, suggestion] = reviewItems(text).sort((a, b) => a.type.localeCompare(b.type));
  const s = String(suggestion.line + 1);
  const c = String(comment.line + 1);
  refused(resolveComment(text, s, who), /suggestion/);
  refused(rejectSuggestion(text, c, who), /comment/);
  refused(withdrawItem(text, s, { ...who, reason: '' }), /--reason/);
  refused(rejectSuggestion(text, s, { by: '', today: '2026-11-07' }), /--by/);
  const rejected = ok(rejectSuggestion(text, s, { ...who, reason: 'Too short' }));
  assert.match(rejected, /status=rejected by=@maya on=2026-11-07 reason="Too short"/);
  const reopened = ok(reopenItem(rejected, s, { by: '@lee', today: '2026-11-09' }));
  assert.match(reopened, /status=open by=@lee on=2026-11-09\}/);
  assert.doesNotMatch(reopened, /reason=/);
  const resolved = ok(resolveComment(text, c, who));
  assert.match(resolved, /:::comment\{for=R1 author=@maya date=2026-11-07 rev=[0-9a-f]+ status=resolved by=@maya on=2026-11-07\}/);
  refused(resolveComment(resolved, c, who), /resolved already/);
  refused(reopenItem(text, c, who), /open already/);
  refused(acceptSuggestion(text, '999', who), /No comment or suggestion opens on line 999/);
  refused(acceptSuggestion(text, 'nope', who), /No comment or suggestion with id "nope"/);
});

test('rebase records the target revision now, after which accept goes through', () => {
  const text = ok(addSuggestion(doc(REQ), 'R1', { ...who, text: 'New.' })).replace('10 minutes', '20 minutes');
  const line = String(reviewItems(text)[0].line + 1);
  refused(acceptSuggestion(text, line, who), /stale/);
  const rebased = ok(rebaseItem(text, line, { by: '@lee', today: '2026-11-08' }));
  assert.equal(reviewItems(rebased)[0].stale, false);
  assert.match(rebased, /by=@lee on=2026-11-08/);
  ok(acceptSuggestion(rebased, line, who));
});

test('a suggestion without rev is refused, and an ambiguous or unknown target too', () => {
  const noRev = doc(`${REQ}\n\n:::suggestion{for=R1 author=@a}\nNew.\n:::`);
  refused(acceptSuggestion(noRev, String(reviewItems(noRev)[0].line + 1), who), /no rev/);
  refused(addComment(doc(REQ), 'R9', { ...who, text: 'x' }), /No block with id "R9"/);
  const twice = doc(`${REQ}\n\n:::decision{#R1} Also R1\n:::`);
  refused(addComment(twice, 'R1', { ...who, text: 'x' }), /id of 2 blocks/);
});

test('answer adds a kind=answer comment after the question and sets it answered; incorporate needs an answer', () => {
  const text = doc(':::question{#Q1} Which TTL?\nTen or five minutes?\n:::\n\nNext.');
  refused(incorporateQuestion(text, 'Q1', who), /not answered/);
  const answered = ok(answerQuestion(text, 'Q1', { ...who, text: 'Five.' }));
  assert.match(answered, /:::question\{#Q1 status=answered by=@maya on=2026-11-07\} Which TTL\?/);
  assert.match(answered, /:::\n\n:::comment\{for=Q1 author=@maya date=2026-11-07 rev=[0-9a-f]{12} kind=answer\}\nFive\.\n:::\n\nNext\./);
  const item = reviewItems(answered)[0];
  assert.equal(item.answer, true);
  refused(resolveComment(answered, String(item.line + 1), who), /answers a question/);
  const incorporated = ok(incorporateQuestion(answered, 'Q1', { by: '@lee', today: '2026-11-09' }));
  assert.match(incorporated, /:::question\{#Q1 status=incorporated by=@lee on=2026-11-09\}/);
  refused(answerQuestion(incorporated, 'Q1', { ...who, text: 'More' }), /incorporated: reopen/);
  const withdrawn = ok(withdrawItem(text, 'Q1', { ...who, reason: 'Out of scope' }));
  assert.match(withdrawn, /:::question\{#Q1 status=withdrawn reason="Out of scope" by=@maya on=2026-11-07\}/);
  assert.match(ok(reopenItem(withdrawn, 'Q1', who)), /:::question\{#Q1 status=open by=@maya on=2026-11-07\}/);
});

test('a body with its own fences gets a longer fence', () => {
  const out = ok(addSuggestion(doc(REQ), 'R1', { ...who, text: ':::note\nInner.\n:::' }));
  assert.match(out, /::::suggestion\{[^\n]*\}\n:::note\nInner\.\n:::\n::::/);
});

test('review blocks inside code are not items', () => {
  const text = doc('```\n:::comment{for=R1}\nx\n:::\n```');
  assert.deepEqual(reviewItems(text), []);
});
