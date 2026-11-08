import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEW_HELP, runReview, type ReviewArgs } from '../src/reviewCommand';

/** `smd review` and its transitions (feedback loop RFC, "Commands"): AF08, AF09, AF10. */

function args(positional: string[], values: Record<string, string> = {}, flags: string[] = []): ReviewArgs {
  return { positional, flags: new Set(flags), values: new Map(Object.entries(values).map(([k, v]) => [k, [v]])) };
}

/** Run with console output captured. */
function run(a: ReviewArgs): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...m: unknown[]) => { out.push(m.join(' ')); };
  console.error = (...m: unknown[]) => { err.push(m.join(' ')); };
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    return { code: runReview(a), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
}

function withFile(text: string, body: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'smd-review-'));
  const file = join(dir, 'doc.smd');
  writeFileSync(file, text);
  try {
    body(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DOC = '---\r\nsmd: 2\r\ntitle: T\r\n---\r\n\r\n:::requirement{#R1} Cache\r\nTen minutes.\r\n:::\r\n';
const who = { '--by': 'maya', '--today': '2026-11-07' };

test('AF08, AF09: suggest, list, accept: attributed, CRLF kept, refused when stale', () => {
  withFile(DOC, (file) => {
    const added = run(args(['suggest', file, 'R1'], { ...who, '--text': 'Five minutes.' }));
    assert.equal(added.code, 0, added.err);
    assert.match(added.out, /doc\.smd:10: Added a suggestion for R1\./);
    let text = readFileSync(file, 'utf8');
    assert.ok(!/[^\r]\n/.test(text));
    assert.match(text, /:::suggestion\{for=R1 author=@maya date=2026-11-07 rev=[0-9a-f]{12}\}\r\nFive minutes\.\r\n:::\r\n$/);

    const listed = run(args([file]));
    assert.match(listed.out, /doc\.smd:10: suggestion for R1, @maya, 2026-11-07/);
    const json = JSON.parse(run(args([file], {}, ['--json'])).out);
    assert.equal(json[0].line, 10);
    assert.equal(json[0].stale, false);

    writeFileSync(file, text.replace('Ten minutes.', 'Twenty minutes.'));
    assert.match(run(args([file])).out, /\[stale\]/);
    const stale = run(args(['accept', file, '10'], who));
    assert.equal(stale.code, 1);
    assert.match(stale.err, /stale/);

    const rebased = run(args(['rebase', file, '10'], who));
    assert.equal(rebased.code, 0, rebased.err);
    assert.match(rebased.out, /^R1 now \(rev [0-9a-f]{12}\):\n {2}Cache\n {2}Twenty minutes\./);
    const accepted = run(args(['accept', file, '10'], { '--by': '@lee', '--today': '2026-11-08' }));
    assert.equal(accepted.code, 0, accepted.err);
    text = readFileSync(file, 'utf8');
    assert.match(text, /:::requirement\{#R1\} Cache\r\nFive minutes\.\r\n:::/);
    assert.match(text, /status=accepted by=@lee on=2026-11-08\}/);
    assert.equal(run(args([file])).out, 'No open comments or suggestions.');
    assert.match(run(args([file], {}, ['--all'])).out, /\[accepted by @lee on 2026-11-08\]/);
  });
});

test('usage errors exit 2 and refusals exit 1, and neither writes', () => {
  withFile(DOC, (file) => {
    assert.equal(run(args(['comment', file, 'R1'], { '--text': 'x' })).code, 2);
    assert.equal(run(args(['comment', file, 'R1'], who)).code, 2);
    assert.equal(run(args(['withdraw', file, '10'], who)).code, 2);
    assert.equal(run(args(['comment', file, 'R1'], { ...who, '--text': 'x', '--kind': 'answer' })).code, 2);
    assert.equal(run(args(['resolve', file, '99'], who)).code, 1);
    assert.equal(run(args(['comment', file, 'R2'], { ...who, '--text': 'x' })).code, 1);
    assert.equal(readFileSync(file, 'utf8'), DOC);
  });
});

test('comment, resolve, answer, incorporate, withdraw and reopen from the command line', () => {
  const text = '---\nsmd: 2\n---\n\n:::question{#Q1} TTL?\nWhich?\n:::\n\n:::requirement{#R1} Cache\nTen.\n:::\n';
  withFile(text, (file) => {
    assert.equal(run(args(['comment', file, 'R1'], { ...who, '--text': 'Hm.', '--title': 'Why ten?' })).code, 0);
    const line = String(readFileSync(file, 'utf8').split('\n').findIndex((l) => l.startsWith(':::comment')) + 1);
    assert.equal(run(args(['resolve', file, line], who)).code, 0);
    assert.equal(run(args(['answer', file, 'Q1'], { ...who, '--text': 'Five.' })).code, 0);
    assert.equal(run(args(['incorporate', file, 'Q1'], who)).code, 0);
    const out = readFileSync(file, 'utf8');
    assert.match(out, /:::question\{#Q1 status=incorporated by=@maya on=2026-11-07\} TTL\?/);
    assert.match(out, /:::comment\{for=Q1 author=@maya date=2026-11-07 rev=[0-9a-f]{12} kind=answer\}\nFive\.\n:::/);
    assert.match(out, /:::comment\{for=R1 author=@maya date=2026-11-07 rev=[0-9a-f]{12} status=resolved by=@maya on=2026-11-07\} Why ten\?/);
    assert.equal(run(args(['reopen', file, 'Q1'], who)).code, 0);
    assert.equal(run(args(['withdraw', file, 'Q1'], { ...who, '--reason': 'Dropped' })).code, 0);
    assert.match(readFileSync(file, 'utf8'), /:::question\{#Q1 status=withdrawn reason=Dropped by=@maya on=2026-11-07\}/);
  });
});

test('the help names every subcommand', () => {
  for (const sub of ['comment', 'suggest', 'answer', 'incorporate', 'accept', 'reject', 'withdraw', 'resolve', 'reopen', 'rebase']) {
    assert.match(REVIEW_HELP, new RegExp(`\\b${sub}\\b`), sub);
  }
});
