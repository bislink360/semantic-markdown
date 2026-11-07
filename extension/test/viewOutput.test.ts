import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentView, outline, sectionCosts } from '../src/core/agentView';
import { readDocument } from '../src/readView';
import { DIGESTS, digest, viewCases } from './bench/viewCases';

// The digests were written by the view code before the budget path and include loading were made faster
// (docs/reports/performance.md), and rewritten for the research contract fixes (docs/rfcs/research-contract.smd, GAP-1 to GAP-5
// and GAP-7), for the C04 decision that section views show the dangers of other sections, and for G1 (a `:metric`
// keeps its trend and tone, `--max-tokens` never omits a section with a danger, and a view over its budget ends with
// an overflow line; each of the 131 changed cases was checked against the code before, one change at a time). Any change to a view's text, budget, provenance or outline shows up here.
test('views are byte-identical to the views before the performance changes', () => {
  const expected = JSON.parse(readFileSync(DIGESTS, 'utf8')) as Record<string, string>;
  const { cases, cleanup } = viewCases();
  try {
    assert.deepEqual(cases.map((c) => c.name).sort(), Object.keys(expected).sort());
    const changed = cases.filter((c) => digest(c.run({ agentView, outline, sectionCosts, readDocument })) !== expected[c.name]).map((c) => c.name);
    assert.deepEqual(changed, []);
  } finally {
    cleanup();
  }
});
