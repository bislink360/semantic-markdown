import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edited, profileDocument, stats } from './bench/profile';

const settings = { runs: 2, warmup: 0, today: '2026-11-01' };
const sample = join(__dirname, 'samples', 'status-report-2026-09.smd');

const isCount = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;

test('profileDocument measures every call with counts, latency and memory', () => {
  const profile = profileDocument({ name: 'status report', text: readFileSync(sample, 'utf8'), dir: join(__dirname, 'samples') }, settings);
  assert.equal(profile.name, 'status report');
  assert.ok(profile.lines > 0 && profile.tokens > 0 && profile.agentTokens > 0);
  assert.ok(['full', 'outline'].includes(profile.autoShows));
  assert.ok(profile.sectionQuery);
  const names = profile.calls.map((c) => c.name);
  for (const name of ['readDocument full', 'readDocument outline', 'agentView', 'agentView brief', 'outline', 'sectionCosts']) assert.ok(names.includes(name), name);
  for (const call of profile.calls) {
    for (const counts of [call.cold, call.warm]) {
      for (const value of [counts.parseCalls, counts.cacheHits, counts.fullParses, counts.incrementalParses, counts.linesParsed, counts.figurePasses, counts.reads, counts.distinctReads]) {
        assert.ok(isCount(value), `${call.name}: ${JSON.stringify(counts)}`);
      }
    }
    assert.ok(call.cold.parseCalls > 0, call.name);
    // A cold run parses the document once from scratch; the parse cache answers the rest.
    assert.equal(call.cold.fullParses, 1, call.name);
    for (const l of [call.latency.cold, call.latency.warm]) {
      assert.ok(l.min >= 0 && l.min <= l.p50 && l.p50 <= l.p95 && l.p95 <= l.max, `${call.name}: ${JSON.stringify(l)}`);
    }
    assert.equal(typeof call.memory.peakHeapGrowth, 'number');
  }
});

test('profileDocument counts include reads and distinct paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smd-profile-test-'));
  try {
    writeFileSync(join(dir, 'b.smd'), '## B\n\nInner text.\n');
    writeFileSync(join(dir, 'a.smd'), '## A\n\nText.\n\n:::include{file="b.smd"}\n:::\n');
    const text = '# Root\n\n## Intro\n\nHello.\n\n:::include{file="a.smd"}\n:::\n';
    const profile = profileDocument({ name: 'includes', text, dir }, settings, ['agentView']);
    const [view] = profile.calls;
    assert.equal(view.cold.distinctReads, 2);
    assert.ok(view.cold.reads >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stats and edited', () => {
  assert.deepEqual(stats([4, 1, 3, 2]), { p50: 2, p95: 4, min: 1, max: 4, mean: 2.5 });
  assert.notEqual(edited('# T\n\nText here.\n', 1), edited('# T\n\nText here.\n', 2));
});
