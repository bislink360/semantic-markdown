import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

/**
 * Missing explicit inputs to smd validate (improvement roadmap t-08, EV-02).
 */

const cli = join(__dirname, '..', 'dist', 'cli.js');
const run = (args: string[], cwd?: string) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd });

function workspace(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-cli-errors-'));
  fs.writeFileSync(join(dir, 'ok.smd'), '---\nsmd: 2\ntitle: Ok\n---\n\n# Ok\n\nText.\n');
  fs.writeFileSync(join(dir, 'bad.smd'), '---\nsmd: 2\ntitle: Bad\n---\n\n# Bad\n\nSee [x](#nowhere).\n');
  fs.mkdirSync(join(dir, 'empty'));
  return dir;
}

test('t-08: a valid file plus a missing path checks the file, lists the path and exits 2', () => {
  const dir = workspace();
  const text = run(['validate', 'ok.smd', 'gone.smd'], dir);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /^Not found: gone\.smd$/m);
  assert.match(text.stdout, /1 file\(s\) checked: 0 error\(s\)/);
  for (const args of [['--format', 'json'], ['--json']]) {
    const json = run(['validate', 'ok.smd', 'gone.smd', ...args], dir);
    assert.equal(json.status, 2, args.join(' '));
    const report = JSON.parse(json.stdout);
    assert.deepEqual(report.inputErrors, [{ path: 'gone.smd', message: 'Not found: gone.smd' }]);
    assert.deepEqual(report.files.map((f: { file: string }) => f.file), ['ok.smd']);
    assert.equal(json.stderr, '', 'JSON lists the path in the report, not on stderr');
  }
});

test('t-08: the exit code is 2 whatever the findings, and readable targets are still reported', () => {
  const dir = workspace();
  const json = run(['validate', 'bad.smd', 'gone.smd', '--json'], dir);
  assert.equal(json.status, 2);
  const report = JSON.parse(json.stdout);
  assert.equal(report.errors + report.warnings > 0, true);
  assert.equal(report.inputErrors.length, 1);
});

test('t-08: every explicit target missing still prints the JSON report and exits 2', () => {
  const dir = workspace();
  const json = run(['validate', 'a.smd', 'b', '--json'], dir);
  assert.equal(json.status, 2);
  assert.deepEqual(JSON.parse(json.stdout), {
    files: [], errors: 0, warnings: 0,
    inputErrors: [{ path: 'a.smd', message: 'Not found: a.smd' }, { path: 'b', message: 'Not found: b' }],
  });
  const text = run(['validate', 'a.smd'], dir);
  assert.equal(text.status, 2);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /Not found: a\.smd/);
});

test('t-08: an existing folder with no .smd files is not a missing path', () => {
  const dir = workspace();
  const empty = run(['validate', 'empty'], dir);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /No \.smd files found\./);
  assert.doesNotMatch(empty.stderr, /Not found/);
  const withFile = run(['validate', 'empty', 'ok.smd', '--json'], dir);
  assert.equal(withFile.status, 0);
  assert.equal(JSON.parse(withFile.stdout).inputErrors, undefined, 'the field appears only when a path is missing');
});
