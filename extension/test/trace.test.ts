import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentView, formatTrace, renderSmd, traceRequirements, validateSmd } from '../src/core';
import { blockRevision } from '../src/core/revision';

const V2 = '---\nsmd: 2\n---\n';
const codes = (text: string) => validateSmd(text).map((d) => `${d.line}:${d.code}:${d.severity}`);
const revOf = (text: string, id: string) => {
  const r = blockRevision(text, id);
  assert.equal(r.status, 'resolved');
  return r.status === 'resolved' ? r.revision : '';
};
const one = (text: string, file = 'req.smd') => traceRequirements([{ path: file, text }]);

const columns = `${V2}# Export

:::requirement{#R1 status=accepted}
Users can export a report as CSV.

- [x] Writer
- [ ] Download button

:::acceptance{#AC1}
Given a report, when I export it, then I get a CSV file.
:::
:::

:::requirement{#R2 status=verified}
Exports keep the column order.
:::

:::requirement{#R3}
Exports finish in a second.
:::

:::acceptance{#AC3 verifies=R3}
A 10 MB report exports in under a second.
:::

- [x] Profile the export :depends[R3]

:::evidence{#E1 supports=R1 method=test result=pass commit=1a2b3c4 by=@ci}
The CSV export test passed.
:::

:::evidence{#E2 supports=R1 method=review result=fail}
Review found a missing header row.
:::

:::evidence{#E3 supports=R3 method=acceptance result=pass by=@maya}
Maya accepted the export speed.
:::
`;

test('AF26: trace keeps status, coverage, claims, evidence and human acceptance in separate columns, nothing inferred from another', () => {
  const { requirements: [r1, r2, r3], summary } = one(columns);
  assert.equal(r1.status, 'accepted');
  assert.deepEqual(r1.coverage.map((c) => [c.id, c.how]), [['AC1', 'nested']]);
  assert.deepEqual([r1.claims.checked, r1.claims.total], [1, 2]);
  assert.deepEqual([r1.evidence.passing, r1.evidence.failing, r1.evidence.total, r1.evidence.methods], [1, 1, 2, ['test', 'review']]);
  assert.equal(r1.acceptance.accepted, false);

  // Written as verified, reported as written, and flagged: nothing supports it.
  assert.deepEqual([r2.status, r2.unsupportedVerified, r2.coverage.length, r2.evidence.total], ['verified', true, 0, 0]);

  // A checked task and an acceptance criterion are not evidence; a person's acceptance is not verification.
  assert.equal(r3.status, 'proposed');
  assert.deepEqual(r3.coverage.map((c) => [c.id, c.how]), [['AC3', 'verifies']]);
  assert.deepEqual([r3.claims.checked, r3.claims.total, r3.claims.tasks[0].how], [1, 1, 'depends']);
  assert.deepEqual([r3.evidence.passing, r3.evidence.total], [0, 0]);
  assert.deepEqual([r3.acceptance.accepted, r3.acceptance.by], [true, ['@maya']]);

  assert.deepEqual(summary, { documents: 1, requirements: 3, covered: 2, withPassingEvidence: 1, accepted: 1, unsupportedVerified: 1 });
  const text = formatTrace(one(columns));
  assert.match(text, /^req\.smd:6 {2}R1 {2}Users can export a report as CSV\.\n {2}status {6}accepted\n {2}coverage {4}1 acceptance criterion: AC1 \(nested\)\n {2}claims {6}1 of 2 tasks checked \(implementation claims, not verification\)\n {2}evidence {4}2 records: 1 passing, 1 failing, 0 inconclusive, 0 outdated · methods: test, review\n {2}acceptance {2}none$/m);
  assert.match(text, /R2 {2}Exports keep the column order\.\n {2}status {6}verified \(as written; no current passing evidence supports it\)\n {2}coverage {4}none: no acceptance criterion verifies R2/);
  assert.match(text, / {2}acceptance {2}accepted by @maya/);
  assert.ok(text.endsWith('Requirements: 3. Covered by acceptance criteria: 2 of 3. With current passing evidence: 1 of 3. Accepted by a person: 1 of 3. '
    + 'Marked verified without current passing evidence: 1 of 3. Checked tasks are implementation claims, not verification.\n'));
});

