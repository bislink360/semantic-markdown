import {
  constraintNote, EdgeTypeError, edgeTypes, formatQueryResult, parseSelector, queryDocuments, queryResultJson, queryResultSummary, queryView,
  SelectorError, type Provenance, type QueryDocumentsResult, type QueryViewResult, type Selector,
} from './core';
import { completenessOf, incompleteLine } from './core/applicability';
import { queryViewBlock } from './core/queryView';
import { collect, graphReader, querySummary, read, readerFor } from './workspace';

/** `smd query`'s options. `follow`, `direction` and `depth` are as written on the command line. */
export interface QueryFlags extends FollowFlags {
  json: boolean;
  titles: boolean;
  brief: boolean;
  lineRefs: boolean;
  today?: string;
  constraints?: boolean;
  /** Each document's matches as a section read carries them (see queryView). */
  contract?: boolean;
  /** With `contract`: also return each view's provenance manifest. */
  provenance?: boolean;
  /** With `contract`: what the views do with the agent blocks of included files (4.1.0). */
  includedInstructions?: 'carry' | 'off';
}

export interface QueryOutput {
  code: number;
  stdout: string;
  stderr: string;
  /** With `contract` and `provenance`: one manifest per document with matches, in file order. */
  manifests?: Provenance[];
}

const USAGE = 'Usage: smd query "<selector>" <files|dirs...>, e.g. smd query "decision[status=accepted]" docs/';

/**
 * `smd query`. Without --constraints or --follow, stdout is the released output, plus one line per document that has
 * agent blocks or document-wide constraints the result leaves out (on stderr with --json, which keeps its shape).
 */
export function runQuery(selector: string | undefined, targets: string[], flags: QueryFlags): QueryOutput {
  const fail = (message: string): QueryOutput => ({ code: 2, stdout: '', stderr: `${message}\n` });
  if (!selector) return fail(USAGE);
  let selectors: Selector[];
  try {
    selectors = parseSelector(selector);
  } catch (e) {
    if (e instanceof SelectorError) return fail(e.message);
    throw e;
  }
  const graph = followOptions(flags);
  if ('error' in graph) return fail(graph.error);
  const { direction, depth } = graph;
  if (flags.contract && (flags.follow !== undefined || flags.titles)) {
    return fail(`--contract carries each match's mandatory dependencies, constraints, agent instructions and dangers itself, so ${flags.titles ? '--titles' : '--follow'} does not go with it.`);
  }

  const roots = targets.length ? targets : ['.'];
  const files = roots.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
  if (flags.contract) return contractQuery(selector, files, flags);
  const result = queryDocuments(files.map((f) => ({ path: f, text: read(f) })), selectors, {
    brief: flags.brief, lineRefs: flags.lineRefs, today: flags.today, constraints: flags.constraints,
    ...(flags.follow !== undefined ? { follow: flags.follow, direction, depth, readDocument: graphReader(roots) } : {}),
  });
  const extended = !!flags.constraints || flags.follow !== undefined;
  const code = result.matches.length ? 0 : 1;
  if (!extended) {
    const summary = `[smd] ${querySummary(result.matches, files.length)}\n`;
    if (!flags.json) return { code, stdout: formatQueryResult(result, { titles: flags.titles }), stderr: summary };
    const rows = result.matches.map(({ ancestors: _, ...m }) => m);
    return { code, stdout: JSON.stringify(rows, null, 2) + '\n', stderr: notes(result) + summary };
  }
  const stdout = flags.json ? JSON.stringify(queryResultJson(result), null, 2) + '\n' : formatQueryResult(result, { titles: flags.titles });
  return { code, stdout, stderr: `[smd] ${queryResultSummary(result, files.length)}\n` };
}

/** `--follow`, `--direction` and `--depth` as written on the command line, as `smd query` and `smd read` take them. */
export interface FollowFlags {
  follow?: string;
  direction?: string;
  depth?: string;
}

