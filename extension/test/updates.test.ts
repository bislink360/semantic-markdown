import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedbackUpdates, formatFeedbackUpdates, querySmd, revisionOfText, UPDATES_NOTE } from '../src/core';
import { runUpdates } from '../src/updatesCommand';

const hasGit = spawnSync('git', ['--version']).status === 0;

const before = [
  '---',
  'smd: 2',
  'title: Plan',
  '---',
  '',
  '## Requirements',
  '',
  ':::requirement{#R1 status=accepted} Pay with a card',
  'The user pays with a saved card.',
  ':::',
  '',
  ':::question{#Q1} Which card brands?',
  'Do we take Amex?',
  ':::',
  '',
  ':::question{#Q2 status=withdrawn reason="out of scope"} Crypto?',
  ':::',
  '',
  ':::suggestion{#S1 for=R1 author=@ann date=2026-11-01} Debit cards too',
  'The user pays with a saved credit or debit card.',
  ':::',
  '',
  ':::acceptance{#AC1 verifies=R1} Card payment works',
  'Given a saved card, the order is placed.',
  ':::',
  '',
  '## Tasks',
  '',
  '- [x] Build the card form {#T1}',
  '- [ ] Write the docs',
  '- [ ] Add Apple Pay :depends[Q1] {#T3}',
  '',
  '## Notes',
  '',
  'Some text.',
  '',
].join('\n');

const after = [
  '---',
  'smd: 2',
  'title: Plan',
  '---',
  '',
  '## Requirements',
  '',
  ':::requirement{#R1 status=accepted} Pay with a card',
  'The user pays with a saved card.',
  ':::',
  '',
  ':::question{#Q1 status=answered} Which card brands?',
  'Do we take Amex?',
  ':::',
  '',
  ':::comment{kind=answer for=Q1 author=@bo date=2026-11-06}',
  'Visa and Mastercard only.',
  ':::',
  '',
  ':::question{#Q2 status=open} Crypto?',
  ':::',
  '',
  ':::suggestion{#S1 for=R1 author=@ann date=2026-11-01 status=rejected by=@maya on=2026-11-07} Debit cards too',
  'The user pays with a saved credit or debit card.',
  ':::',
  '',
  ':::acceptance{#AC1 verifies=R1} Card payment works',
  'Given a saved card, the order is placed and a receipt is shown.',
  ':::',
  '',
  '## Tasks',
  '',
  '- [ ] Build the card form {#T1}',
  '- [x] Write the docs',
  '- [ ] Add Apple Pay :depends[Q1] {#T3}',
  '',
  '## Notes',
  '',
  'Some other text.',
  'And a second line.',
  '',
].join('\n');

const summary = (text: string, other: string) => feedbackUpdates(text, other, { file: 'plan.smd' }).changes.map((c) => `${c.kind} ${c.id ?? c.title} ${c.change}`);

test('AF22: updates since a checkpoint list the dispositions that changed, by block id', () => {
  assert.deepEqual(summary(before, after), [
    'question Q1 answered',
    'comment  added',
    'question Q2 reopened',
    'suggestion S1 rejected',
    'acceptance AC1 changed',
    'task T1 reopened',
    'task Write the docs checked',
  ]);
});

