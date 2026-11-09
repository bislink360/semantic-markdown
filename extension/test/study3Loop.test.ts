import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentView, formatTrace, querySmd, revisionOfText, traceRequirements, UPDATES_NOTE, validateSmd, type FeedbackChange } from '../src/core';
import { blockRevision } from '../src/core/revision';
import { runRev } from '../src/revCommand';
import { runReview, type ReviewArgs } from '../src/reviewCommand';
import { runUpdates } from '../src/updatesCommand';

/**
 * The offline Study 3 loop (test/eval/study3/README.md): an agent raises uncertainty about a requirement, a person
 * answers it and rejects the agent's guess, the agent retrieves what changed since its checkpoint, the answer is
 * incorporated with the person's confirmation, the old verification goes stale, and the agent verifies again after a
 * code change. No model is called: a scripted agent follows fixed rules over what the tools show it. Every step uses
 * the commands a participant would (smd review, smd updates, smd rev, the trace and the agent view), in a temporary
 * Git repository with fixed commit dates.
 */

const hasGit = spawnSync('git', ['--version']).status === 0;
const FIXTURE = join(__dirname, 'eval', 'study3');
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const fixture = (name: string) => lf(readFileSync(join(FIXTURE, name), 'utf8'));

interface Script {
  agent: string;
  reviewer: string;
  dates: Record<'baseline' | 'question' | 'review' | 'incorporate' | 'fix', string>;
  question: { id: string; trigger: string; block: string[]; task: string };
  guess: { target: string; text: string };
  answer: { question: string; text: string };
  rejection: { reason: string };
  reopen: string;
  incorporation: { target: string; text: string };
  code: Array<{ label: string; retryStatuses: string[]; verdict: 'pass' | 'fail' }>;
}

interface Policy { maxRetries: number; retryStatuses: string[] }

const script = JSON.parse(fixture('script.json')) as Script;

/** A temporary repository holding the fixture, committed with fixed names and dates so every run is the same. */
class Repo {
  readonly dir = mkdtempSync(join(tmpdir(), 'smd-study3-'));
  readonly spec = join(this.dir, 'spec.smd');
  readonly policy = join(this.dir, 'retry.json');

  constructor() {
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'core.autocrlf', 'false');
    writeFileSync(this.spec, fixture('spec.smd'));
    writeFileSync(this.policy, fixture('retry.json'));
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, stdio: 'pipe', encoding: 'utf8' });
  }

  commit(message: string, date: string): string {
    this.git('add', '-A');
    const at = `${date}T12:00:00Z`;
    execFileSync('git', ['-c', 'user.name=study3', '-c', 'user.email=study3@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], {
      cwd: this.dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    });
    return this.git('rev-parse', '--short', 'HEAD').trim();
  }

  text(): string { return readFileSync(this.spec, 'utf8'); }
  write(text: string): void { writeFileSync(this.spec, text); }
  readPolicy(): Policy { return JSON.parse(readFileSync(this.policy, 'utf8')) as Policy; }
  writePolicy(p: Policy): void { writeFileSync(this.policy, JSON.stringify(p, null, 2) + '\n'); }
  done(): void { rmSync(this.dir, { recursive: true, force: true }); }
}

/** `smd review …` with its console output captured. */
function review(positional: string[], values: Record<string, string> = {}, flags: string[] = []): { code: number; out: string; err: string } {
  const args: ReviewArgs = { positional, flags: new Set(flags), values: new Map(Object.entries(values).map(([k, v]) => [k, [v]])) };
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...m: unknown[]) => { out.push(m.join(' ')); };
  console.error = (...m: unknown[]) => { err.push(m.join(' ')); };
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    return { code: runReview(args), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
}

const revOf = (text: string, id: string) => {
  const r = blockRevision(text, id);
  assert.equal(r.status, 'resolved', `${id} resolves`);
  return r.status === 'resolved' ? r : assert.fail();
};

/**
 * The scripted verification, standing in for the project's test suite: it checks the retry policy against what R1
 * says now. A run is a pure function of the two files, so its result is the same on every machine.
 */
function verify(spec: string, policy: Policy): { result: 'pass' | 'fail'; failures: string[] } {
  const r1 = revOf(spec, 'R1').text;
  const failures: string[] = [];
  const limit = /retried up to (\d+) times/.exec(r1);
  if (!limit || policy.maxRetries !== Number(limit[1])) failures.push(`maxRetries ${policy.maxRetries} does not match R1`);
  if (!policy.retryStatuses.includes('5xx')) failures.push('a 5xx is not retried');
  if (/4xx response is final/.test(r1) && policy.retryStatuses.includes('4xx')) failures.push('a 4xx is retried');
  if (/except 429/.test(r1) && !policy.retryStatuses.includes('429')) failures.push('a 429 is not retried');
  return { result: failures.length ? 'fail' : 'pass', failures };
}

