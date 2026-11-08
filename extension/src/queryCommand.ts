import {
  constraintNote, EdgeTypeError, edgeTypes, formatQueryResult, parseSelector, queryDocuments, queryResultJson, queryResultSummary, SelectorError,
  type QueryDocumentsResult, type Selector,
} from './core';
import { collect, graphReader, querySummary, read } from './workspace';

/** `smd query`'s options. `follow`, `direction` and `depth` are as written on the command line. */
export interface QueryFlags {
  json: boolean;
  titles: boolean;
  brief: boolean;
  lineRefs: boolean;
  today?: string;
  constraints?: boolean;
  follow?: string;
  direction?: string;
  depth?: string;
}

export interface QueryOutput { code: number; stdout: string; stderr: string }

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
    if (flags.follow !== undefined) edgeTypes(flags.follow);
  } catch (e) {
    if (e instanceof SelectorError || e instanceof EdgeTypeError) return fail(e.message);
    throw e;
  }
  if (flags.follow === undefined && (flags.direction !== undefined || flags.depth !== undefined)) return fail('--direction and --depth go with --follow, e.g. --follow "*" --direction in.');
  const direction = flags.direction ?? 'out';
  if (direction !== 'out' && direction !== 'in' && direction !== 'both') return fail(`--direction takes out, in or both (got "${direction}").`);
  const depth = flags.depth === undefined ? 1 : Number(flags.depth);
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) return fail(`--depth takes 1, 2 or 3 (got "${flags.depth}").`);

  const roots = targets.length ? targets : ['.'];
  const files = roots.flatMap((t) => collect(t));
  if (!files.length) return fail('No .smd files found.');
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

/** The left-out constraints, one line per document, for --json output (where stdout stays an array). */
function notes(result: QueryDocumentsResult): string {
  return result.constraints.filter((c) => !c.included).map((c) => `${constraintNote(c)}\n`).join('');
}
