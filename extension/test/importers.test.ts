import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decisionLog, extractTasks, IMPORT_FORMATS, madrToSmd, parseFrontMatter, specKitTasksToSmd, validateSmd, type ImportResult,
} from '../src/core';
import { dependsNote } from '../src/core/importers';

const today = '2026-11-10';

/** The output validates with no errors and no warnings (hints and infos are fine: unknown keys, stale dates). */
function assertValid(result: ImportResult): void {
  const problems = validateSmd(result.text).filter((d) => d.severity === 'error' || d.severity === 'warning');
  assert.deepEqual(problems.map((d) => `${d.line + 1} ${d.code}: ${d.message}`), []);
}

/** Every non-blank source line that isn't in `taken` is still in the output, as written. */
function assertKept(source: string, result: ImportResult, taken: readonly string[] = []): void {
  const out = new Set(result.text.split('\n').map((l) => l.trim()));
  const lost = source.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== '---' && !taken.includes(l) && !out.has(l));
  assert.deepEqual(lost, []);
}

/** The decisions of a converted document, as `smd decisions` reads them. */
function decisions(result: ImportResult) {
  return decisionLog([{ path: 'adr.smd', text: result.text }]);
}

// MADR

const madr2 = [
  '# Use Markdown Architectural Decision Records',
  '',
  '* Status: Accepted',
  '* Deciders: Oliver, Anna',
  '* Date: 2017-12-15',
  '',
  'Technical Story: [#42](https://example.com/issues/42)',
  '',
  '## Context and Problem Statement',
  '',
  'We want to record architectural decisions.',
  '',
  '> [!NOTE]',
  '> MADR is lean.',
  '',
  '## Considered Options',
  '',
  '* MADR 2.1.2',
  "* Michael Nygard's template",
  '',
  '## Decision Outcome',
  '',
  'Chosen option: "MADR 2.1.2", because it is lean.',
  '',
  '### Positive Consequences',
  '',
  '* Structured',
  '',
  '## Links',
  '',
  '* Refined by [ADR-0005](0005-example.md)',
  '',
].join('\n');

test('madr: MADR 2 bullets become the decision status, date and owner; the prose stays', () => {
  const r = madrToSmd(madr2, 'fallback', { today });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.text, [
    '---',
    'smd: 2',
    'title: "Use Markdown Architectural Decision Records"',
    'status: approved',
    'owners: ["Oliver", "Anna"]',
    'tags: [adr]',
    'updated: 2017-12-15',
    '---',
    '',
    'Technical Story: [#42](https://example.com/issues/42)',
    '',
    '## Context and Problem Statement',
    '',
    'We want to record architectural decisions.',
    '',
    ':::note',
    'MADR is lean.',
    ':::',
    '',
    '## Considered Options',
    '',
    '* MADR 2.1.2',
    "* Michael Nygard's template",
    '',
    '## Decision Outcome',
    '',
    ':::decision{status=accepted date=2017-12-15 owner="Oliver, Anna"} Use Markdown Architectural Decision Records',
    'Chosen option: "MADR 2.1.2", because it is lean.',
    ':::',
    '',
    '### Positive Consequences',
    '',
    '* Structured',
    '',
    '## Links',
    '',
    '* Refined by [ADR-0005](0005-example.md)',
    '',
  ].join('\n'));
  assertValid(r);
  assertKept(madr2, r, ['# Use Markdown Architectural Decision Records', '* Status: Accepted', '* Deciders: Oliver, Anna', '* Date: 2017-12-15', '> [!NOTE]', '> MADR is lean.']);
  const [d] = decisions(r);
  assert.equal(d.status, 'accepted');
  assert.equal(d.date, '2017-12-15');
  assert.equal(d.owner, 'Oliver, Anna');
});

