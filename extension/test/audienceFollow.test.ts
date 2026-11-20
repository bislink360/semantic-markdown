import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revisionOfText } from '../src/core';

// 6.0.0: nothing an agent receives leads into content for people, a section marked {agent=skip} (subsections
// included) or a :::human block. Followed edges list no pointer into it, a section read names no skipped section in
// its header, and `smd updates` reports no change made in it. A dependency on a hidden block is still reported as
// hidden, by its id and without what the block holds.

const main = [
  '---', 'smd: 2', 'title: Probe', '---', '',
  '## Work', '',
  'See :ref[R9], [](#deep) and [](#notes), and [the other notes](other.smd#secret).', '',
  '- [ ] VISIBLE-TASK :depends[R9]', '',
  ':::requirement{#R1 depends-on=R9} VISIBLE-REQ', 'Needs R9.', ':::', '',
  ':::decision{#D2 status=accepted supersedes=D9} VISIBLE-DECISION', 'Replaces D9.', ':::', '',
  ':::constraint{#C1 level=must applies-to=R9} VISIBLE-CONSTRAINT', 'Binds R9.', ':::', '',
  ':::comment{for=R9 author=@amy date=2026-11-10} VISIBLE-COMMENT', 'Looks off.', ':::', '',
  ':::include{file="other.smd" section="Secret"}', ':::', '',
  '::::human', '- [ ] HUMAN-TASK @bob', '::::', '',
  '## SKIP-HEAD Notes {#notes agent=skip}', '',
  '- [ ] SKIP-TASK @bob', '',
  ':::requirement{#R9} SKIP-REQ', 'SKIP-REQ-BODY', ':::', '',
  ':::decision{#D9 status=superseded} SKIP-DEC', 'SKIP-DEC-BODY', ':::', '',
  ':::question{#Q9 status=open owner=@bob} SKIP-Q', 'SKIP-Q-BODY', ':::', '',
  '### SKIP-SUB {#deep}', '', 'SKIP-SUBTEXT', '',
  '## After', '', 'Visible again.', '',
].join('\n');
const other = ['---', 'smd: 2', 'title: Other', '---', '', '## Open', '', 'Other text.', '', '## OTHER-SECRET {#secret agent=skip}', '', 'OTHER-SECRET-TEXT', ''].join('\n');
const HIDDEN = /SKIP-|HUMAN-|OTHER-SECRET/;

const cli = join(__dirname, '..', 'dist', 'cli.js');
const notBuilt = !existsSync(cli) && 'run npm run build first';
const noGit = spawnSync('git', ['--version']).status !== 0 && 'git is not installed';

function withProbe(body: (run: (...args: string[]) => string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'smd-audience-follow-'));
  try {
    writeFileSync(join(dir, 'main.smd'), main);
    writeFileSync(join(dir, 'other.smd'), other);
    body((...args) => execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Unsatisfied { kind: string; edge: { target: string; to?: unknown } }

test('followed edges list no pointer into content for people, in text or JSON, in any direction', { skip: notBuilt }, () => {
  withProbe((run) => {
    for (const direction of ['out', 'in', 'both']) {
      const outputs: Record<string, string> = {
        'read --section Work': run('read', 'main.smd', '--section', 'Work', '--follow', '*', '--direction', direction),
        'read --json': run('read', 'main.smd', '--follow', '*', '--direction', direction, '--depth', '3', '--json'),
        'agent --section Work': run('agent', 'main.smd', '--section', 'Work', '--follow', '*', '--direction', direction),
        'query heading': run('query', 'heading', '.', '--follow', '*', '--direction', direction, '--depth', '3'),
        'query * --json': run('query', '*', '.', '--follow', '*', '--direction', direction, '--depth', '3', '--json'),
      };
      for (const [name, out] of Object.entries(outputs)) assert.doesNotMatch(out, HIDDEN, `${name} --direction ${direction} leads into content for people`);
    }
    // The dependency on R9 is still reported, as hidden: its id, and nothing of the block.
    const json = JSON.parse(run('query', 'requirement', '.', '--follow', '*', '--json')) as { matches: Array<{ unsatisfied?: Unsatisfied[] }> };
    const hidden = json.matches.flatMap((m) => m.unsatisfied ?? []).filter((u) => u.kind === 'hidden');
    assert.deepEqual(hidden.map((u) => [u.edge.target, u.edge.to]), [['R9', undefined]]);
    assert.match(run('read', 'main.smd', '--section', 'Work'), /depends on R9 \[L\d+\]: the block is for people only/);
  });
});

test('a section read names no skipped section, by heading text or id, and lists only the sections it shows', { skip: notBuilt }, () => {
  withProbe((run) => {
    for (const section of ['notes', 'SKIP-HEAD Notes', 'deep']) {
      const out = run('agent', 'main.smd', '--section', section);
      assert.match(out, /\(excerpt — no section shown\)/);
      assert.doesNotMatch(out, HIDDEN, `--section ${section}`);
    }
    assert.match(run('agent', 'main.smd', '--section', 'notes', '--section', 'After'), /\(excerpt — sections: After\)\n/);
    assert.match(run('agent', 'other.smd', '--section', 'secret'), /\(excerpt — no section shown\)/);
  });
});

test('smd updates reports no change made in content for people, and keeps the revisions of the whole file', { skip: notBuilt || noGit }, () => {
  withProbe((run, dir) => {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-qm', 'one');
    const changed = main.replace('- [ ] SKIP-TASK', '- [x] SKIP-TASK').replace('- [ ] HUMAN-TASK', '- [x] HUMAN-TASK')
      .replace('status=open owner=@bob} SKIP-Q', 'status=withdrawn owner=@bob} SKIP-Q').replace('- [ ] VISIBLE-TASK', '- [x] VISIBLE-TASK');
    writeFileSync(join(dir, 'main.smd'), changed);
    const text = run('updates', 'main.smd', '--since', 'HEAD');
    assert.doesNotMatch(text, HIDDEN);
    assert.match(text, /task "VISIBLE-TASK" checked/);
    const json = JSON.parse(run('updates', 'main.smd', '--since', 'HEAD', '--json')) as { changes: Array<{ kind: string }>; revision: string };
    assert.deepEqual(json.changes.map((c) => c.kind), ['task']);
    // The revisions are those of the whole file, so a checkpoint a read gave is found again.
    assert.equal(json.revision, revisionOfText(changed));
    assert.match(run('updates', 'main.smd', '--since', `rev:${json.revision}`), /No feedback updates/);
  });
});
