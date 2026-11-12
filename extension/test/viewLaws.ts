import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The map from regression tests to the view laws (improvement roadmap t-77). The laws are L1 to L7 of
 * docs/rfcs/view-laws.smd. Each entry names a test in a file under extension/test by its exact title, or by a prefix
 * that matches one title only, and was chosen by reading the test: it is listed under a law only when its assertions
 * decide that law, not when the law's subject merely shows up in its fixture. A test can check more than one law.
 *
 * viewLaws.test.ts checks that every entry names a test that exists, and reports a law without a regression test or a
 * conformance request as a gap. `npm run conformance` prints the counts by law after the table by case.
 */

export type Law = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7';

export const LAWS: Record<Law, string> = {
  L1: 'Preservation: agent blocks, non-goals and dangers appear in every content-bearing view',
  L2: 'Scoped applicability: every constraint that applies to the request appears',
  L3: 'Bounded closure with a typed frontier: depends-on closure within 5 hops and 50 blocks, the rest listed by kind',
  L4: 'Status fidelity: typed blocks carry their literal status, defaults written out, computed superseded-by',
  L5: 'Overflow: a budget never removes required content, and overflow is reported in text, manifest and stderr',
  L6: 'Omission accounting: the manifest has hashes, settings, selection, source map and omissions with reasons',
  L7: 'Determinism: equal inputs give the same view bytes and the same manifest',
};

export interface LawTest {
  /** A file under extension/test. */
  file: string;
  /** The test's title as written, or a prefix of it that no other title in the file shares. */
  test: string;
}

const t = (file: string, test: string): LawTest => ({ file, test });

const CV = 'constraintViews.test.ts';
const IR = 'implementationReview.test.ts';
const RC = 'researchContract.test.ts';
const PV = 'provenance.test.ts';
const TV = 'taskViews.test.ts';
const RF = 'readFollow.test.ts';
const II = 'includedIds.test.ts';
const GR = 'graph.test.ts';
const P1 = 'semanticTagsPhase1.test.ts';
const P2 = 'semanticTagsPhase2.test.ts';
const P3 = 'semanticTagsPhase3.test.ts';

