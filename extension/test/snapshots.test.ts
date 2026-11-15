import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  allCases, compare, COMMANDS, CONFORMANCE, conformanceArgv, corpusFiles, corpusSummary, differingParts, inputFiles, normalize,
  recorded, requestCases, ROOT, runCases, runEnv, SNAPSHOTS, staleCli, streamDigest,
} from '../scripts/snapshots.mjs';
import { cliArgs, type Route } from './conformance/oracle';

/** The output snapshot harness over both corpora (improvement roadmap t-01) and the focused fixtures (t-02). */

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOTS, 'utf8')) as {
  corpus: { compat: number; research: number; focused: number; requests: { focused: number; conformance: number }; digest: string };
  cases: Record<string, { status: number; stdout: string; stderr: string }>;
  options: { today: string };
};

test('t-01: the corpus is the 41 compatibility and 125 research files and the 8 focused fixtures, and the snapshots were written from it', () => {
  const files = corpusFiles();
  const summary = corpusSummary(files);
  assert.equal(summary.compat, 41);
  assert.equal(summary.research, 125);
  assert.equal(summary.focused, 8);
  assert.deepEqual(summary.requests, { focused: 26, conformance: 70 });
  assert.ok(!files.some((f) => f.includes('/parts/')), 'included parts are read through the fixtures, not as corpus files');
  const inputs = inputFiles();
  for (const f of ['extension/test/snapshots/fixtures/parts/deep/nested-c.smd', 'extension/test/snapshots/fixtures/requests.json', `${CONFORMANCE}/08-rule-chains/case.json`]) {
    assert.ok(inputs.includes(f), `the digest covers ${f}`);
  }
  assert.deepEqual(summary, snapshot.corpus, 'a corpus file changed: run node scripts/snapshots.mjs --update and review the diff');
  assert.ok(files.every((f) => !f.includes('\\') && !f.startsWith('/')), 'relative, /-separated paths');
  assert.deepEqual(corpusFiles(), files, 'the same list every time');
});

test('t-01: every file has a case for agent, validate --format json, export --to md and export --to html, and the requests add the rest', () => {
  const keys = allCases(corpusFiles()).map((c) => c.key).sort();
  assert.deepEqual(keys, Object.keys(snapshot.cases).sort());
  assert.deepEqual(Object.keys(COMMANDS), ['agent', 'validate', 'md', 'html']);
  for (const argv of Object.values(COMMANDS)) {
    if (argv[0] !== 'export' || argv.includes('html')) assert.ok(argv.includes(snapshot.options.today), `${argv.join(' ')} has the fixed date`);
  }
  const record = Object.values(snapshot.cases)[0];
  assert.match(record.stdout, /^[0-9a-f]{24}:\d+$/);
  assert.match(record.stderr, /^[0-9a-f]{24}:\d+$/);
  assert.equal(typeof record.status, 'number', 'exit status, stdout and stderr are recorded separately');
});

test('t-02: every read-contract request is snapshotted with the arguments the oracle gives the CLI, at the fixed date', () => {
  const requests = requestCases();
  const conformance = requests.filter((c) => c.source === 'conformance');
  let total = 0;
  for (const dir of fs.readdirSync(join(ROOT, CONFORMANCE))) {
    const listed = JSON.parse(fs.readFileSync(join(ROOT, CONFORMANCE, dir, 'case.json'), 'utf8')) as { requests: Array<{ name: string; doc?: string; route: Route }> };
    for (const r of listed.requests) {
      total++;
      const file = `${CONFORMANCE}/${dir}/${r.doc ?? 'doc.smd'}`;
      const c = conformance.find((x) => x.key === `${file} · conformance: ${r.name}`);
      assert.ok(c, `${dir}: ${r.name} has a case`);
      assert.deepEqual(c.argv, [...cliArgs(file, r.route), '--today', snapshot.options.today]);
      assert.deepEqual(conformanceArgv(file, r.route), c.argv);
    }
  }
  assert.equal(conformance.length, total);
  for (const c of requests.filter((x) => x.source === 'focused')) {
    assert.ok(c.argv.includes(c.file) && !c.argv.some((a) => /^\{.*\}$/.test(a)), `${c.key}: the file and the date are filled in`);
    assert.deepEqual(c.argv.slice(-2), ['--today', snapshot.options.today], `${c.key} has the fixed date`);
  }
});

test('t-01: runs get a fixed locale and time zone and none of smd\'s own variables', () => {
  const env = runEnv({ PATH: '/bin', SMD_DEBUG: '1', SMD_BROWSER: '/x', LANG: 'de_DE.UTF-8', TZ: 'Europe/Berlin', HOME: '/h' });
  assert.deepEqual(env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1', PATH: '/bin', HOME: '/h' });
});

test('t-01: output is normalized so Windows and Linux agree, and nothing else changes', () => {
  const root = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
  const file = 'docs/a b/x.smd';
  const windows = process.platform === 'win32';
  const text = [
    `${root}${windows ? '\\' : '/'}docs/x.smd`, pathToFileURL(root).href + '/img.png', windows ? 'docs\\a b\\x.smd:3' : 'docs/a b/x.smd:3', 'a \\* b',
  ].join('\n');
  const out = normalize(text, file, root);
  assert.equal(out.split('\n')[0], `<root>${windows ? '\\' : '/'}docs/x.smd`);
  assert.equal(out.split('\n')[1], '<root>/img.png');
  assert.equal(out.split('\n')[2], 'docs/a b/x.smd:3');
  assert.equal(out.split('\n')[3], 'a \\* b', 'other backslashes are kept');
});

test('t-01: compare names changed, new and gone cases and which streams differ', () => {
  const a = { status: 0, stdout: streamDigest('x'), stderr: streamDigest('') };
  const b = { ...a, stdout: streamDigest('y') };
  assert.deepEqual(compare({ k1: a, k2: a, k3: a }, { k1: a, k2: b, k4: a }), { changed: ['k2'], added: ['k4'], removed: ['k3'] });
  assert.deepEqual(differingParts(a, b), ['stdout']);
  assert.deepEqual(differingParts(a, { ...a, status: 1, stderr: streamDigest('!') }), ['status', 'stderr']);
  assert.deepEqual(recorded({ status: 2, stdout: 'é', stderr: '' }), { status: 2, stdout: `${streamDigest('é')}`, stderr: streamDigest('') });
  assert.match(streamDigest('é'), /:2$/, 'the length is in bytes');
});

const cli = join(ROOT, 'extension', 'dist', 'cli.js');

test('t-01: the built CLI reproduces the snapshots, run after run', {
  skip: (staleCli() !== undefined) && 'run npm run build first',
  timeout: 120_000,
}, async () => {
  const sample = allCases(corpusFiles()).filter((c) => /(include|review-blocks|nested-includes)\.smd|p08[^/]*\/doc\.smd|token-budget\.smd · request: budget 2|08-rule-chains/.test(c.key));
  assert.ok(sample.length >= 25, 'includes, review blocks, an included shared file, nested includes, budgets and rule chains');
  const first = await runCases(cli, sample);
  const second = await runCases(cli, sample);
  for (const c of sample) {
    assert.deepEqual(second.get(c.key), first.get(c.key), `${c.key} is deterministic`);
    assert.deepEqual(recorded(first.get(c.key)), snapshot.cases[c.key], `${c.key} matches the snapshot`);
  }
});