/** Diagnostics that are errors: every version of the document must have none. */
const errors = (text: string) => validateSmd(text).filter((d) => d.severity === 'error').map((d) => `${d.line}:${d.code}`);
const trace = (text: string) => traceRequirements([{ path: 'spec.smd', text }]);
const r1Trace = (text: string) => trace(text).requirements.find((r) => r.id === 'R1')!;
const summary = (changes: FeedbackChange[]) => changes.map((c) => `${c.kind} ${c.id ?? c.title} ${c.change}`);

/**
 * The scripted agent: fixed rules in place of a model, as the runner tests use a scripted provider. It reads through
 * the agent view, keeps the revision it read as its checkpoint, and logs each action.
 */
class ScriptedAgent {
  checkpoint = '';
  readonly log: string[] = [];
  verifications: Array<{ commit: string; result: 'pass' | 'fail'; rev: string }> = [];

  /** Reads the requirements as an agent does and remembers the revision it read. */
  read(repo: Repo): string {
    const text = repo.text();
    this.checkpoint = `rev:${revisionOfText(text)}`;
    this.log.push(`read ${this.checkpoint}`);
    return agentView(text, { sections: ['Requirements'], lineRefs: false }).text;
  }

  /** The uncertainty rule: R1 says a failed delivery is retried, but not which responses count as failed. */
  uncertain(view: string): boolean {
    const r1 = /<requirement id="R1"[^>]*>([\s\S]*?)<\/requirement>/.exec(view)?.[1] ?? view;
    return !r1.includes(script.question.trigger);
  }

  /** Runs the verification and records it as evidence against R1's current revision and the commit it ran on. */
  verifyAndRecord(repo: Repo, id: string, date: string): 'pass' | 'fail' {
    const text = repo.text();
    const { result, failures } = verify(text, repo.readPolicy());
    const rev = revOf(text, 'R1').revision;
    const commit = repo.git('rev-parse', '--short', 'HEAD').trim();
    const note = result === 'pass' ? 'The retry policy check passed.' : `The retry policy check failed: ${failures.join(', ')}.`;
    repo.write(`${text}\n:::evidence{#${id} supports=R1 method=test result=${result} rev=R1@${rev} commit=${commit} by=${script.agent} date=${date}}\n${note}\n:::\n`);
    this.verifications.push({ commit, result, rev });
    this.log.push(`verify ${id} ${result} at ${commit}`);
    return result;
  }
}