export const LAW_TESTS: Record<Law, LawTest[]> = {
  L1: [
    t(IR, 'C01: a nested :::agent block is kept in full, brief and budgeted views, once'),
    t(IR, 'C01: a nested :::agent block outside the requested sections is still included'),
    t(IR, 'C01: :::details inside :::agent is part of the instructions, not condensed'),
    t(IR, 'C01: :::human blocks still drop the :::agent blocks in them by default'),
    t('features.test.ts', 'section selection keeps document-wide agent instructions'),
    t('budget.test.ts', 'the header, intro, agent instructions and requested sections are never omitted'),
    t(CV, 'D6: the head blocks come in order'),
    t(PV, 'C04: the constraints pass is off by default; only the dangers of other sections are shown'),
    t(RC, 'GAP-1 (AF15): :::agent from an include is kept in a section view of another section'),
    t(RC, 'GAP-3 (AF01, AF15): --brief does not hide a danger inside :::details without a pointer to it'),
    t(RC, 'GAP-4 (AF16), then the accepted "mandatory content" decision: a section holding a danger is never omitted'),
    t(RC, 'GAP-5 (AF15): --max-tokens never omits a section whose :::agent block comes from an include'),
    t(RC, 'GAP-1: rules from an include inside an include, or inside a condensed :::details, are kept'),
    t(RC, 'GAP-1: an include inside :::human gives no rules, as a :::agent block there gives none'),
    t(RC, 'GAP-3: a CAUTION alert inside :::details is kept in brief views, and other callouts are still condensed'),
    t(RC, 'C04: a section view shows the dangers of other sections and included files in full, once each'),
    t(RC, 'audience exclusion: a :::agent block under an {agent=skip} heading stays out of every section view'),
    t(RC, 'C04: the dangers survive a budget and brief section views, and MCP-style reads with sections'),
    t(RC, 'G1 (AF15): a section holding a danger from an included file, or a CAUTION alert, is never omitted'),
    t(RC, 'G1 (AF15): a parent section is kept when a subsection holds a danger, and its other subsections can go'),
    t(P3, 'R57: a section view that leaves out the non-goals still shows them, as it shows :::agent blocks'),
    t(P3, 'R57: a budget never omits the section that holds non-goals'),
  ],
  L2: [
    t(CV, 'R25: a scope=document constraint is in every section view, in full and with its line'),
    t(CV, 'R25: a scope=document constraint in an included file applies to the including document'),
    t(CV, 'R26/AC7: a section constraint applies to its section and subsections, also from an include, and not elsewhere'),
    t(CV, 'R27/AC8: applies-to brings a constraint into views that show its target block or part of its target section'),
    t(CV, 'R26: a scope=section constraint above the first heading applies to every view'),
    t(CV, 'AF13: constraints in {agent=skip} sections and :::human blocks never appear'),
    t(CV, 'R25: --brief keeps applying constraints whole'),
    t(CV, 'R25: MCP-style reads with sections show the applying constraints'),
    t(CV, 'AF15: an applying constraint brings its own dependencies, and a constraint whose applies-to names a dependency applies'),
    t(CV, 't-58, R18 hidden-target probe'),
    t(CV, 'AC-C: conflicting constraints both stay visible and unresolved'),
    t(CV, 'AF15: a rule on a dependency that another rule added applies too, however long the chain'),
    t(CV, 'R19/AF15: a dependency read from another document brings the rules that name it, from that document and this one'),
    t(CV, 'R19: a section that reads nothing from the other document carries none of its rules'),
    t(CV, 'AF15 (2026-11-10): a dependency brings the section rules of the section it sits in, and rules on a heading above it'),
    t(CV, 'AF13/AF15 (2026-11-10): a dependency hidden from agents brings no rule of its section and leaves the view incomplete'),
    t(CV, "R19/AF15 (2026-11-10): a dependency from another document brings its section rules and that document's document-wide rules"),
    t(CV, 'NV-06: a constraint whose applies-to names nothing is shown in every section read and makes it incomplete'),
    t(CV, 'NV-06: a target in another document that cannot be read is unresolved, and a resolved one is not'),
    t(II, 't-59: a rule whose applies-to names an included block is carried by a read that shows the block, from another section'),
    t(II, 't-59: validation stops reporting ref/unknown for an included target, and still reports it when the include cannot be read'),
    t(II, 't-59: a section include gives only the ids of its section'),
    t(TV, 'AF15: mandatory blocks come with their dependency closure, and stay whole when the view is condensed'),
  ],
  L3: [
    t(CV, 'AF15: a section view adds the dependency closure of what it shows, with line refs'),
    t(CV, 'AF15/AF20: a cycle and a missing target are reported as unsatisfied and mark the view incomplete'),
    t(CV, 'AF15: a dependency the view already shows is not repeated, and a whole view only reports what is unsatisfied'),
    t(CV, 'AF15: an applying constraint brings its own dependencies, and a constraint whose applies-to names a dependency applies'),
    t(CV, 'AF15: a dependency in an {agent=skip} section is not shown and is unsatisfied'),
    t(CV, 't-58, R18 hidden-target probe'),
    t(CV, 'AF15: dependencies survive brief condensation'),
    t(CV, 'AC-C (AF17): an include the host denies grants nothing: its text is not shown and the view is incomplete'),
    t(CV, 'AF15: a rule on a dependency that another rule added applies too, however long the chain'),
    t(CV, 'AF15/AF20: a chain past the block limit is cut there, reported, and makes the view incomplete'),
    t(CV, 'R19/AF15: a dependency read from another document brings the rules that name it, from that document and this one'),
    t(CV, 'AF13/AF15 (2026-11-10): a dependency hidden from agents brings no rule of its section and leaves the view incomplete'),
    t(CV, 'NV-06: a constraint whose applies-to names nothing is shown in every section read and makes it incomplete'),
    t(CV, 'NV-06: a whole view reports an unresolved target, and a budget never omits the section that holds the rule'),
    t(CV, 't-63: a cycle and a missing target fail resolution only, and complete stays the three parts together'),
    t(CV, 't-63: a dependency hidden from agents or cut at the block limit fails coverage only'),
    t(CV, 't-63: an unresolved rule target is called a rule target, not a mandatory dependency, and an unread include an include'),
    t(II, 't-59: an id the document and an included file both give is ambiguous, in the read and in validation'),
    t(II, 't-59: a depends-on that names an included block resolves too, so the read adds it from another section'),
    t(II, 't-59: a section include gives only the ids of its section'),
    t(GR, 'AC-D: optional links are pointers, mandatory edges expand to their closure, with cycles, depth cuts and unavailable targets reported'),
    t(GR, 'G5: a file outside the documents given is read through the host, and a denied one never shows its content'),
    t(GR, 'the closure depth limit counts the fewest steps, so a long path walked first does not cut a near dependency'),
    t(RF, 'G4, G5: mandatory edges come in full once, and what cannot be satisfied makes the result incomplete'),
    t(RF, 'R19, G5: a section read and its followed edges agree on a dependency in another file, and complete says what the view says'),
    t(RF, 'R19: the view reads a dependency from the documents given and through readDocument, with or without follow'),
    t(TV, 'AF15: mandatory blocks come with their dependency closure, and stay whole when the view is condensed'),
    t(TV, 'AF15: a mandatory id that names nothing is unsatisfied, reported in the view, and the view is incomplete'),
  ],
  L4: [
    t(P1, 'AC20 (R4): each tag is a tag in the agent view, with the defaults that change meaning'),
    t(P2, 'R53: a view that shows a superseded decision adds superseded-by, and decisions without links read as before'),
    t(P2, "R19, R53: with the document's path, every view counts supersedes=this.smd#D3 like supersedes=D3"),
    t(P2, "GAP-8 (AF07, AF11): the agent view shows a question's id and state, answered only when an answer exists"),
    t(RC, 'AF01: cues keep their role as a tag or as text in the full view'),
  ],
  L5: [
    t(IR, 'C01: an instruction over the budget is kept and the result says it does not fit'),
    t('budget.test.ts', 'omitted sections leave a pointer saying how to read them'),
    t('budget.test.ts', 'CLI: smd agent --max-tokens and --tokenizer'),
    t(RC, 'AF16: read routes on its budget and never truncates'),
    t(RC, 'AF16: agent --max-tokens omits sections with pointers and reports, rather than drops, mandatory overflow'),
    t(RC, 'GAP-4 (AF16), then the accepted "mandatory content" decision: a section holding a danger is never omitted'),
    t(RC, 'C04: the dangers survive a budget and brief section views, and MCP-style reads with sections'),
    t(RC, 'G1 (AF16): a view over its budget ends with one overflow line, counted in its own tokens'),
    t(RC, 'G1 (AF16): a view that fits, and a view with no budget, have no overflow line'),
    t(RC, 'G1 (AF16): with a tokenizer the overflow line counts in its tokens, without the estimate sign'),
    t(RC, 'G1 (AF15): a section holding a danger from an included file, or a CAUTION alert, is never omitted'),
    t(CV, 'AC6 (R25, R29): a scope=document constraint in section 1 stays in full when the budget cannot hold it and section 4'),
    t(CV, 'R29: under a budget a section with an applying constraint stays, and a section constraint goes with its section'),
    t(CV, 'AF15: under a budget the section of a dependency of kept content stays'),
    t(CV, 'AC-C (AF13-AF17): a nested section keeps an included scoped constraint and its qualifications under a budget below them'),
    t(CV, 'NV-06: a whole view reports an unresolved target, and a budget never omits the section that holds the rule'),
    t(CV, 't-63: required content over the budget fails the budget part, and complete with it'),
    t(TV, 'AF16: a budget below the mandatory content reports the overflow and drops none of it'),
    t(TV, 'AC-C: a nested section that depends on a constraint from an include keeps it under a budget below the required bodies'),
    t(P3, 'R57: a budget never omits the section that holds non-goals'),
  ],
  L6: [
    t(PV, 'C05: sha256Hex is SHA-256 of the UTF-8 bytes, and the revision is the MCP one'),
    t(PV, 'C05: provenance never changes the text, on every sample and setting'),
    t(PV, 'C05: the source map covers the view and maps lines back to the document'),
    t(PV, 'C05: every omission has a kind, lines and a reason, and hidden text is not exposed'),
    t(PV, 'C05: brief, budget and selection omissions are listed with reasons'),
    t(PV, 'C05: nested includes map to the right file, and their hashes are listed'),
    t(PV, 'C05: readDocument returns the manifest of what it showed, the outline included'),
    t(PV, 'C04: works with a budget and through readDocument, and the manifest records the policy'),
    t(PV, 't-60: a section read that leaves out text above the first heading records it, with a reason and a recovery command'),
    t(PV, 't-60: a preamble of only front matter, blank lines, comments or carried blocks records nothing'),
    t(PV, 't-61: an omitted range that holds a carried block says which lines were carried and where they appear'),
    t(PV, 't-61: lines an include in the omitted range brings are named by their file'),
    t(IR, 'C05: --provenance writes a smd-projection/1 manifest and leaves stdout unchanged'),
    t(CV, 'AF17: provenance leaves the text unchanged and maps the applying constraints to their files and lines'),
    t(CV, 'AF15/AF20: a cycle and a missing target are reported as unsatisfied and mark the view incomplete'),
    t(CV, 't-63: an unresolved rule target is called a rule target, not a mandatory dependency, and an unread include an include'),
    t(RC, 'GAP-2: provenance records the skipped section of an included file'),
    t(RC, 'C04: provenance leaves the text unchanged and maps the head dangers to their lines'),
    t(RF, 'provenance: the manifest records what follow added, maps its lines, and lists what is unsatisfied'),
    t(TV, "AF23: the manifest records the author's policy and the agent's choices apart, with paths and what is unsatisfied"),
  ],
  L7: [
    t('viewOutput.test.ts', 'views are byte-identical to the views before the performance changes'),
    t(PV, 'C05: manifests are stable, and a changed file has a new revision'),
    t(GR, 'mandatoryClosure is reusable on its own, and the same source gives the same result (S3)'),
  ],
};

