// smd rev: the revision of a block, to record in rev= (feedback loop RFC, "Block revisions").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { blockRevision } from '../src/core/revision';
import { runRev } from '../src/revCommand';

const doc = '---\nsmd: 2\n---\n\n:::requirement{#R1 status=accepted} Keep rules\nDetail.\n:::\n\n## Twice {#dup}\n\n## Again {#dup}\n';

test('AF10: smd rev prints id@revision for each block, the same revision stale checks compare', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-rev-'));
  const file = path.join(dir, 'a.smd');
  fs.writeFileSync(file, doc);
  const r = blockRevision(doc, 'R1');
  assert.equal(r.status, 'resolved');
  const out = runRev(file, ['R1'], false);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, `R1@${r.status === 'resolved' ? r.revision : ''}  [L5]\n`);
  assert.deepEqual(JSON.parse(runRev(file, ['R1'], true).stdout), [{ id: 'R1', revision: r.status === 'resolved' ? r.revision : '', line: 5 }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AF06: smd rev names no block for a missing or a duplicate id, and exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smd-rev-'));
  const file = path.join(dir, 'a.smd');
  fs.writeFileSync(file, doc);
  const out = runRev(file, ['R9', 'dup'], false);
  assert.equal(out.code, 1);
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /R9: no block has this id/);
  assert.match(out.stderr, /dup: given by 2 blocks \(lines 9, 11\), so it names none of them/);
  assert.equal(runRev(undefined, [], false).code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