test('Study 3 loop: uncertainty, answer and rejection, revision-aware retrieval, a reopened task, and verification after a code change', { skip: !hasGit && 'git is not installed' }, async (t) => {
  const repo = new Repo();
  const agent = new ScriptedAgent();
  const { agent: bot, reviewer: person, dates } = script;
  const measures: Record<string, unknown> = {};
  let c1 = '';
  let e1Rev = '';
  let falselyAccepted = false;
  try {
    await t.test('0. baseline: the agent verifies the shipped policy and records the evidence with rev and commit', () => {
      const base = repo.commit('baseline', dates.baseline);
      assert.deepEqual(errors(repo.text()), []);
      assert.equal(agent.verifyAndRecord(repo, 'E1', dates.baseline), 'pass');
      repo.commit('evidence E1', dates.baseline);
      e1Rev = revOf(repo.text(), 'R1').revision;
      assert.match(repo.text(), new RegExp(`:::evidence\\{#E1 supports=R1 method=test result=pass rev=R1@${e1Rev} commit=${base} by=@agent`));
      // smd rev prints the revision the record names.
      assert.equal(runRev(repo.spec, ['R1'], false).stdout.split('  ')[0], `R1@${e1Rev}`);
      const r1 = r1Trace(repo.text());
      assert.deepEqual([r1.evidence.passing, r1.evidence.outdated, r1.evidence.total], [1, 0, 1]);
      assert.deepEqual(validateSmd(repo.text()).filter((d) => d.code === 'evidence/stale'), []);
    });

    await t.test('1. the agent raises uncertainty: a question on R1, a dependent task, and a guess as a suggestion', () => {
      const view = agent.read(repo);
      measures.uncertaintyRaised = agent.uncertain(view);
      assert.ok(measures.uncertaintyRaised, 'R1 does not say which responses count as failed');
      // The question and the task are source edits, as an agent makes them.
      const text = repo.text()
        .replace('\n## Tasks\n', `\n${script.question.block.join('\n')}\n\n## Tasks\n`)
        .replace(/(- \[x\] Read the retry policy from retry\.json \{#T2\}\n)/, `$1${script.question.task}\n`);
      repo.write(text);
      const guess = review(['suggest', repo.spec, script.guess.target], { '--text': script.guess.text, '--by': bot, '--today': dates.question });
      assert.equal(guess.code, 0, guess.err);
      assert.deepEqual(errors(repo.text()), []);
      repo.commit('agent: question Q1, task T3, suggestion for R1', dates.question);

      // What a person sees: an open question, an open suggestion, both attributed.
      assert.deepEqual(querySmd(repo.text(), 'question[status=open]').map((m) => m.attrs.id), ['Q1']);
      assert.match(agentView(repo.text()).text, /<question id="Q1" status="open"/);
      const open = JSON.parse(review([repo.spec], {}, ['--json']).out) as Array<{ type: string; for: string; open: boolean; attrs: Record<string, string> }>;
      assert.deepEqual(open.map((i) => [i.type, i.for, i.attrs.author, i.attrs.rev]), [['suggestion', 'R1', bot, e1Rev]]);

      // The agent's checkpoint is the text it last read, its own edits included.
      agent.read(repo);
      c1 = agent.checkpoint;
    });

    await t.test('2. the person answers the question, rejects the guess and reopens the retry task', () => {
      const answered = review(['answer', repo.spec, script.answer.question], { '--text': script.answer.text, '--by': person, '--today': dates.review });
      assert.equal(answered.code, 0, answered.err);
      const [guess] = JSON.parse(review([repo.spec], {}, ['--json']).out) as Array<{ line: number }>;
      const rejected = review(['reject', repo.spec, String(guess.line)], { '--by': person, '--today': dates.review, '--reason': script.rejection.reason });
      assert.equal(rejected.code, 0, rejected.err);
      // Unchecking a task is a source edit in the editor; nothing records it but the text.
      repo.write(repo.text().replace(`- [x] Implement the retry loop :depends[R1] {#${script.reopen}}`, `- [ ] Implement the retry loop :depends[R1] {#${script.reopen}}`));
      assert.deepEqual(errors(repo.text()), []);
      repo.commit('review: answer Q1, reject the guess, reopen T1', dates.review);

      // The rejected guess changed nothing: R1 has the revision the evidence names.
      assert.equal(revOf(repo.text(), 'R1').revision, e1Rev);
      assert.ok(!revOf(repo.text(), 'R1').text.includes('other than 2xx'));
      assert.match(review([repo.spec]).out, /No open comments or suggestions\./);
    });

    await t.test('3. revision-aware retrieval: the agent asks what changed since its checkpoint', () => {
      const before = repo.git('status', '--porcelain');
      for (const since of [c1, 'HEAD~1']) {
        const out = runUpdates(repo.spec, since, { json: true });
        assert.equal(out.code, 0, out.stderr);
        const updates = JSON.parse(out.stdout) as { changes: FeedbackChange[]; note: string; next: { revision: string } };
        assert.deepEqual(summary(updates.changes).sort(), [
          'comment  added',
          'question Q1 answered',
          'suggestion  rejected',
          'task T1 reopened',
        ]);
        const byKind = (kind: string) => updates.changes.find((c) => c.kind === kind)!;
        // The answer names what it affects, the dependent task included.
        assert.deepEqual(byKind('question').affected.map((a) => `${a.type} ${a.id ?? ''} ${a.edge}`.replace(/ +/g, ' ')), ['comment for', 'task T3 depends-on']);
        assert.deepEqual([byKind('comment').commentKind, byKind('comment').for, byKind('comment').author], ['answer', 'Q1', person]);
        assert.deepEqual([byKind('suggestion').for, byKind('suggestion').by, byKind('suggestion').on], ['R1', person, dates.review]);
        assert.equal(updates.note, UPDATES_NOTE);
        assert.equal(updates.next.revision, revisionOfText(repo.text()));
      }
      const retrieved = (JSON.parse(runUpdates(repo.spec, c1, { json: true }).stdout) as { changes: FeedbackChange[] }).changes;
      const has = (kind: string, change: string, id: string | null = null) => retrieved.some((c) => c.kind === kind && c.change === change && (id === null || c.id === id));
      measures.answerRetrieved = has('question', 'answered', script.answer.question) && has('comment', 'added');
      measures.rejectionRetrieved = has('suggestion', 'rejected');
      measures.reopenRetrieved = has('task', 'reopened', script.reopen);
      // The text form lists dispositions without replaying the answer's words.
      const text = runUpdates(repo.spec, c1).stdout;
      assert.match(text, /^- question Q1 answered \(open → answered\)/m);
      assert.match(text, /^- task T1 reopened/m);
      assert.doesNotMatch(text, /429 Too Many Requests/);
      // The answer itself is read through the agent view, where it sits with its question.
      assert.match(agentView(repo.text()).text, /<question id="Q1" status="answered"[\s\S]*429 Too Many Requests/);
      // Retrieval records nothing.
      assert.equal(repo.git('status', '--porcelain'), before);
      agent.read(repo);
    });

    await t.test('4. the agent proposes the incorporation, the person accepts it, and the old evidence goes stale', () => {
      const proposed = review(['suggest', repo.spec, script.incorporation.target], { '--text': script.incorporation.text, '--by': bot, '--today': dates.incorporate });
      assert.equal(proposed.code, 0, proposed.err);
      const pending = JSON.parse(review([repo.spec], {}, ['--json']).out) as Array<{ line: number; attrs: Record<string, string> }>;
      assert.equal(pending.length, 1);
      assert.equal(pending[0].attrs.author, bot);
      // Until the person accepts it, the proposal changes nothing (AF09).
      assert.equal(revOf(repo.text(), 'R1').revision, e1Rev);
      const accepted = review(['accept', repo.spec, String(pending[0].line)], { '--by': person, '--today': dates.incorporate });
      assert.equal(accepted.code, 0, accepted.err);
      const incorporated = review(['incorporate', repo.spec, script.answer.question], { '--by': person, '--today': dates.incorporate });
      assert.equal(incorporated.code, 0, incorporated.err);
      assert.deepEqual(errors(repo.text()), []);
      repo.commit('incorporate the answer to Q1 into R1', dates.incorporate);

      const text = repo.text();
      const r1Now = revOf(text, 'R1');
      assert.equal(r1Now.text.trim().split('\n').slice(-1)[0], script.incorporation.text);
      assert.notEqual(r1Now.revision, e1Rev);
      assert.equal(runRev(repo.spec, ['R1'], false).stdout.split('  ')[0], `R1@${r1Now.revision}`);
      assert.deepEqual(querySmd(text, 'question[status=incorporated]').map((m) => m.attrs.id), ['Q1']);
      assert.deepEqual(querySmd(text, 'suggestion[status=accepted]').map((m) => m.attrs.by), [person]);
      measures.answerIncorporated = querySmd(text, `question[id=${script.answer.question}][status=incorporated]`).length === 1 && r1Now.text.includes('4xx response is final');
      measures.incorporationConfirmedBy = querySmd(text, 'suggestion[status=accepted]')[0].attrs.by;
      measures.rejectedSuggestionApplied = r1Now.text.includes('other than 2xx');

      // AF28: the passing record from before the change is outdated, flagged, and no longer counts as passing.
      const stale = validateSmd(text).filter((d) => d.code === 'evidence/stale');
      assert.equal(stale.length, 1);
      assert.match(stale[0].message, new RegExp(`R1 changed after E1 was recorded: it was at revision ${e1Rev} and is now at ${r1Now.revision}`));
      const r1 = r1Trace(text);
      assert.deepEqual([r1.evidence.passing, r1.evidence.outdated], [0, 1]);
      assert.equal(trace(text).summary.withPassingEvidence, 0);
      falselyAccepted ||= r1.evidence.passing > 0 || trace(text).summary.withPassingEvidence > 0;
      assert.match(agentView(text, { evidence: 'full' }).text, new RegExp(`\\[evidence for R1: E1 supports it · test · pass · .*OUTDATED: R1 changed after revision ${e1Rev}, recheck before treating it as current`));
      measures.staleEvidenceFlagged = stale.length === 1 && r1.evidence.outdated === 1;
      // The shipped policy no longer meets R1, which the stale flag is there to catch.
      assert.equal(verify(text, repo.readPolicy()).result, 'fail');
    });

    await t.test('5. verification after a code change: a failing first change, then a fix, each recorded against the new revision', () => {
      const ids = ['E2', 'E3'];
      script.code.forEach((change, i) => {
        repo.writePolicy({ ...repo.readPolicy(), retryStatuses: change.retryStatuses });
        repo.commit(`code: ${change.label}`, dates.fix);
        assert.equal(agent.verifyAndRecord(repo, ids[i], dates.fix), change.verdict);
        if (change.verdict === 'pass') {
          repo.write(repo.text()
            .replace('- [ ] Implement the retry loop :depends[R1] {#T1}', '- [x] Implement the retry loop :depends[R1] {#T1}')
            .replace(script.question.task, script.question.task.replace('- [ ]', '- [x]')));
        }
        repo.commit(`evidence ${ids[i]}`, dates.fix);
        // Until the passing record, R1 has no current passing evidence.
        if (change.verdict === 'fail') {
          falselyAccepted ||= r1Trace(repo.text()).evidence.passing > 0;
          assert.equal(r1Trace(repo.text()).evidence.passing, 0);
        }
      });

      const text = repo.text();
      const r1Rev = revOf(text, 'R1').revision;
      const [, fail, pass] = agent.verifications;
      assert.deepEqual([fail.result, pass.result], ['fail', 'pass']);
      assert.ok(fail.rev === r1Rev && pass.rev === r1Rev, 'both records name the revision of R1 they checked');
      assert.notEqual(fail.commit, pass.commit);
      assert.equal(repo.git('rev-parse', '--short', 'HEAD~1').trim(), pass.commit, 'the passing record names the commit of the fix');

      // The trace keeps every record: the outdated one as history, the failure, and the current pass.
      const r1 = r1Trace(text);
      assert.deepEqual([r1.evidence.passing, r1.evidence.failing, r1.evidence.outdated, r1.evidence.total], [1, 1, 1, 3]);
      assert.deepEqual([r1.claims.checked, r1.claims.total], [1, 1]);
      assert.equal(trace(text).summary.withPassingEvidence, 1);
      assert.match(formatTrace(trace(text)), /evidence {4}3 records: 1 passing, 1 failing, 0 inconclusive, 1 outdated · methods: test/);
      // Only the old record is stale; the new ones name the current revision.
      assert.deepEqual(validateSmd(text).filter((d) => d.code === 'evidence/stale').map((d) => /after (E\d)/.exec(d.message)?.[1]), ['E1']);
      measures.verificationRuns = agent.verifications.length;
      measures.failedVerifications = agent.verifications.filter((v) => v.result === 'fail').length;
      measures.reverifiedAfterChange = pass.rev === r1Rev && pass.rev !== e1Rev;
      // Whether an outdated or failing record ever counted as current passing evidence after R1 changed.
      measures.falselyAcceptedCompletion = falselyAccepted;
    });

    await t.test('6. the agent catches up from its checkpoint and gets the whole loop as dispositions', () => {
      const out = runUpdates(repo.spec, c1, { json: true });
      assert.equal(out.code, 0, out.stderr);
      const changes = JSON.parse(out.stdout).changes as FeedbackChange[];
      const lines = summary(changes);
      for (const want of ['question Q1 incorporated', 'requirement R1 changed', 'suggestion  rejected', 'evidence E2 added', 'evidence E3 added', 'task T3 checked']) {
        assert.ok(lines.includes(want), `${want} in ${JSON.stringify(lines)}`);
      }
      // T1 was checked at the checkpoint and is checked again: no net change to report.
      assert.ok(!lines.some((l) => l.startsWith('task T1')));
      const r1 = changes.find((c) => c.id === 'R1')!;
      assert.equal(r1.revision?.after, revOf(repo.text(), 'R1').revision);
      // The whole history is in Git and the document: six versions of spec.smd after the baseline.
      assert.equal(repo.git('log', '--format=%s', '--', 'spec.smd').trim().split('\n').length, 7);
    });

    await t.test('the loop measures match the fixture\'s expected record', () => {
      assert.deepEqual(measures, JSON.parse(fixture('expected-measures.json')));
      assert.deepEqual(agent.log.filter((l) => l.startsWith('verify')).map((l) => l.replace(/ at [0-9a-f]+$/, '')), ['verify E1 pass', 'verify E2 fail', 'verify E3 pass']);
    });
  } finally {
    repo.done();
  }
});

test('Study 3 loop: the run is deterministic, commits included', { skip: !hasGit && 'git is not installed' }, () => {
  const run = () => {
    const repo = new Repo();
    try {
      repo.commit('baseline', script.dates.baseline);
      new ScriptedAgent().verifyAndRecord(repo, 'E1', script.dates.baseline);
      return [repo.commit('evidence E1', script.dates.baseline), repo.text()];
    } finally {
      repo.done();
    }
  };
  assert.deepEqual(run(), run());
});