export const TEST_DIR = __dirname;

/** The titles of the `test(…)` calls in a test file, with string escapes undone. Template literals count too. */
export function testTitles(file: string, dir = TEST_DIR): string[] {
  const text = readFileSync(join(dir, file), 'utf8');
  const titles: string[] = [];
  for (const m of text.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) titles.push(m[2].replace(/\\(.)/g, '$1'));
  return titles;
}

/** The titles in its file that an entry names: its exact title, else every title it is a prefix of. */
export function matchingTitles(entry: LawTest, dir = TEST_DIR): string[] {
  const titles = testTitles(entry.file, dir);
  return titles.includes(entry.test) ? [entry.test] : titles.filter((title) => title.startsWith(entry.test));
}

/** The conformance requests as viewLaws needs them: the laws each request lists. */
export interface LawRequests {
  spec: { requests: Array<{ laws?: string[] }> };
}

export interface LawCoverage {
  law: Law;
  title: string;
  /** Mapped regression tests. */
  tests: number;
  /** Conformance requests that list the law. */
  requests: number;
}

/** The number of regression tests and conformance requests per law. A law with neither is a gap. */
export function lawCoverage(cases: LawRequests[]): LawCoverage[] {
  return (Object.keys(LAWS) as Law[]).map((law) => ({
    law,
    title: LAWS[law],
    tests: LAW_TESTS[law].length,
    requests: cases.reduce((n, c) => n + c.spec.requests.filter((r) => (r.laws ?? []).includes(law)).length, 0),
  }));
}

/** One line per law that has no regression test, no conformance request, or neither. */
export function lawGaps(coverage: LawCoverage[]): string[] {
  return coverage.flatMap((c) => {
    if (!c.tests && !c.requests) return [`${c.law} has no regression test and no conformance request: nothing checks it`];
    if (!c.tests) return [`${c.law} has no regression test (conformance requests only: ${c.requests})`];
    if (!c.requests) return [`${c.law} has no conformance request (regression tests only: ${c.tests})`];
    return [];
  });
}
