import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { agentView, estimateTokens, type AgentViewOptions, type Tokenizer } from '../src/core';
import { readerFor } from '../src/workspace';

/**
 * The focused fixtures (improvement roadmap t-02). The snapshots (scripts/snapshots.mjs) pin what the CLI writes for
 * them; these tests pin what the snapshots cannot say: that every budget boundary in requests.json is where the view
 * really changes, and that a tokenizer counts the view the budget returns exactly, also when joining the pieces
 * changes the count (the fixture t-27 keeps when it cuts the repeated scans).
 */

const FIXTURES = join(__dirname, 'snapshots', 'fixtures');
const BUDGET_FILE = 'extension/test/snapshots/fixtures/token-budget.smd';
const budgetDoc = fs.readFileSync(join(FIXTURES, 'token-budget.smd'), 'utf8');

/** As `smd agent <file> --today …` builds the view, so the counts are the ones the CLI prints. */
const view = (options: Partial<AgentViewOptions> = {}) => agentView(budgetDoc, {
  includes: true, lineRefs: true, readFile: readerFor(join(FIXTURES, 'token-budget.smd')), file: BUDGET_FILE, today: '2026-01-15', ...options,
});

interface Request { file: string; name: string; argv: string[] }
const requests = (JSON.parse(fs.readFileSync(join(FIXTURES, 'requests.json'), 'utf8')) as { requests: Request[] }).requests;
const budgetOf = (r: Request) => Number(r.argv[r.argv.indexOf('--max-tokens') + 1]);

test('t-02: each "fits exactly" budget in requests.json is the size of the view it returns, and one token less changes the view', () => {
  const exact = requests.filter((r) => r.file === 'token-budget.smd' && / exactly$/.test(r.name));
  assert.equal(exact.length, 7, 'the full view, the brief view, four omissions and the smallest view');
  for (const r of exact) {
    const n = budgetOf(r);
    const at = view({ maxTokens: n });
    assert.deepEqual([at.budget?.tokens, at.budget?.fits], [n, true], `${r.name}: the view is ${at.budget?.tokens} tokens`);
    assert.equal(at.budget?.tokens, estimateTokens(at.text), `${r.name}: the count is the estimate of the text returned`);
    const under = view({ maxTokens: n - 1 });
    assert.notEqual(under.text, at.text, `${r.name}: one token less chooses another view`);
    const pair = requests.find((q) => q.file === r.file && budgetOf(q) === n - 1);
    assert.ok(pair, `${r.name}: requests.json also reads it at ${n - 1}`);
  }
});

test('t-02: the budget boundaries in requests.json are every place the view changes', () => {
  const budgets = new Set(requests.filter((r) => r.file === 'token-budget.smd' && r.argv.includes('--max-tokens') && !r.argv.includes('--section') && r.argv[0] === 'agent').map(budgetOf));
  const full = view().text;
  let previous = full;
  const changes: number[] = [];
  // Down to the first budget nothing fits: from there the view's last line names the budget, so it changes with it.
  for (let n = estimateTokens(full) + 20; n > 0; n--) {
    const r = view({ maxTokens: n });
    if (r.text !== previous) changes.push(n);
    previous = r.text;
    if (!r.budget?.fits) break;
  }
  for (const n of changes) assert.ok(budgets.has(n) && budgets.has(n + 1), `the view changes between ${n + 1} and ${n}; requests.json reads both`);
});

/**
 * Words, plus one for every blank line: joining two pieces with a blank line costs a token that neither piece has, so
 * the sum of the pieces' counts is never the count of the view.
 */
const joins: Tokenizer = { name: 'joins', count: (text) => text.split(/\s+/).filter(Boolean).length + (text.match(/\n[ \t]*\n/g)?.length ?? 0) };

test('t-02: with a tokenizer whose count changes when pieces are joined, every budget gets the exact count of the view it returns', () => {
  const full = view({ tokenizer: joins });
  const parts = full.text.split(/\n[ \t]*\n/);
  assert.ok(parts.reduce((sum, p) => sum + joins.count(p), 0) < joins.count(full.text), 'the joins add tokens');
  const seen = new Map<string, number>();
  let overBudget: number | undefined;
  for (let n = joins.count(full.text); n >= 1; n--) {
    const r = view({ tokenizer: joins, maxTokens: n });
    assert.equal(r.budget?.tokens, joins.count(r.text), `budget ${n}: the reported size is the count of the text`);
    if (r.budget?.fits) {
      assert.ok(r.budget.tokens <= n, `budget ${n}: a view that fits is within it`);
      // A count that misses the joins keeps too much, goes over and leaves budgets below fitting again.
      assert.equal(overBudget, undefined, `budget ${n} fits, but the larger budget ${overBudget} did not`);
    } else {
      overBudget ??= n;
    }
    if (!seen.has(r.text)) seen.set(r.text, n);
  }
  assert.ok(overBudget !== undefined && overBudget < joins.count(full.text) / 2, 'only budgets below the smallest view do not fit');
  assert.ok(seen.size >= 5, 'the budget chooses between several views');
  for (const [text, largest] of seen) {
    const tokens = joins.count(text);
    if (tokens > largest) continue; // the smallest view, over every budget that chose it
    assert.equal(view({ tokenizer: joins, maxTokens: tokens }).text, text, `a budget of exactly ${tokens} returns the view of that size`);
    assert.notEqual(view({ tokenizer: joins, maxTokens: tokens - 1 }).text, text, `a budget of ${tokens - 1} does not`);
  }
});