test('AF22: each change names the blocks that point at it, and other lines are counted, not replayed', () => {
  const u = feedbackUpdates(before, after, { file: 'plan.smd' });
  const by = (id: string) => u.changes.find((c) => c.id === id)!;
  assert.deepEqual(by('Q1').affected.map((a) => `${a.type} ${a.id ?? a.title} ${a.edge}`), ['comment  for', 'task T3 depends-on']);
  assert.deepEqual(by('S1').affected.map((a) => `${a.id} ${a.edge}`), ['R1 for']);
  assert.equal(by('S1').by, '@maya');
  assert.equal(by('S1').on, '2026-11-07');
  assert.equal(by('AC1').revision?.before === by('AC1').revision?.after, false);
  const answer = u.changes.find((c) => c.kind === 'comment')!;
  assert.equal(answer.commentKind, 'answer');
  assert.equal(answer.for, 'Q1');
  assert.equal(answer.matchedBy, 'text');
  assert.equal(u.changes.find((c) => c.title === 'Write the docs')!.matchedBy, 'text');
  // Notes: one line changed and one added, outside every block reported.
  assert.equal(u.otherChangedLines, 3);
  const text = formatFeedbackUpdates(u, { since: 'HEAD (abc1234)', next: { revision: revisionOfText(after) }, file: 'plan.smd' });
  assert.match(text, /^- question Q1 answered \(open → answered\) \[L12\] · affected: comment \(for\) \[L16\], task T3 \(depends-on\) \[L35\]$/m);
  assert.match(text, /^- suggestion S1 for R1 rejected \(open → rejected\) by @maya on 2026-11-07 \[L23\] · affected: requirement R1 \(for\) \[L8\]$/m);
  assert.match(text, /^- task "Write the docs" checked \[L34\] \(matched by text\)$/m);
  assert.match(text, /^3 other changed lines, not listed/m);
  assert.doesNotMatch(text, /Some other text|Visa and Mastercard/, 'content is not replayed');
  assert.ok(text.endsWith(`${UPDATES_NOTE}\n`));
});

test('AF22: an answered status without an answer still reads as open, so it is not reported as answered', () => {
  const claimed = before.replace(':::question{#Q1}', ':::question{#Q1 status=answered}');
  assert.ok(!summary(before, claimed).some((s) => s.startsWith('question Q1')));
});

test('AF22: added and removed blocks, and status changes of decisions', () => {
  const a = '---\nsmd: 2\n---\n\n:::decision{#D1 status=proposed} Use Postgres\n:::\n\n:::constraint{#C1} No PII\n:::\n';
  const b = '---\nsmd: 2\n---\n\n:::decision{#D1 status=accepted by=@lee} Use Postgres\n:::\n\n:::evidence{#E1 supports=D1 result=pass} Load test\n:::\n';
  assert.deepEqual(summary(a, b), ['decision D1 status', 'evidence E1 added', 'constraint C1 removed']);
  const u = feedbackUpdates(a, b);
  assert.deepEqual(u.changes[0].affected.map((x) => `${x.id} ${x.edge}`), ['E1 supports']);
  assert.deepEqual(feedbackUpdates(a, a).changes, []);
  assert.equal(feedbackUpdates(a, a).otherChangedLines, 0);
});

test('AF21: lifecycle filters retrieve open requests, answers, rejected feedback and reopened work', () => {
  const ids = (selector: string) => querySmd(after, selector, { today: '2026-11-07' }).map((m) => (typeof m.attrs.id === 'string' ? m.attrs.id : m.title));
  assert.deepEqual(ids('question'), ['Q1', 'Q2'], 'a bare query keeps matching every question');
  assert.deepEqual(ids('question[status=answered]'), ['Q1']);
  assert.deepEqual(ids('question[status=open]'), ['Q2']);
  assert.deepEqual(ids('question:not([status=answered|incorporated|withdrawn])'), ['Q2']);
  assert.deepEqual(ids('comment[kind=answer][for=Q1]'), ['']);
  assert.deepEqual(ids('suggestion[status=rejected]'), ['S1']);
  assert.deepEqual(ids('task[done=false]'), ['T1', 'T3']);
  // A question without a status is open: with the tag defaults of semantic tags phase 2, question[status=open] matches
  // it too. On a base without them, :not() finds it.
  const unwritten = querySmd(before, 'question:not([status=answered|incorporated|withdrawn])').map((m) => m.attrs.id);
  assert.deepEqual(unwritten, ['Q1']);
});