const madr4 = [
  '---',
  '# These are optional metadata elements. Feel free to remove any of them.',
  'status: accepted',
  'date: 2024-03-01',
  'decision-makers:',
  '  - "@alice"',
  '  - Bob Smith',
  'consulted: Carol',
  'informed: Dave, Erin',
  '---',
  '',
  '# Use PostgreSQL for orders',
  '',
  '## Context and Problem Statement',
  '',
  'We need a store for orders. The job runs at 10:30 and :abbr[x] is text on GitHub.',
  '',
  '## Decision Drivers',
  '',
  '* Ops know it',
  '',
  '## Considered Options',
  '',
  '* PostgreSQL',
  '* MySQL',
  '',
  '## Decision Outcome',
  '',
  'Chosen option: "PostgreSQL", because ops already run it.',
  '',
  '<!-- This is an optional element. Feel free to remove. -->',
  '### Consequences',
  '',
  '* Good, because no new database',
  '* Bad, because of the migration',
  '',
  '### Confirmation',
  '',
  'A design review.',
  '',
  '## Pros and Cons of the Options',
  '',
  '### PostgreSQL',
  '',
  '* Good, because ops know it',
  '',
  '## More Information',
  '',
  'See [ADR-0002](0002-x.md).',
  '',
].join('\n');

