// Tree selectors (docs/requirements/tree-and-graph-filtering.smd, T1 to T4 and T7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { querySmd } from '../src/core';

// ---------------------------------------------------------------------------
// T7: selectors that worked before tree selectors keep their matches, order and output
// ---------------------------------------------------------------------------

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
  for (const selector of LEGACY_SELECTORS) assert.deepEqual(now[selector], pinned[selector], selector);
  // The pin is not empty: most selectors match something.
  assert.ok(Object.values(pinned).filter((rows) => rows.length).length >= 25);
});
