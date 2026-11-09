// Study 2 session logging (research requirements AF31, AF35 and AC-H): the event schema keeps no text, the logger
// does nothing until a session is turned on, and a release build leaves the study code out of the bundle.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import * as esbuild from 'esbuild';
import { cueCounts, EditBatch, studyBlockAt, studyCues, studyPageEvent, templateSlug } from '../src/study/cues';
import { ActiveClock, createStudyLogger, STUDY_LOGGER_OFF } from '../src/study/logger';
import { sanitizeStudyEvent, STUDY_EVENT_FIELDS, STUDY_EVENTS, STUDY_FIELDS, studyFixture } from '../src/study/schema';
import { isStudyBuild, STUDY_BUILD_ENV, STUDY_MARKERS, STUDY_PAGE_SCRIPT, studyDefine } from '../scripts/study-build.mjs';

const root = join(__dirname, '..');
const SECRET = 'Rotate the production keys before Friday';

const DOC = `---
smd: 2
title: ${SECRET}
---
# Plan

:::question{#q-db status=open} ${SECRET}
Which database?
:::

:::decision{#d1 status=superseded} Use SQLite
${SECRET}
:::

:::comment{for=q-db kind=answer author=alice} Re
Postgres.
:::

- [x] ${SECRET}
- [ ] Write the runbook
`;

test('AF35: the schema drops text, paths and names, and values of the wrong shape', () => {
  const clean = sanitizeStudyEvent('review', {
    action: 'accept', line: 4, applied: true,
    text: SECRET, title: SECRET, body: SECRET, path: 'C:\\Users\\alice\\spec.smd', file: 'spec.smd', user: 'alice',
    author: 'alice', message: SECRET, block: 'has spaces in it', kind: SECRET,
  });
  assert.ok(clean);
  assert.deepEqual(clean.fields, { action: 'accept', line: 4, applied: true });
  assert.deepEqual(clean.dropped.sort(), ['author', 'block', 'body', 'file', 'kind', 'message', 'path', 'text', 'title', 'user']);
  assert.equal(sanitizeStudyEvent('keystroke', { line: 1 }), undefined, 'unknown event types are refused');
  // A field allowed for one event is dropped from another.
  assert.deepEqual(sanitizeStudyEvent('focus', { focused: true, line: 3 })?.dropped, ['line']);
  // A cue list with any text in it is dropped whole.
  const cues = sanitizeStudyEvent('cue.render', { cues: [{ kind: 'question', line: 3 }, { kind: 'danger', line: 9, title: SECRET }] });
  assert.deepEqual(cues?.dropped, ['cues']);
  // Counts by kind only take known kinds as keys.
  assert.deepEqual(sanitizeStudyEvent('omissions.open', { counts: { [SECRET]: 1 } })?.dropped, ['counts']);
});

test('AF35: no string field accepts free text', () => {
  const samples = [SECRET, 'C:\\Users\\alice\\doc.smd', '/home/alice/doc.smd', 'alice@example.com', 'two words'];
  for (const [name, check] of Object.entries(STUDY_FIELDS)) {
    for (const s of samples) {
      assert.equal(check(s), false, `${name} accepted ${JSON.stringify(s)}`);
      assert.equal(check([s]), false, `${name} accepted [${JSON.stringify(s)}]`);
    }
  }
  for (const type of STUDY_EVENTS) {
    for (const field of STUDY_EVENT_FIELDS[type]) assert.ok(STUDY_FIELDS[field], `${type}.${field} has a check`);
  }
});

test('AF35: fixture names are kept only for the study\'s own s2- files', () => {
  assert.equal(studyFixture('C:\\study\\s2-t3-audit.smd'), 's2-t3-audit.smd');
  assert.equal(studyFixture('/x/s2-d1-spec.md'), 's2-d1-spec.md');
  assert.equal(studyFixture('/home/alice/notes.smd'), undefined);
  assert.equal(studyFixture('/x/s2-Secret Plan.smd'), undefined);
});

