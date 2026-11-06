import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentView, outline, sectionCosts } from '../src/core/agentView';
import { readDocument } from '../src/readView';
import { DIGESTS, digest, viewCases } from './bench/viewCases';

// The digests were written by the view code before the budget path and include loading were made faster
// (docs/PERFORMANCE.md). Any change to a view's text, budget, provenance or outline shows up here.
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
