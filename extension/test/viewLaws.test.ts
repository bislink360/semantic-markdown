import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCases } from './conformance/oracle';
import { LAW_TESTS, LAWS, TEST_DIR, lawCoverage, lawGaps, matchingTitles, testTitles, type Law } from './viewLaws';

/**
 * The map from regression tests to the view laws (improvement roadmap t-77, test/viewLaws.ts). Every entry must name
 * one test that exists, so a renamed or deleted test shows up here. Each law should have regression tests and
 * conformance requests; a law that lacks one of them is printed as a gap, and a law that has neither fails.
 */

const laws = Object.keys(LAWS) as Law[];

test('view laws: the laws are L1 to L7 of docs/rfcs/view-laws.smd', () => {
  assert.deepEqual(laws, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
  assert.deepEqual(Object.keys(LAW_TESTS).sort(), [...laws].sort());
});

test('view laws: every mapped test exists in its file, and each entry names one test', () => {
  const problems: string[] = [];
  for (const law of laws) {
    const seen = new Set<string>();
    for (const entry of LAW_TESTS[law]) {
      if (!existsSync(join(TEST_DIR, entry.file))) {
        problems.push(`${law}: no file ${entry.file}`);
        continue;
      }
      const found = matchingTitles(entry);
      if (found.length !== 1) problems.push(`${law}: ${entry.file} has ${found.length} tests titled "${entry.test}"${found.length ? `: ${found.join(' | ')}` : ''}`);
      const key = `${entry.file}\n${found[0] ?? entry.test}`;
      if (seen.has(key)) problems.push(`${law}: ${entry.file} "${entry.test}" is listed twice`);
      seen.add(key);
    }
  }
  assert.deepEqual(problems, []);
});

test('view laws: the title reader finds quoted, escaped and template titles', () => {
  const titles = testTitles('taskViews.test.ts');
  assert.ok(titles.includes("AF23: the manifest records the author's policy and the agent's choices apart, with paths and what is unsatisfied"));
  assert.ok(testTitles('fuzz.test.ts').some((title) => title.startsWith('fuzz: ${RUNS} generated documents')));
});

test('view laws: the conformance requests name only the laws L1 to L7', () => {
  const unknown = loadCases().flatMap((c) => c.spec.requests.flatMap((r) => (r.laws ?? []).filter((l) => !laws.includes(l as Law)).map((l) => `${c.name} / ${r.name}: ${l}`)));
  assert.deepEqual(unknown, []);
});

test('view laws: every law has a regression test or a conformance request, and gaps are reported', () => {
  const coverage = lawCoverage(loadCases());
  console.log(`law  tests  requests\n${coverage.map((c) => `${c.law}   ${String(c.tests).padStart(5)}  ${String(c.requests).padStart(8)}`).join('\n')}`);
  const gaps = lawGaps(coverage);
  if (gaps.length) console.log(`View-law gaps:\n${gaps.map((g) => `- ${g}`).join('\n')}`);
  const uncovered = coverage.filter((c) => !c.tests && !c.requests).map((c) => c.law);
  assert.deepEqual(uncovered, [], 'a law with neither a regression test nor a conformance request is checked by nothing');
});
