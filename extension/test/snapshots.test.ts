import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cases, compare, COMMANDS, corpusFiles, corpusSummary, differingParts, normalize, recorded, ROOT, runCases, runEnv, SNAPSHOTS,
  staleCli, streamDigest,
} from '../scripts/snapshots.mjs';

/** The output snapshot harness over both corpora (improvement roadmap t-01). */

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOTS, 'utf8')) as {
  corpus: { compat: number; research: number; digest: string };
  cases: Record<string, { status: number; stdout: string; stderr: string }>;
  options: { today: string };
};

test('t-01: the corpus is the 41 compatibility and 125 research files, and the snapshots were written from it', () => {
  const files = corpusFiles();
  const summary = corpusSummary(files);
  assert.equal(summary.compat, 41);
  assert.equal(summary.research, 125);
  assert.deepEqual(summary, snapshot.corpus, 'a corpus file changed: run node scripts/snapshots.mjs --update and review the diff');
  assert.ok(files.every((f) => !f.includes('\\') && !f.startsWith('/')), 'relative, /-separated paths');
  assert.deepEqual(corpusFiles(), files, 'the same list every time');
});

test('t-01: every file has a case for agent, validate --format json, export --to md and export --to html, and nothing else', () => {
  const keys = cases(corpusFiles()).map((c) => c.key).sort();
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
  const sample = cases(corpusFiles()).filter((c) => /(include|review-blocks)\.smd|p08[^/]*\/doc\.smd/.test(c.file));
  assert.ok(sample.length >= 12, 'includes, review blocks and an included shared file');
  const first = await runCases(cli, sample);
  const second = await runCases(cli, sample);
  for (const c of sample) {
    assert.deepEqual(second.get(c.key), first.get(c.key), `${c.key} is deterministic`);
    assert.deepEqual(recorded(first.get(c.key)), snapshot.cases[c.key], `${c.key} matches the snapshot`);
  }
});
