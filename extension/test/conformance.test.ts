import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { cliBuilt, loadCases, runRequest, type Driver, type LoadedCase, type RequestResult } from './conformance/oracle';

/**
 * The read-contract conformance suite (improvement roadmap t-64): every request of every case under
 * test/conformance/cases, judged by the oracle against expectations written by hand from the view laws. Each check
 * must pass, except the ones marked as an expected failure, which must still fail: when the task named in the marker
 * lands, its test fails here until the marker is removed, so a fix never goes unnoticed. `npm run conformance` prints
 * recall and precision per request.
 *
 * The library driver (agentView with the options and file reader of `smd agent`) runs without a build. The CLI driver
 * spawns dist/cli.js with --provenance and is skipped until `npm run build` has run.
 */

const cases = loadCases();

function judge(r: RequestResult): void {
  const failed = r.checks.filter((c) => !c.ok && !c.expectedFailure);
  const landed = r.checks.filter((c) => c.ok && c.expectedFailure);
  const lines = [
    ...failed.map((c) => `${c.name}: ${c.detail}`),
    ...landed.map((c) => `${c.name} passes although it is marked as an expected failure (${c.expectedFailure!.task}: ${c.expectedFailure!.note}). Remove the marker.`),
  ];
  assert.equal(lines.length, 0, `${r.caseName} / ${r.request}\n${lines.join('\n')}`);
}

function suite(driver: Driver, run: boolean): void {
  for (const c of cases as LoadedCase[]) {
    describe(`conformance (${driver}): ${c.name}`, () => {
      for (const request of c.spec.requests) {
        test(request.name, { skip: run ? false : 'run npm run build first' }, () => judge(runRequest(c, request, driver)));
      }
      if (driver === 'library') for (const t of c.spec.todos ?? []) test(`${t.task}: ${t.note}`, { todo: true });
    });
  }
}

suite('library', true);
suite('cli', cliBuilt());

test('conformance: every case has requests and the suite covers the views the laws name', () => {
  assert.ok(cases.length >= 12);
  const routes = cases.flatMap((c) => c.spec.requests.map((r) => r.route));
  assert.ok(routes.some((r) => !r.sections && !r.brief && r.maxTokens === undefined), 'a full view');
  assert.ok(routes.some((r) => r.brief), 'a brief view');
  assert.ok(routes.some((r) => r.sections?.length), 'a section view');
  assert.ok(routes.some((r) => r.maxTokens !== undefined), 'a budgeted view');
  const kinds = new Set(cases.flatMap((c) => c.spec.requests.flatMap((r) => (r.unsatisfied ?? []).flatMap((u) => (Array.isArray(u.kind) ? u.kind : [u.kind])))));
  for (const kind of ['missing', 'ambiguous', 'hidden', 'denied', 'cycle', 'depth', 'limit', 'include', 'unresolved-target']) assert.ok(kinds.has(kind), `an unsatisfied ${kind}`);
});