test('AC-H: without a session the logger is off and writes nothing', () => {
  const off = createStudyLogger();
  assert.equal(off, STUDY_LOGGER_OFF);
  assert.equal(off.enabled, false);
  assert.equal(off.log('session.start', { reason: 'env' }), undefined);
  assert.equal(off.docId('file:///x.smd'), '');
  assert.equal(createStudyLogger({ file: '' }).enabled, false);
});

test('AF31: a session writes JSON lines with an envelope, salted document ids and no text', () => {
  const lines: string[] = [];
  let clock = 1_000;
  let n = 0;
  const random = (size: number) => Buffer.alloc(size, ++n);
  const logger = createStudyLogger({ sink: (l) => lines.push(l), now: () => clock, random });
  assert.equal(logger.enabled, true);
  assert.match(logger.session, /^[0-9a-f]{16}$/);
  const uri = 'file:///c%3A/Users/alice/s2-d1-spec.smd';
  const doc = logger.docId(uri);
  assert.match(doc, /^[0-9a-f]{16}$/);
  assert.equal(logger.docId(uri), doc, 'the same id for the whole session');
  logger.log('session.start', { reason: 'command', version: '4.0.1' });
  clock += 250;
  logger.log('review', { doc, view: 'block-editor', action: 'accept', kind: 'suggestion', line: 12, block: 'q-db', applied: true, text: SECRET });
  assert.equal(lines.length, 2);
  const events = lines.map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(events[0]), ['v', 'session', 'seq', 't', 'ms', 'type', 'reason', 'version']);
  assert.equal(events[1].seq, 1);
  assert.equal(events[1].ms, 250);
  assert.equal(events[1].dropped, 1);
  assert.ok(!lines.join('').includes(SECRET));
  assert.ok(!lines.join('').includes('alice'));
  logger.close();
  assert.equal(logger.log('focus', { focused: false }), undefined, 'a closed session logs nothing');
  assert.equal(lines.length, 2);

  // A new session has a new id and a new salt: the same document gets a different id.
  const next = createStudyLogger({ sink: () => undefined, random });
  assert.notEqual(next.session, logger.session);
  assert.notEqual(next.docId(uri), doc);
});

test('AF31: cues are logged by kind, line, id and state, never by text', () => {
  const cues = studyCues(DOC);
  assert.deepEqual(cues, [
    { kind: 'question', line: 6, block: 'q-db', status: 'open' },
    { kind: 'decision', line: 10, block: 'd1', status: 'superseded' },
    { kind: 'comment', line: 14, status: 'open' },
    { kind: 'task', line: 18, state: 'done' },
    { kind: 'task', line: 19, state: 'undone' },
  ]);
  assert.deepEqual(cueCounts(cues), { question: 1, decision: 1, comment: 1, task: 2 });
  assert.ok(sanitizeStudyEvent('cue.render', { cues, counts: cueCounts(cues), count: cues.length })?.dropped.length === 0);
  assert.ok(!JSON.stringify(cues).includes(SECRET));
  // A comment's block is its target, and its kind is kept when it is one of the spec's.
  assert.deepEqual(studyBlockAt(DOC, 14), { kind: 'comment', block: 'q-db', status: 'open', commentKind: 'answer' });
  assert.deepEqual(studyBlockAt(DOC, 0), {});
  assert.equal(templateSlug('Agent block'), 'agent-block');
});

test('AF31: the preview page\'s cue events are checked again on the host', () => {
  const visible = studyPageEvent({ type: 'studyCue', event: 'visible', kind: 'danger', line: 4, block: 'no-db', durationMs: 900, text: SECRET });
  assert.deepEqual(visible, { type: 'cue.visible', fields: { kind: 'danger', line: 4, block: 'no-db', status: undefined, durationMs: 900 } });
  const toggle = studyPageEvent({ type: 'studyCue', event: 'toggle', kind: 'details', line: 7, block: SECRET, state: 'open' });
  assert.deepEqual(toggle?.fields, { kind: 'details', line: 7, block: undefined, state: 'open' });
  assert.equal(studyPageEvent({ type: 'rendered' }), undefined);
  assert.equal(studyPageEvent({ type: 'studyCue', event: 'keys' }), undefined);
  const odd = studyPageEvent({ type: 'studyCue', event: 'toggle', kind: SECRET, line: 'x', state: 'maybe' })!;
  assert.deepEqual(sanitizeStudyEvent(odd.type, odd.fields)?.fields, { kind: 'other' });
});

