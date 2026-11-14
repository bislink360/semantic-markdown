import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { COMMAND_OPTIONS, parseArgs } from '../src/cliOptions';

/**
 * Per-command option schemas (improvement roadmap t-07, CL-05): each command declares what it reads, `--name=value`
 * works, and an unknown option gets a did-you-mean warning on stderr while the exit code stays the same.
 */

const parse = (...argv: string[]) => {
  const warnings: string[] = [];
  const args = parseArgs(argv, (m) => warnings.push(m));
  return { ...args, flags: [...args.flags], values: Object.fromEntries(args.values), warnings };
};

test('t-07: every command main() dispatches has an option schema', () => {
  const source = fs.readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
  const body = source.slice(source.indexOf('function main('), source.indexOf('function fromMd('));
  const commands = [...body.matchAll(/case '([a-z][\w-]*)':/g)].map((m) => m[1]).filter((c) => c !== 'help');
  assert.ok(commands.length > 25);
  for (const command of commands) assert.ok(COMMAND_OPTIONS[command], `no schema for smd ${command}`);
});

test('t-07: --name=value works for options that take a value, and the next token is not consumed', () => {
  assert.deepEqual(parse('tasks', '--title=My plan', 'doc.smd'), {
    command: 'tasks', positional: ['doc.smd'], flags: [], values: { '--title': ['My plan'] }, warnings: [],
  });
  assert.deepEqual(parse('validate', '--format=json').values, { '--format': ['json'] });
  assert.deepEqual(parse('validate', '--format=').values, { '--format': [''] });
});

test('t-07: -- ends option parsing, so files that start with - are files', () => {
  const r = parse('validate', '--strict', '--', '-odd.smd', '--json');
  assert.deepEqual([r.positional, r.flags, r.warnings], [['-odd.smd', '--json'], ['--strict'], []]);
});

test('t-07: a value option followed by another option gets no value, and the next option still counts', () => {
  const r = parse('tasks', '--title', '--json', 'a.smd');
  assert.deepEqual([r.values, r.flags, r.positional], [{ '--title': [''] }, ['--json'], ['a.smd']]);
  assert.deepEqual(r.warnings, [], 'the command reports the empty value itself');
  assert.deepEqual(parse('tasks', 'a.smd', '-o').values, { '-o': [''] });
  // A value that starts with a digit is a value, not an option.
  assert.deepEqual(parse('read', 'a.smd', '--depth', '-1').values, { '--depth': ['-1'] });
});

test('t-07: a flag given an attached value keeps the flag and warns', () => {
  const r = parse('validate', '--json=yes', 'a.smd');
  assert.deepEqual([r.flags, r.positional], [['--json'], ['a.smd']]);
  assert.deepEqual(r.warnings, ['--json takes no value; ignored "yes".']);
});

test('t-07: repeated options keep every value, and a repeated flag is one flag', () => {
  const r = parse('read', 'a.smd', '--section', 'One', '--section=Two', '--brief', '--brief');
  assert.deepEqual([r.values, r.flags, r.warnings], [{ '--section': ['One', 'Two'] }, ['--brief'], []]);
});

test('t-07: an unknown option warns with a suggestion, once, and is ignored', () => {
  const r = parse('validate', 'a.smd', '--josn', '--josn');
  assert.deepEqual(r.warnings, ['Unknown option --josn for smd validate (did you mean --json?); it is ignored.']);
  assert.deepEqual(parse('fmt', '--zzzzzz').warnings, ['Unknown option --zzzzzz for smd fmt; it is ignored.']);
});

test('t-07: an option another command reads still takes its value, so the file argument stays in place', () => {
  const r = parse('export', '--today', '2026-01-01', 'a.smd', '--to', 'md');
  assert.deepEqual(r.positional, ['a.smd']);
  assert.deepEqual(r.warnings, ['Unknown option --today for smd export; it is ignored.']);
});

test('t-07: aliases have their own schemas: --json is --format json for validate, and to-md reads no --lang', () => {
  assert.deepEqual(parse('validate', '--json', '--format', 'json').warnings, []);
  assert.deepEqual(parse('render', 'a.smd', '--lang', 'de').warnings, []);
  assert.deepEqual(parse('to-md', 'a.smd', '--lang', 'de').warnings, ['Unknown option --lang for smd to-md; it is ignored.']);
});

test('t-07: smd lsp accepts the options editors pass, and migrate keeps its own unknown-option error', () => {
  assert.deepEqual(parse('lsp', '--stdio', '--clientProcessId=12').warnings, []);
  assert.deepEqual(parse('migrate', 'a.smd', '--to', '2', '--bogus').warnings, []);
  assert.deepEqual(parse('help', '--anything').warnings, []);
});

const cli = join(__dirname, '..', 'dist', 'cli.js');
/** The CLI tests run the built bundle; a test run without a build skips them, as the other CLI tests do. */
const skip = !fs.existsSync(cli) && 'run npm run build first';
const run = (args: string[], cwd: string) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd });

test('t-07: from the CLI the warning goes to stderr, JSON stays parseable and the exit code is unchanged', { skip }, () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-options-'));
  fs.writeFileSync(join(dir, 'ok.smd'), '---\nsmd: 2\ntitle: Ok\n---\n\n# Ok\n\n- [ ] Task\n');
  const r = run(['validate', 'ok.smd', '--json', '--strcit'], dir);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).errors, 0);
  assert.equal(r.stderr, '[smd] warning: Unknown option --strcit for smd validate (did you mean --strict?); it is ignored.\n');
});

test('t-07: --stale-after is checked only by the commands that read it', { skip }, () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-options-'));
  fs.writeFileSync(join(dir, 'ok.smd'), '---\nsmd: 2\ntitle: Ok\n---\n\n# Ok\n\n- [ ] Task\n');
  const tasks = run(['tasks', 'ok.smd', '--stale-after', 'soon'], dir);
  assert.equal(tasks.status, 0, tasks.stderr);
  assert.match(tasks.stderr, /Unknown option --stale-after for smd tasks/);
  const validate = run(['validate', 'ok.smd', '--stale-after', 'soon'], dir);
  assert.equal(validate.status, 2);
  assert.match(validate.stderr, /--stale-after needs a number of days/);
});

test('t-07: smd read --evidence, which the changelog documents, now reaches the view', { skip }, () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-options-'));
  fs.writeFileSync(join(dir, 'ev.smd'), [
    '---', 'smd: 2', 'title: Ev', '---', '',
    '## Work', '', ':::requirement{#R1} Refund quickly', 'R1_BODY', ':::', '',
    '## Checks', '', ':::evidence{#E1 supports=R1 method=test result=pass} Refund test', 'EVIDENCE_BODY', ':::', '',
  ].join('\n'));
  const plain = run(['read', 'ev.smd', '--section', 'Work'], dir);
  const full = run(['read', 'ev.smd', '--section', 'Work', '--evidence'], dir);
  assert.equal(full.status, 0, full.stderr);
  assert.doesNotMatch(plain.stdout, /EVIDENCE_BODY/);
  assert.match(full.stdout, /EVIDENCE_BODY/);
  assert.doesNotMatch(full.stderr, /Unknown option/);
});