/** A temporary repository with plan.smd committed at `before`. */
function repo(): { dir: string; file: string; git: (...args: string[]) => string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'smd-updates-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  const file = join(dir, 'plan.smd');
  writeFileSync(file, before);
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'plan');
  return { dir, file, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('AC-E: a stored checkpoint precedes an answer, a rejection and a reopened task', { skip: !hasGit && 'git is not installed' }, () => {
  const r = repo();
  try {
    const checkpoint = `rev:${revisionOfText(before)}`;
    writeFileSync(r.file, after);
    const status = r.git('status', '--porcelain');

    for (const since of [checkpoint, 'HEAD', 'main']) {
      const out = runUpdates(r.file, since);
      assert.equal(out.code, 0, out.stderr);
      // The current dispositions and their affected targets.
      assert.match(out.stdout, /^- question Q1 answered .* · affected: .*task T3 \(depends-on\)/m);
      assert.match(out.stdout, /^- suggestion S1 for R1 rejected .*by @maya.* · affected: requirement R1 \(for\)/m);
      assert.match(out.stdout, /^- task T1 reopened \[L33\]$/m);
      // Without replaying unrelated history.
      assert.doesNotMatch(out.stdout, /Some other text|And a second line/);
      assert.match(out.stdout, /^3 other changed lines, not listed/m);
      // The next checkpoint, and retrieval is not incorporation.
      assert.match(out.stdout, new RegExp(`^Next checkpoint: --since rev:${revisionOfText(after)}$`, 'm'));
      assert.ok(out.stdout.endsWith(`${UPDATES_NOTE}\n`));
    }
    assert.match(runUpdates(r.file, checkpoint).stdout, /since rev:[0-9a-f]{12} \(commit [0-9a-f]{7}\)/);

    // Nothing is recorded: the file and the repository are as they were.
    assert.equal(readFileSync(r.file, 'utf8'), after);
    assert.equal(r.git('status', '--porcelain'), status);
    assert.deepEqual(readdirSync(r.dir).sort(), ['.git', 'plan.smd']);

    // JSON for tools.
    const json = JSON.parse(runUpdates(r.file, 'HEAD', { json: true }).stdout);
    assert.equal(json.since.revision, revisionOfText(before));
    assert.equal(json.next.revision, revisionOfText(after));
    assert.equal(json.note, UPDATES_NOTE);
    assert.ok(json.changes.some((c: { id: string; change: string }) => c.id === 'S1' && c.change === 'rejected'));

    // Once committed, the next checkpoint names the commit too, and the current text is a checkpoint with no updates.
    r.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'answers');
    const head = r.git('rev-parse', '--short', 'HEAD').trim();
    const now = runUpdates(r.file, `rev:${revisionOfText(after)}`);
    assert.match(now.stdout, /^No feedback updates in .* since rev:[0-9a-f]{12} \(the current text\)\.$/m);
    assert.match(now.stdout, new RegExp(`--since rev:${revisionOfText(after)} or --since ${head}$`, 'm'));
  } finally {
    r.done();
  }
});

test('AC-E: an invalid checkpoint explains how to recover', { skip: !hasGit && 'git is not installed' }, () => {
  const r = repo();
  try {
    for (const since of ['rev:000000000000', 'no-such-branch', 'rev:abc']) {
      const out = runUpdates(r.file, since);
      assert.equal(out.code, 2);
      assert.equal(out.stdout, '');
      assert.match(out.stderr, new RegExp(`^Unknown checkpoint "${since}": .*read the document in full \\(smd read .*plan\\.smd --full\\), or pass a Git commit, tag or branch with --since <ref>\\.`));
    }
    assert.equal(runUpdates(r.file, undefined).code, 2);
  } finally {
    r.done();
  }
});

test('AC-E: outside Git, the current text is still a checkpoint and anything else needs the recovery path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-updates-nogit-'));
  try {
    const file = join(dir, 'plan.smd');
    writeFileSync(file, after);
    const same = runUpdates(file, `rev:${revisionOfText(after)}`);
    assert.equal(same.code, 0);
    assert.match(same.stdout, /^No feedback updates/m);
    // A temp folder may sit inside a repository on some machines; only check the message when it doesn't.
    const other = runUpdates(file, `rev:${revisionOfText(before)}`);
    assert.equal(other.code, 2);
    assert.match(other.stderr, /To recover, read the document in full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