/** The follow options checked (exit code 2 on an error, with this message), with the defaults: out, depth 1. */
export function followOptions(flags: FollowFlags): { direction: 'out' | 'in' | 'both'; depth: number } | { error: string } {
  if (flags.follow !== undefined) {
    try {
      edgeTypes(flags.follow);
    } catch (e) {
      if (e instanceof EdgeTypeError) return { error: e.message };
      throw e;
    }
  }
  if (flags.follow === undefined && (flags.direction !== undefined || flags.depth !== undefined)) return { error: '--direction and --depth go with --follow, e.g. --follow "*" --direction in.' };
  const direction = flags.direction ?? 'out';
  if (direction !== 'out' && direction !== 'in' && direction !== 'both') return { error: `--direction takes out, in or both (got "${direction}").` };
  const depth = flags.depth === undefined ? 1 : Number(flags.depth);
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) return { error: `--depth takes 1, 2 or 3 (got "${flags.depth}").` };
  return { direction, depth };
}

/** The left-out constraints, one line per document, for --json output (where stdout stays an array). */
function notes(result: QueryDocumentsResult): string {
  return result.constraints.filter((c) => !c.included).map((c) => `${constraintNote(c)}\n`).join('');
}

/** One document's contract-aware query: its file and its view. */
interface ContractView { file: string; result: QueryViewResult }

/**
 * `smd query --contract`: for each document with matches, the agent view of its matches with what a section read
 * carries (queryView). One document's view is printed as it is; with several, each follows a `==> file <==` line.
 */
function contractQuery(selector: string, files: string[], flags: QueryFlags): QueryOutput {
  const views: ContractView[] = [];
  for (const file of files) {
    const result = queryView(read(file), selector, {
      brief: flags.brief, lineRefs: flags.lineRefs, today: flags.today, readFile: readerFor(file), file, provenance: !!flags.provenance,
      ...(flags.includedInstructions ? { includedInstructions: flags.includedInstructions } : {}),
    });
    if (result) views.push({ file, result });
  }
  const code = views.length ? 0 : 1;
  const stdout = flags.json ? JSON.stringify(contractJson(views), null, 2) + '\n' : contractText(views);
  const manifests = flags.provenance ? views.map((v) => v.result.provenance!) : undefined;
  return { code, stdout, stderr: contractSummary(views, files.length), ...(manifests ? { manifests } : {}) };
}

/** The views as text: one as it is, several each after a `==> file <==` line. */
export function contractText(views: ReadonlyArray<ContractView>): string {
  if (views.length === 1) return views[0].result.text;
  return views.map((v) => `==> ${v.file} <==\n${v.result.text}`).join('\n');
}

/** `--contract --json`: per document its matches, its view and its mandatory context; then completeness over all. */
export function contractJson(views: ReadonlyArray<ContractView>) {
  const documents = views.map(({ file, result }) => {
    const mandatory = result.mandatory ?? { constraints: [], dependencies: [], unsatisfied: [], complete: true, completeness: completenessOf([]) };
    return { file, matches: result.matches.map(queryViewBlock), text: result.text, mandatory };
  });
  const unsatisfied = documents.flatMap((d) => d.mandatory.unsatisfied);
  const completeness = completenessOf(unsatisfied);
  return { documents, complete: completeness.coverage && completeness.resolution && completeness.budget, completeness };
}

/** The `[smd]` lines: the matches, what the contract added, and a warning for each incomplete view. */
export function contractSummary(views: ReadonlyArray<ContractView>, fileCount: number): string {
  const matches = views.reduce((n, v) => n + v.result.matches.length, 0);
  const constraints = views.reduce((n, v) => n + (v.result.mandatory?.constraints.length ?? 0), 0);
  const dependencies = views.reduce((n, v) => n + (v.result.mandatory?.dependencies.length ?? 0), 0);
  const decisions = views.reduce((n, v) => n + (v.result.mandatory?.decisions?.length ?? 0), 0);
  const tokens = views.reduce((n, v) => n + v.result.tokens, 0);
  const incomplete = views.filter((v) => v.result.mandatory?.unsatisfied.length);
  const lines = [
    `[smd] ${matches} match(es) in ${views.length} of ${fileCount} file(s). With the read contract: ${constraints} constraint(s)${decisions ? `, ${decisions} decision(s)` : ''} and `
    + `${dependencies} dependenc${dependencies === 1 ? 'y' : 'ies'} carried, ≈${tokens} tokens shown${incomplete.length ? '' : ', complete'}.`,
  ];
  for (const v of incomplete) {
    const what = incompleteLine(v.result.mandatory!.unsatisfied).slice('[incomplete: '.length, -1);
    lines.push(`[smd] warning: incomplete view of ${v.file}, ${what} (listed under "Not satisfied")`);
  }
  return lines.join('\n') + '\n';
}