test('madr: MADR 4 front matter maps to the decision and the document; consulted and informed stay', () => {
  const r = madrToSmd(madr4, 'fallback', { today });
  assert.deepEqual(r.warnings, []);
  const fm = parseFrontMatter(r.text).data;
  assert.deepEqual(fm, {
    smd: 2, title: 'Use PostgreSQL for orders', status: 'approved', owners: ['@alice', 'Bob Smith'], tags: ['adr'],
    updated: '2024-03-01', consulted: 'Carol', informed: 'Dave, Erin',
  });
  // The template's comment line stays with the keys it describes.
  assert.match(r.text, /^# These are optional metadata elements\. Feel free to remove any of them\.\nconsulted: Carol$/m);
  assert.match(r.text, /^## Decision Outcome\n\n:::decision\{status=accepted date=2024-03-01 owner="@alice, Bob Smith"\} Use PostgreSQL for orders\nChosen option: "PostgreSQL", because ops already run it\.\n:::\n\n<!-- This is an optional element\. Feel free to remove\. -->\n### Consequences\n/m);
  // Prose is converted as smd from-md converts it.
  assert.match(r.text, /at 10:30 and \\:abbr\[x\] is text/);
  assertValid(r);
  assertKept(madr4, r, ['status: accepted', 'date: 2024-03-01', 'decision-makers:', '- "@alice"', '- Bob Smith', '# Use PostgreSQL for orders',
    'We need a store for orders. The job runs at 10:30 and :abbr[x] is text on GitHub.']);
});

test('madr: MADR 3 says deciders; a front matter list or a comma list both give owners', () => {
  const md = ['---', 'status: proposed', 'date: 2023-01-02', 'deciders: Ann, Bo', '---', '# Cache sessions', '',
    '## Context and Problem Statement', '', 'Slow.', '', '## Decision Outcome', '', 'Chosen option: "Redis".', ''].join('\n');
  const r = madrToSmd(md, 'x', { today });
  assert.deepEqual(r.warnings, []);
  assert.match(r.text, /^status: review\nowners: \["Ann", "Bo"\]\n/m);
  assert.doesNotMatch(r.text, /deciders/);
  assert.match(r.text, /^:::decision\{status=proposed date=2023-01-02 owner="Ann, Bo"\} Cache sessions$/m);
  assertValid(r);
});

test('madr: without front matter or bullets, the decision has no status and the document is a draft', () => {
  const md = ['# Pick a queue', '', '## Context and Problem Statement', '', 'Text.', '', '## Decision Outcome', '', 'Chosen option: "SQS".', ''].join('\n');
  const r = madrToSmd(md, 'x', { today });
  assert.deepEqual(r.warnings, []);
  assert.match(r.text, /^status: draft\ntags: \[adr\]\nupdated: 2026-11-10\n---\n/m);
  assert.match(r.text, /^:::decision Pick a queue\nChosen option: "SQS"\.\n:::$/m);
  assert.equal(decisions(r)[0].title, 'Pick a queue');
  assertValid(r);
  assertKept(md, r, ['# Pick a queue']);
});

test('madr: every MADR status maps to the decision status and a document status', () => {
  const expected: Record<string, string> = {
    proposed: 'review', accepted: 'approved', rejected: 'archived', deprecated: 'deprecated', superseded: 'deprecated',
  };
  for (const [status, document] of Object.entries(expected)) {
    for (const written of [status, status.toUpperCase()]) {
      const fm = madrToSmd(`---\nstatus: ${written}\n---\n# T\n\n## Decision Outcome\n\nChosen option: "A".\n`, 'x', { today });
      const bullets = madrToSmd(`# T\n\n* Status: ${written}\n\n## Decision Outcome\n\nChosen option: "A".\n`, 'x', { today });
      for (const r of [fm, bullets]) {
        assert.deepEqual(r.warnings, [], written);
        assert.equal(parseFrontMatter(r.text).data.status, document, written);
        assert.match(r.text, new RegExp(`^:::decision\\{status=${status}\\} T$`, 'm'), written);
        assert.equal(decisions(r)[0].status, status);
        assertValid(r);
      }
    }
  }
});

test('madr: "superseded by ADR-0005" is superseded, and the link stays as the first line of the decision', () => {
  const md = ['---', 'status: superseded by [ADR-0005](0005-use-kafka.md)', 'date: 2022-05-01', '---', '# Use RabbitMQ', '',
    '## Decision Outcome', '', 'Chosen option: "RabbitMQ".', ''].join('\n');
  const r = madrToSmd(md, 'x', { today });
  assert.deepEqual(r.warnings, []);
  assert.match(r.text, /^:::decision\{status=superseded date=2022-05-01\} Use RabbitMQ\nSuperseded by \[ADR-0005\]\(0005-use-kafka\.md\)\n\nChosen option: "RabbitMQ"\.\n:::$/m);
  assert.equal(parseFrontMatter(r.text).data.status, 'deprecated');
  assertValid(r);

  // MADR 2 writes it as a bullet; the bullet is read, and its text moves into the decision.
  const two = madrToSmd('# Use RabbitMQ\n\n* Status: superseded by [ADR-0005](0005-use-kafka.md)\n\n## Decision Outcome\n\nChosen option: "RabbitMQ".\n', 'x', { today });
  assert.deepEqual(two.warnings, []);
  assert.doesNotMatch(two.text, /^\* Status/m);
  assert.match(two.text, /^:::decision\{status=superseded\} Use RabbitMQ\nSuperseded by \[ADR-0005\]\(0005-use-kafka\.md\)\n/m);
  assertValid(two);
});

test('madr: an unknown status is kept as text and warned about, never dropped', () => {
  const fm = madrToSmd('---\nstatus: in review\n---\n# T\n\n## Decision Outcome\n\nChosen option: "A".\n', 'x', { today });
  assert.deepEqual(fm.warnings, ['unknown MADR status "in review": kept as text in the decision, which has no status.']);
  assert.match(fm.text, /^:::decision T\nStatus: in review\n\nChosen option: "A"\.\n:::$/m);
  assert.equal(parseFrontMatter(fm.text).data.status, 'draft');
  assertValid(fm);

  // A MADR 2 bullet with an unknown status stays the bullet it was.
  const bullets = madrToSmd('# T\n\n* Status: on hold\n* Date: 2020-02-02\n\n## Decision Outcome\n\nChosen option: "A".\n', 'x', { today });
  assert.deepEqual(bullets.warnings, ['unknown MADR status "on hold": kept as text in the decision, which has no status.']);
  assert.match(bullets.text, /^---\n\n\* Status: on hold\n\n## Decision Outcome\n\n:::decision\{date=2020-02-02\} T\nChosen option/m);
  assertValid(bullets);
});

test('madr: a date that is not YYYY-MM-DD and a template placeholder stay as written, with warnings', () => {
  const r = madrToSmd('---\nstatus: accepted\ndate: last spring\n---\n# T\n\n## Decision Outcome\n\nChosen.\n', 'x', { today });
  assert.deepEqual(r.warnings, ['date "last spring" is not YYYY-MM-DD: kept in the front matter, the decision has no date.']);
  assert.match(r.text, /^date: last spring$/m);
  assert.match(r.text, /^:::decision\{status=accepted\} T$/m);
  assertValid(r);

  // MADR 4's template: its `{…}` placeholders read as YAML mappings, not names or dates, and stay as written.
  const template = ['---', 'status: "{proposed | rejected | accepted | deprecated | … | superseded by ADR-0123}"',
    'date: {YYYY-MM-DD when the decision was last updated}', 'decision-makers: {list everyone involved in the decision}', '---',
    '# {short title}', '', '## Decision Outcome', '', 'Chosen option: "{title of option 1}".', ''].join('\n');
  const t = madrToSmd(template, 'x', { today });
  assert.equal(t.warnings.length, 2);
  assert.match(t.text, /^date: \{YYYY-MM-DD when the decision was last updated\}\ndecision-makers: \{list everyone involved in the decision\}\n---$/m);
  assert.match(t.text, /^:::decision \{short title\}\nStatus: \{proposed \| rejected/m);
  assertValid(t);
});

test('madr: without a Decision Outcome section the decision goes first; front matter that cannot be read is kept', () => {
  const r = madrToSmd('# Adopt X\n\n* Status: proposed\n\n## Context and Problem Statement\n\nWhy.\n', 'x', { today });
  assert.match(r.text, /^---\n\n:::decision\{status=proposed\} Adopt X\n:::\n\n## Context and Problem Statement\n\nWhy\.\n$/m);
  assertValid(r);

  const broken = madrToSmd('---\nstatus: [oops\n---\n# T\n\nText.\n', 'x', { today });
  assert.deepEqual(broken.warnings, ['the front matter could not be read: kept as a yaml code block at the top of the body.']);
  assert.match(broken.text, /^```yaml\nstatus: \[oops\n```$/m);
  assertValid(broken);
});

test('madr: the title falls back to the file name, CRLF input converts, and a fence inside the outcome gets more colons', () => {
  const r = madrToSmd('## Decision Outcome\r\n\r\n:::note\r\nInside.\r\n:::\r\n', 'adr-0009', { today });
  assert.match(r.text, /^title: "adr-0009"$/m);
  assert.match(r.text, /^::::decision adr-0009\n:::note\nInside\.\n:::\n::::$/m);
  assert.doesNotMatch(r.text, /\r/);
  assertValid(r);
});

// Spec Kit

const tasksMd = [
  '---',
  '',
  'description: "Task list for the photo albums feature"',
  '---',
  '',
  '# Tasks: Photo albums',
  '',
  '**Input**: Design documents from `/specs/001-photo-albums/`',
  '',
  '## Format: `[ID] [P?] [Story] Description`',
  '',
  '- **[P]**: Can run in parallel (different files, no dependencies)',
  '',
  '## Phase 1: Setup (Shared Infrastructure)',
  '',
  '- [X] T001 Create project structure per implementation plan',
  '- [x] T002 [P] Configure linting and formatting tools',
  '',
  '---',
  '',
  '## Phase 3: User Story 1 - Albums (Priority: P1) 🎯 MVP',
  '',
  '### Implementation for User Story 1',
  '',
  '- [ ] T012 [P] [US1] Create Album model in src/models/album.py',
  '- [ ] T013 [P] [US1] Create Photo model in src/models/photo.py',
  '- [ ] T014 [US1] Implement AlbumService in src/services/album.py (depends on T012, T013)',
  '- [ ] T015 [US1] Implement the endpoint in src/api/albums.py (Depends on: T014)',
  '- [ ] T016 [US1] Add validation (depends on T012 and T099)',
  '- [ ] T017 [US1] Wire it up (depends on T012-T014)',
  '- [ ] T018 [US1] Logging depends on T014 and the logger',
  '- [ ] T019 Already has an id {#keep}',
  '- [ ] T012 A repeated id',
  '- [ ] TXXX Placeholder without a number',
  '',
  '```bash',
  '- [ ] T900 Not a task: inside code',
  '```',
  '',
  '## Dependencies & Execution Order',
  '',
  '- **Setup (Phase 1)**: No dependencies - can start immediately',
  '',
].join('\n');

test('spec-kit: tasks get their ids, explicit dependencies become :depends, and every line stays', () => {
  const r = specKitTasksToSmd(tasksMd, 'tasks', { today });
  const lines = r.text.split('\n');
  assert.deepEqual(lines.slice(0, 8), ['---', 'smd: 2', 'title: "Tasks: Photo albums"', 'status: draft', 'updated: 2026-11-10',
    'description: "Task list for the photo albums feature"', '---', '']);
  const body = r.text.slice(r.text.indexOf('**Input**'));
  for (const line of [
    '- [X] T001 Create project structure per implementation plan {#T001}',
    '- [x] T002 [P] Configure linting and formatting tools {#T002}',
    '- [ ] T012 [P] [US1] Create Album model in src/models/album.py {#T012}',
    '- [ ] T014 [US1] Implement AlbumService in src/services/album.py (depends on T012, T013) :depends[T012,T013] {#T014}',
    '- [ ] T015 [US1] Implement the endpoint in src/api/albums.py (Depends on: T014) :depends[T014] {#T015}',
    '- [ ] T016 [US1] Add validation (depends on T012 and T099) {#T016}',
    '- [ ] T017 [US1] Wire it up (depends on T012-T014) {#T017}',
    '- [ ] T018 [US1] Logging depends on T014 and the logger {#T018}',
    '- [ ] T019 Already has an id {#keep}',
    '- [ ] T012 A repeated id',
    '- [ ] TXXX Placeholder without a number',
    '- [ ] T900 Not a task: inside code',
    '## Phase 3: User Story 1 - Albums (Priority: P1) 🎯 MVP',
  ]) assert.ok(body.split('\n').includes(line), line);
  assert.deepEqual(r.warnings, [
    'a second task T012 ("T012 A repeated id") gets no {#T012}: an id names one task.',
    'task T016: depends on T099, which no other task of the file is, kept as text.',
    'task T017: "depends on T012-T014)" is not a plain list of task ids, kept as text.',
    'task T018: "depends on T014 and the logger" is not a plain list of task ids, kept as text.',
  ]);
  assertKept(tasksMd, r, ['# Tasks: Photo albums', '- [X] T001 Create project structure per implementation plan',
    '- [x] T002 [P] Configure linting and formatting tools', '- [ ] T012 [P] [US1] Create Album model in src/models/album.py',
    '- [ ] T013 [P] [US1] Create Photo model in src/models/photo.py',
    '- [ ] T014 [US1] Implement AlbumService in src/services/album.py (depends on T012, T013)',
    '- [ ] T015 [US1] Implement the endpoint in src/api/albums.py (Depends on: T014)', '- [ ] T016 [US1] Add validation (depends on T012 and T099)',
    '- [ ] T017 [US1] Wire it up (depends on T012-T014)', '- [ ] T018 [US1] Logging depends on T014 and the logger']);
  // The converted file keeps every source line as a prefix of its own.
  for (const l of tasksMd.split('\n').filter((x) => /^- \[[ xX]\] T\d/.test(x))) assert.ok(r.text.split('\n').some((o) => o.startsWith(l)), l);
  assertValid(r);
});

test('spec-kit: smd tasks reads the ids, checked state, sections and dependencies', () => {
  const r = specKitTasksToSmd(tasksMd, 'tasks', { today });
  const tasks = extractTasks(r.text);
  const byId = new Map(tasks.filter((t) => t.id).map((t) => [t.id, t]));
  assert.equal(byId.get('T001')?.done, true);
  assert.equal(byId.get('T002')?.done, true);
  assert.equal(byId.get('T012')?.done, false);
  assert.equal(byId.get('T012')?.section, 'Implementation for User Story 1');
  assert.deepEqual(byId.get('T014')?.depends, ['T012', 'T013']);
  assert.deepEqual(byId.get('T015')?.depends, ['T014']);
  assert.equal(byId.get('T016')?.depends, undefined);
  assert.ok(!tasks.some((t) => t.text.includes('T900')), 'a task-shaped line in code is not a task');
});

test('spec-kit: a file without front matter or H1 gets the file name as title', () => {
  const r = specKitTasksToSmd('## Phase 1\n\n- [ ] T001 Do it\n- [ ] T002 Then this (depends on T001)\n', 'tasks', { today });
  assert.equal(r.text, '---\nsmd: 2\ntitle: "tasks"\nstatus: draft\nupdated: 2026-11-10\n---\n\n## Phase 1\n\n- [ ] T001 Do it {#T001}\n- [ ] T002 Then this (depends on T001) :depends[T001] {#T002}\n');
  assert.deepEqual(r.warnings, []);
  assertValid(r);
});

// Requires `npm run build`.
const cli = join(__dirname, '..', 'dist', 'cli.js');

test('CLI: smd from-md --from madr|spec-kit writes the import, warnings on stderr; an unknown format exits 2', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
  assert.deepEqual([...IMPORT_FORMATS], ['madr', 'spec-kit']);
  const dir = mkdtempSync(join(tmpdir(), 'smd-import-'));
  try {
    const adr = join(dir, '0001-use-x.md');
    writeFileSync(adr, '---\nstatus: on hold\n---\n# Use X\n\n## Decision Outcome\n\nChosen.\n');
    const out = join(dir, '0001-use-x.smd');
    const run = spawnSync(process.execPath, [cli, 'from-md', adr, '--from', 'madr', '-o', out, '--today', today], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stderr, /\[smd\] warning: .*0001-use-x\.md: unknown MADR status "on hold"/);
    assert.match(readFileSync(out, 'utf8'), /^:::decision Use X\nStatus: on hold\n/m);
    const check = spawnSync(process.execPath, [cli, 'validate', out], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);

    const tasks = join(dir, 'tasks.md');
    writeFileSync(tasks, '# Tasks\n\n- [ ] T001 A\n- [ ] T002 B (depends on T001)\n');
    const kit = spawnSync(process.execPath, [cli, 'from-md', tasks, '--from', 'spec-kit', '--today', today], { encoding: 'utf8' });
    assert.equal(kit.status, 0);
    assert.match(kit.stdout, /^- \[ \] T002 B \(depends on T001\) :depends\[T001\] \{#T002\}$/m);

    // Without --from, from-md converts as before.
    const plain = spawnSync(process.execPath, [cli, 'from-md', tasks], { encoding: 'utf8' });
    assert.match(plain.stdout, /^- \[ \] T001 A$/m);

    const bad = spawnSync(process.execPath, [cli, 'from-md', tasks, '--from', 'jira'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--from needs one of: madr, spec-kit \(got "jira"\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dependency-note scanner reads what the earlier regular expression read, in linear time', () => {
  // The expression the scanner replaced, kept here as the reference for its behaviour.
  const OLD = /\bdepends\s+on\s*:?\s+(T\d+(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)T\d+)*)(.?)/i;
  const old = (text: string) => {
    const m = OLD.exec(text);
    return m ? { index: m.index, ids: m[1].split(/\s*(?:,|&|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean), next: m[2] } : undefined;
  };
  const cases = [
    'Add model (depends on T001)', 'Wire API (depends on T001, T002)', 'X Depends on: T014', 'x depends on T1 and T2 and T3.',
    'x depends on T1, and T2; then', 'x depends on T1 & T2', 'x depends on T1-T3', 'x depends on T1 and then more', 'x depends on:T1',
    'x depends onto T1', 'x depends on', 'x depends on nothing, then depends on T7)', 'x depends on t5', 'x depends on T1,T2,',
    'x depends on T1 , and', 'x depends   on  :   T9 ', 'no note here', 'x depends on T1\nnext line',
  ];
  for (const text of cases) assert.deepEqual(dependsNote(text), old(text), text);
  const long = `x depends on T1${', T2'.repeat(20000)} and more`;
  const started = Date.now();
  assert.equal(dependsNote(long)?.ids.length, 20001);
  assert.ok(Date.now() - started < 1000, 'a long note stays fast');
});