test('AF26: --uncovered lists only requirements without acceptance criteria; the summary still counts every requirement', () => {
  const result = traceRequirements([{ path: 'req.smd', text: columns }], { uncovered: true });
  assert.deepEqual(result.requirements.map((r) => r.id), ['R2']);
  assert.equal(result.summary.requirements, 3);
});

test('AF26: evidence supports requirements in its own document only, and the summary says so for several documents', () => {
  const reqs = `${V2}:::requirement{#R1}\nA thing.\n:::\n`;
  const evidence = `${V2}:::evidence{#E1 supports=R1 method=test result=pass}\nPassed.\n:::\n`;
  const result = traceRequirements([{ path: 'a.smd', text: reqs }, { path: 'b.smd', text: evidence }]);
  assert.equal(result.requirements[0].evidence.total, 0);
  assert.match(formatTrace(result), /Evidence supports requirements in its own document only\.\n$/);
});

test('AF26/AF28: requirement/verified warns about verified without current passing verification', () => {
  const doc = (evidence: string) => `${V2}:::requirement{#R1 status=verified}\nA thing.\n:::\n\n${evidence}`;
  assert.deepEqual(codes(doc('')), ['3:requirement/verified:warning']);
  assert.match(validateSmd(doc(''))[0].message, /R1 says status=verified, but no current passing evidence supports it \(no evidence supports R1\)/);
  assert.deepEqual(codes(doc(':::evidence{#E1 supports=R1 method=test result=pass}\nOK.\n:::\n')), []);
  const accepted = validateSmd(doc(':::evidence{#E1 supports=R1 method=acceptance result=pass by=@maya}\nOK.\n:::\n'));
  assert.deepEqual(accepted.map((d) => d.code), ['requirement/verified']);
  assert.match(accepted[0].message, /E1 is a person's acceptance, not verification/);
  assert.match(validateSmd(doc(':::evidence{#E1 supports=R1 method=test result=fail}\nNo.\n:::\n'))[0].message, /E1 says result=fail/);
  assert.deepEqual(codes(`${V2}:::requirement{status=verified}\nNo id.\n:::\n`), ['3:requirement/verified:warning']);
});

test('AF28: evidence/stale warns when a supported block changed after the revision the record names', () => {
  const before = `${V2}:::requirement{#R1}\nUsers can export as CSV.\n:::\n`;
  const rev = revOf(before, 'R1');
  const record = `\n:::evidence{#E1 supports=R1 method=test result=pass rev=R1@${rev}}\nPassed.\n:::\n`;
  assert.deepEqual(codes(before + record), []);
  const after = before.replace('as CSV', 'as CSV with a header row') + record;
  const now = revOf(after, 'R1');
  const [stale] = validateSmd(after);
  assert.equal(stale.code, 'evidence/stale');
  assert.equal(stale.severity, 'warning');
  assert.equal(stale.fix, undefined, 'a person rechecks: no automatic fix');
  assert.equal(stale.message, `R1 changed after E1 was recorded: it was at revision ${rev} and is now at ${now}. Recheck R1 before treating this evidence as current, then record the new revision in rev.`);
  // The record no longer counts as current passing evidence.
  const [r1] = one(after).requirements;
  assert.deepEqual([r1.evidence.passing, r1.evidence.outdated], [0, 1]);
});

test('AF27: agent --evidence follows each requirement and acceptance criterion with its evidence in full, and says when there is none', () => {
  const doc = `${V2}# Spec

## Requirements

:::requirement{#R1}
Users can export as CSV.
:::

:::requirement{#R2}
Exports keep the column order.
:::

## Evidence

:::evidence{#E1 supports=R1 method=test result=pass by=@ci}
The CSV export test passed in run 42.
:::
`;
  const full = agentView(doc, { sections: ['Requirements'], evidence: 'full', lineRefs: false }).text;
  assert.match(full, /Users can export as CSV\.\n\[evidence for R1: E1 supports it · test · pass · by @ci · L18\]\n(?:.*\n)*?The CSV export test passed in run 42\./);
  assert.match(full, /Exports keep the column order\.\n\[evidence: none for R2\]/);
  // The default view is unchanged.
  assert.equal(agentView(doc, { sections: ['Requirements'] }).text, agentView(doc, { sections: ['Requirements'], evidence: 'pointers' }).text);
  assert.doesNotMatch(agentView(doc, { sections: ['Requirements'] }).text, /\[evidence/);
});

// AC-F: eight of ten tasks are checked, evidence is missing, and an accepted correction adds two tasks.
const acfBefore = `${V2}# Export

:progress{basis=tasks}

:::requirement{#R1 status=implemented}
Users can export a report as CSV.

- [x] Write the CSV writer
- [x] Add the export button
- [x] Stream large reports
- [x] Name the file after the report
- [x] Log each export
:::

:::requirement{#R2 status=implemented}
Exports keep the column order.

- [x] Read the column order
- [x] Write columns in that order
- [x] Keep hidden columns out
- [ ] Test reordered columns
- [ ] Document the order
:::
`;

test('AC-F: progress states its basis and revised denominator, checked tasks are not verified, outdated verification is flagged, review context exposes missing evidence', () => {
  const evidence = (text: string) => `${text}\n:::evidence{#E1 supports=R1 method=test result=pass rev=R1@${revOf(text, 'R1')}}\nThe CSV export test passed.\n:::\n`;
  const before = evidence(acfBefore);
  assert.match(renderSmd(before).html, /aria-valuetext="8 of 10 tasks checked"/);
  assert.deepEqual(codes(before), []);

  // The accepted correction: R1 needs a header row, and two tasks come with it.
  const after = before
    .replace('as CSV.\n', 'as CSV with a header row.\n')
    .replace('- [x] Log each export\n', '- [x] Log each export\n- [ ] Write the header row\n- [ ] Test the header row\n');

  // Progress states its counting basis and the revised denominator, in every view.
  assert.match(renderSmd(after).html, /aria-valuenow="67" aria-valuetext="8 of 12 tasks checked"/);
  assert.match(agentView(after).text, /\[progress 67%: 8 of 12 tasks checked\]/);

  // Checked tasks are not verification: R2's checked tasks count as claims, never as evidence.
  const { requirements: [r1, r2], summary } = one(after);
  assert.deepEqual([r1.claims.checked, r1.claims.total, r2.claims.checked, r2.claims.total], [5, 7, 3, 5]);
  assert.deepEqual([r2.evidence.total, r2.evidence.passing], [0, 0]);
  assert.equal(summary.withPassingEvidence, 0);
  assert.match(formatTrace(one(after)), /With current passing evidence: 0 of 2\. Accepted by a person: 0 of 2\. Checked tasks are implementation claims, not verification\.\n$/);

  // The verification recorded before the correction is flagged as outdated.
  assert.deepEqual(validateSmd(after).map((d) => d.code), ['evidence/stale']);
  assert.deepEqual([r1.evidence.passing, r1.evidence.outdated], [0, 1]);

  // Review context exposes the missing evidence and the outdated record.
  const review = agentView(after, { evidence: 'full' }).text;
  assert.match(review, /\[evidence for R1: E1 supports it · test · pass · OUTDATED: R1 changed after revision [0-9a-f]{12}, recheck before treating it as current · L30\]/);
  assert.match(review, /\[evidence: none for R2\]/);
});

const cli = path.join(__dirname, '..', 'dist', 'cli.js');

test('AF26: smd trace prints the columns and the counts, --json the structure, --uncovered only the uncovered', { skip: !fs.existsSync(cli) && 'run npm run build first' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-trace-'));
  fs.writeFileSync(path.join(dir, 'req.smd'), columns);
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'trace', ...args], { encoding: 'utf8', cwd: dir });
  const text = run('req.smd');
  assert.equal(text.status, 0);
  assert.equal(text.stdout, formatTrace(one(columns)));
  const json = JSON.parse(run('req.smd', '--json').stdout);
  assert.deepEqual(json.summary.requirements, 3);
  assert.deepEqual(json.requirements.map((r: { id: string }) => r.id), ['R1', 'R2', 'R3']);
  assert.match(run('req.smd', '--uncovered').stdout, /^req\.smd:\d+ {2}R2 /);
  fs.rmSync(dir, { recursive: true, force: true });
});
