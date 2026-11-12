// Tree selectors (docs/requirements/tree-and-graph-filtering.smd, T1 to T4 and T7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSelector, querySmd, SelectorError } from '../src/core';

// T7: selectors that worked before tree selectors keep their matches, order and output

const TODAY = '2026-10-28';
const FIXTURE = path.join(__dirname, 'compat', 'query-t7.json');

/** Selectors written with the grammar released before tree selectors. */
const LEGACY_SELECTORS = [
  '*', 'decision', 'decision[status=accepted]', 'decision[status=proposed|accepted]', 'risk', 'risk[impact>=high][status!=closed]',
  'risk[likelihood]', 'api[method=POST|PUT]', 'api[path^=/v1/]', 'task', 'task[done=false]', 'task[owner=@maya]', 'task[due<today]',
  'task[priority<=P1]', 'task[overdue]', 'question, risk', 'heading', 'heading[level=2]', 'heading[level<=2][id^=r]', 'callout',
  'callout[title*=migration]', '*[owner]', '[id]', 'agent', 'human', 'warning, danger', 'heading[section*=a]', 'decision, task[done=true], heading[level=3]',
  'figure', 'tabs, tab', 'details', 'include', 'requirement, constraint, acceptance', '*[section$=s]', 'note[title]', 'decision[title*=event]',
];

