import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { reportCrash, requireFile, UsageError } from '../src/cliIo';

/**
 * The CLI error boundary and exit codes (improvement roadmap t-09, CL-06).
 */

const cli = join(__dirname, '..', 'dist', 'cli.js');
/** The CLI tests run the built bundle; a test run without a build skips them, as the other CLI tests do. */
const skip = !fs.existsSync(cli) && 'run npm run build first';
const run = (args: string[], cwd?: string) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd });

function workspace(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-cli-errors-'));
  fs.writeFileSync(join(dir, 'ok.smd'), '---\nsmd: 2\ntitle: Ok\n---\n\n# Ok\n\nText.\n');
  fs.writeFileSync(join(dir, 'bad.smd'), '---\nsmd: 2\ntitle: Bad\n---\n\n# Bad\n\nSee [x](#nowhere).\n');
  fs.mkdirSync(join(dir, 'empty'));
  return dir;
}

test('t-09: requireFile throws a usage error for a missing argument, a missing file and a folder', () => {
  const dir = workspace();
  assert.throws(() => requireFile(undefined), (e) => e instanceof UsageError && /Missing file argument/.test(e.message));
  assert.throws(() => requireFile(join(dir, 'gone.smd')), (e) => e instanceof UsageError && /Not found/.test(e.message));
  assert.throws(() => requireFile(join(dir, 'empty')), (e) => e instanceof UsageError && /Not a file/.test(e.message));
  assert.equal(requireFile(join(dir, 'ok.smd')), join(dir, 'ok.smd'));
});

test('t-09: reportCrash prints one line and maps usage errors to 2 and anything else to 1', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    assert.equal(reportCrash(new UsageError('Not found: x.smd')), 2);
    assert.equal(reportCrash(new Error('boom\n    at somewhere')), 1);
    assert.equal(reportCrash(Promise.reject.name), 1);
    assert.equal(reportCrash(new Error('with stack'), { SMD_DEBUG: '1' }), 1);
  } finally {
    console.error = original;
  }
  assert.deepEqual(lines.slice(0, 3), ['Not found: x.smd', 'smd: boom', 'smd: reject']);
  assert.equal(lines[3], 'smd: with stack');
  assert.match(lines[4], /^Error: with stack\n\s+at /, 'SMD_DEBUG adds the stack');
});

test('t-09: a folder or missing file given to a file command is a one-line usage error with exit 2, not a stack', { skip }, () => {
  const dir = workspace();
  for (const args of [['read', 'empty'], ['agent', 'gone.smd'], ['outline'], ['export', 'empty', '--to', 'md'], ['diff', 'ok.smd', 'gone.smd']]) {
    const r = run(args, dir);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stderr.trim().split('\n').length, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\bat .*\.js:\d+/);
  }
});
