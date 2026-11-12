/**
 * `npm run conformance [-- --cli] [--verbose] [--case <part of a case name>]`: runs every conformance case and prints, per request, recall over
 * the blocks the laws require, precision over the typed blocks that appear, the extra context apart, and the checks
 * that failed, then the same requests by law with the regression tests mapped to each law (test/viewLaws.ts). Exit code 1 when a check fails that is not an expected failure, or when an expected failure passes
 * (its task has landed, so the marker must go).
 */
import { lawCoverage, lawGaps } from '../viewLaws';
import { cliBuilt, loadCases, runAll, type Driver, type RequestResult } from './oracle';

const argv = process.argv.slice(2);
const driver: Driver = argv.includes('--cli') ? 'cli' : 'library';
const verbose = argv.includes('--verbose');
if (driver === 'cli' && !cliBuilt()) {
  console.error('dist/cli.js is missing: run npm run build first, or drop --cli to use the library driver.');
  process.exit(2);
}

const only = argv.indexOf('--case') >= 0 ? argv[argv.indexOf('--case') + 1] : undefined;
const cases = loadCases().filter((c) => !only || c.name.includes(only));
const results = runAll(driver, cases);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);

function row(r: RequestResult): string {
  const failing = r.checks.filter((c) => !c.ok && !c.expectedFailure).map((c) => c.name);
  const xfail = r.checks.filter((c) => !c.ok && c.expectedFailure).map((c) => `${c.name} (${c.expectedFailure!.task})`);
  const xpass = r.checks.filter((c) => c.ok && c.expectedFailure).map((c) => `${c.name} (${c.expectedFailure!.task} landed?)`);
  const notes = [...failing.map((n) => `FAIL ${n}`), ...xpass.map((n) => `XPASS ${n}`), ...xfail.map((n) => `xfail ${n}`)].join('; ');
  return `${r.status.padEnd(5)} ${pct(r.recall)} ${`${r.appeared}/${r.required}`.padStart(6)} ${pct(r.precision)} ${String(r.extra.length).padStart(5)}  ${r.request}${notes ? `\n${' '.repeat(33)}${notes}` : ''}`;
}

console.log(`Conformance oracle (t-64), driver: ${driver}\n`);
console.log(`${'status'.padEnd(5)} recall  req   prec. extra  request`);
for (const c of cases) {
  console.log(`\n${c.name}`);
  for (const r of results.filter((x) => x.caseName === c.name)) {
    console.log(row(r));
    if (verbose) {
      for (const ch of r.checks) console.log(`${' '.repeat(33)}${ch.ok ? 'ok ' : 'no '} ${ch.name}: ${ch.detail}`);
      if (r.extra.length) console.log(`${' '.repeat(33)}extra: ${r.extra.join(', ')}`);
    }
  }
  for (const t of c.spec.todos ?? []) console.log(`todo  (${t.task}) ${t.note}`);
}

const required = results.reduce((s, r) => s + r.required, 0);
const appeared = results.reduce((s, r) => s + r.appeared, 0);
const count = (s: string) => results.filter((r) => r.status === s).length;
console.log(`\n${results.length} requests: ${count('pass')} pass, ${count('xfail')} expected failure, ${count('fail')} fail, ${count('xpass')} unexpected pass.`);
console.log(`Required blocks: ${appeared}/${required} appear (recall ${pct(required ? appeared / required : 1).trim()}).`);
const byTask = new Map<string, number>();
for (const r of results) for (const ch of r.checks) if (ch.expectedFailure && !ch.ok) byTask.set(ch.expectedFailure.task, (byTask.get(ch.expectedFailure.task) ?? 0) + 1);
if (byTask.size) console.log(`Expected failures by task: ${[...byTask].map(([t, n]) => `${t} ×${n}`).join(', ')}.`);

// By law (t-77): the requests that list each law, how they fared, recall over them, and the regression tests mapped
// to the law in test/viewLaws.ts.
const lawsOf = new Map(cases.flatMap((c) => c.spec.requests.map((r) => [`${c.name}\n${r.name}`, r.laws ?? []] as const)));
const coverage = lawCoverage(cases);
console.log(`\nBy law\n${'law'.padEnd(4)} ${'req'.padStart(4)} ${'pass'.padStart(5)} ${'xfail'.padStart(5)} ${'fail'.padStart(5)} recall ${'tests'.padStart(5)}  law`);
for (const c of coverage) {
  const mine = results.filter((r) => (lawsOf.get(`${r.caseName}\n${r.request}`) ?? []).includes(c.law));
  const n = (s: string) => mine.filter((r) => r.status === s).length;
  const req = mine.reduce((s, r) => s + r.required, 0);
  const app = mine.reduce((s, r) => s + r.appeared, 0);
  const recall = mine.length ? pct(req ? app / req : 1) : '    -';
  console.log(`${c.law.padEnd(4)} ${String(mine.length).padStart(4)} ${String(n('pass')).padStart(5)} ${String(n('xfail')).padStart(5)} ${String(n('fail') + n('xpass')).padStart(5)}  ${recall} ${String(c.tests).padStart(5)}  ${c.title.split(':')[0]}`);
}
const gaps = lawGaps(coverage);
console.log(gaps.length ? `Gaps:\n${gaps.map((g) => `- ${g}`).join('\n')}` : 'Gaps: none, every law has regression tests and conformance requests.');
process.exit(count('fail') || count('xpass') ? 1 : 0);