function corpus(): Array<{ name: string; text: string }> {
  const dirs = [path.join(__dirname, 'samples'), path.join(__dirname, 'compat', 'corpus')];
  return dirs.flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.smd')).sort()
    .map((f) => ({ name: `${path.basename(dir)}/${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8') })));
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** One line per match: where, what, and a hash of its attributes, section and agent view text. */
function snapshot(): Record<string, string[]> {
  const docs = corpus();
  const out: Record<string, string[]> = {};
  for (const selector of LEGACY_SELECTORS) {
    out[selector] = docs.flatMap((d) => querySmd(d.text, selector, { today: TODAY }).map((m) =>
      `${d.name}:${m.line + 1}-${m.endLine + 1} ${m.type} ${m.title} #${hash(JSON.stringify([m.attrs, m.section, m.text]))}`));
  }
  return out;
}

test('T7: selectors that worked before return the same matches, in the same order, with the same output', () => {
  const now = snapshot();
  if (process.env.SMD_WRITE_T7 === '1') fs.writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n');
  const pinned = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>;
  assert.deepEqual(Object.keys(now), Object.keys(pinned));
  // Documents added to the corpus after the pin (new syntax) are not part of it.
  const docOf = (row: string) => row.slice(0, row.indexOf(':'));
  const pinnedDocs = new Set(pinned['*'].map(docOf));
  for (const selector of LEGACY_SELECTORS) assert.deepEqual(now[selector].filter((row) => pinnedDocs.has(docOf(row))), pinned[selector], selector);
  // The pin is not empty: most selectors match something.
  assert.ok(Object.values(pinned).filter((rows) => rows.length).length >= 25);
});

// T1 to T4

const plan = [
  '---', 'smd: 2', 'title: Plan', '---',
  '## Rollout', '',
  '- [ ] Book the window',
  ':::decision{status=accepted} Ship on Tuesdays', 'Quiet day.', ':::',
  ':::risk{status=closed} Freeze', 'x', ':::',
  '### Canary', '',
  '- [ ] Pick hosts',
  ':::details More', '- [ ] Hidden step', ':::decision Nested call', 'y', ':::', ':::',
  ':::risk{status=open impact=high} Bad canary', 'z', ':::',
  '## Later', '',
  '- [ ] Retro',
  '::::tabs', ':::tab One', 'a', ':::', ':::tab Two', ':::note Inner', 'b', ':::', ':::', '::::',
  '',
].join('\n');

const pick = (selector: string) => querySmd(plan, selector, { today: TODAY }).map((m) => m.title);

test('T1: a space selects descendants, under headings and nested containers', () => {
  assert.deepEqual(pick('heading[title=Rollout] task'), ['Book the window', 'Pick hosts', 'Hidden step']);
  assert.deepEqual(pick('heading[id=canary] decision'), ['Nested call']);
  assert.deepEqual(pick('details task'), ['Hidden step']);
  assert.deepEqual(pick('heading[title=Rollout] heading[title=Canary] risk'), ['Bad canary']);
  assert.deepEqual(pick('tabs note'), ['Inner']);
  assert.deepEqual(pick('heading[title=Later] decision'), []);
  // `section` is still the nearest heading only.
  assert.deepEqual(pick('task[section=Rollout]'), ['Book the window']);
});

test('T2: > selects direct children only', () => {
  assert.deepEqual(pick('heading[level=2] > decision'), ['Ship on Tuesdays']);
  assert.deepEqual(pick('heading[level=3] > decision'), []);
  assert.deepEqual(pick('details > decision'), ['Nested call']);
  assert.deepEqual(pick('tabs > tab'), ['One', 'Two']);
  assert.deepEqual(pick('tabs > note'), []);
  assert.deepEqual(pick('tabs>tab>note'), ['Inner']);
  assert.deepEqual(pick('heading[title=Rollout] > heading'), ['Canary']);
});

test('T3: :not() excludes matches, and takes selector lists and combinators', () => {
  assert.deepEqual(pick('risk:not([status=closed])'), ['Bad canary']);
  assert.deepEqual(pick('task:not(details task)'), ['Book the window', 'Pick hosts', 'Retro']);
  assert.deepEqual(pick('decision:not([status=accepted]), risk:not([impact=high], [status=closed])'), ['Nested call']);
  assert.deepEqual(pick(':not(heading, task, tab, tabs)'), ['Ship on Tuesdays', 'Freeze', 'More', 'Nested call', 'Bad canary', 'Inner']);
  assert.deepEqual(pick('heading[title=Rollout] :not(heading, task)'), ['Ship on Tuesdays', 'Freeze', 'More', 'Nested call', 'Bad canary']);
});

test('T1 to T3: the parser reads combinators and :not, and keeps the released shape of plain selectors', () => {
  assert.deepEqual(parseSelector('risk[impact=high]'), [{ type: 'risk', tests: [{ key: 'impact', op: '=', values: ['high'] }] }]);
  assert.deepEqual(parseSelector('heading[level=2] > decision'), [{
    type: 'decision', tests: [], ancestor: { combinator: '>', selector: { type: 'heading', tests: [{ key: 'level', op: '=', values: ['2'] }] } },
  }]);
  assert.deepEqual(parseSelector('tabs tab, note')[0].ancestor, { combinator: ' ', selector: { type: 'tabs', tests: [] } });
  assert.deepEqual(parseSelector('risk:not([status=closed])'), [{
    type: 'risk', tests: [], not: [{ type: '*', tests: [{ key: 'status', op: '=', values: ['closed'] }] }],
  }]);
  const fails = (src: string, message: RegExp) => assert.throws(() => parseSelector(src), (e: Error) => e instanceof SelectorError && message.test(e.message), src);
  // Keys in :not() are checked against the type it is written on.
  fails('risk:not([stauts=closed])', /"risk" has no attribute "stauts"\. Did you mean "status"\?/);
  fails('risk:not()', /Empty ":not\(\)"/);
  fails('risk:not([status=closed]', /Missing "\)"/);
  fails('risk:first-child', /Only ":not\(…\)" is supported/);
  fails('decision >', /Missing a selector after ">"/);
  fails('decision)', /Unexpected "\)"/);
  fails('heading decison', /Unknown block type "decison"/);
});

test('T4: every match records its ancestors, outermost first; section keeps its meaning', () => {
  const [hidden] = querySmd(plan, 'task[title*=Hidden]', { today: TODAY });
  assert.deepEqual(hidden.ancestors, [
    { type: 'heading', line: 4, title: 'Rollout', id: 'rollout' },
    { type: 'heading', line: 13, title: 'Canary', id: 'canary' },
    { type: 'details', line: 16, title: 'More' },
  ]);
  assert.equal(hidden.section, 'Canary');
  const [inner] = querySmd(plan, 'note', { today: TODAY });
  assert.deepEqual(inner.ancestors.map((a) => a.type), ['heading', 'tabs', 'tab']);
  assert.deepEqual(querySmd(plan, 'heading[title=Rollout]', { today: TODAY })[0].ancestors, []);
});

test('S3: results are deterministic and in document order', () => {
  const selector = 'heading[title=Rollout] :not(heading), tabs > tab, risk';
  const a = querySmd(plan, selector, { today: TODAY });
  assert.deepEqual(a, querySmd(plan, selector, { today: TODAY }));
  assert.deepEqual(a.map((m) => m.line), [...a.map((m) => m.line)].sort((x, y) => x - y));
});