test('AF31: edits are coalesced into line ranges and sizes', () => {
  const batch = new EditBatch(0);
  batch.add([{ startLine: 8, endLine: 8, rangeLength: 0, textLength: 5 }], 100);
  batch.add([{ startLine: 3, endLine: 4, rangeLength: 12, textLength: 0 }, { startLine: 10, endLine: 10, rangeLength: 1, textLength: 1 }], 900);
  assert.deepEqual(batch.fields(), { line: 3, lineEnd: 10, changes: 3, inserted: 6, deleted: 13, durationMs: 900 });
});

test('AF31: active time counts focused time with recent activity, up to the idle limit', () => {
  const clock = new ActiveClock(true, 0, 60_000);
  clock.touch(10_000);
  clock.touch(20_000);
  assert.equal(clock.activeMs(20_000), 20_000);
  clock.touch(200_000); // 180 s idle: only the limit counts
  assert.equal(clock.activeMs(200_000), 80_000);
  clock.setFocused(false, 205_000);
  assert.equal(clock.activeMs(500_000), 85_000, 'unfocused time is not active');
  clock.touch(510_000);
  assert.equal(clock.activeMs(510_000), 85_000);
  clock.setFocused(true, 600_000);
  assert.equal(clock.activeMs(601_000), 86_000);
});

test('AC-H: a study build is asked for explicitly', () => {
  assert.equal(isStudyBuild(['node', 'build.mjs'], {}), false);
  assert.equal(isStudyBuild(['node', 'build.mjs', '--watch'], { [STUDY_BUILD_ENV]: '0' }), false);
  assert.equal(isStudyBuild(['node', 'build.mjs', '--study'], {}), true);
  assert.equal(isStudyBuild(['node', 'build.mjs'], { [STUDY_BUILD_ENV]: '1' }), true);
  assert.deepEqual(studyDefine(false), { __SMD_STUDY__: 'false' });
  const build = readFileSync(join(root, 'scripts', 'build.mjs'), 'utf8');
  assert.match(build, /\.\.\.studyDefine\(study\)/, 'build.mjs defines __SMD_STUDY__ for every bundle');
  assert.match(build, /rmSync\(studyPage/, 'a release build deletes a stale study page script');
  assert.equal(STUDY_PAGE_SCRIPT, 'dist/webview/study-cues.js');
});

test('AC-H: the release manifest contributes no study command or setting', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(pkg.contributes), /study/i);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /study/i);
});

/** The extension bundle as build.mjs makes it, in memory. */
async function bundle(study: boolean): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [join(root, 'src', 'extension.ts')],
    bundle: true, platform: 'node', target: 'node20', format: 'cjs', minify: true, write: false, logLevel: 'silent',
    external: ['vscode'], loader: { '.md': 'text', '.smd': 'text' },
    define: { ...studyDefine(study) },
  });
  return result.outputFiles[0].text;
}

test('AC-H: a release build of the extension leaves the study code out; a study build has it', async () => {
  const [release, study] = await Promise.all([bundle(false), bundle(true)]);
  for (const marker of STUDY_MARKERS) {
    assert.ok(!release.includes(marker), `the release bundle contains ${marker}`);
    assert.ok(study.includes(marker), `the study bundle lacks ${marker}`);
  }
  for (const event of ['cue.visible', 'omissions.choose', 'session.start']) assert.ok(!release.includes(event), `release bundle has ${event}`);
});
