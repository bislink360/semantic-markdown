import { agentView, type AgentViewOptions, type AgentViewResult } from './agentView';
import { parseSmd } from './parse';
import { parseSelector, querySmd, type QueryMatch } from './query';
import { sectionsOf } from './sections';
import { pinLines } from './taskViews';

/**
 * A contract-aware query (`smd query --contract`, the MCP `query` tool's `contract`). The blocks a selector matches in
 * one document come as a section read would carry them: an agent view that shows the matched blocks under their
 * headings, with the document's agent instructions and dangers (view laws L1), the constraints that apply to the
 * matches (L2: document-scoped ones, `scope=section` ones of the section that holds a match or of one around it, those
 * whose `applies-to` names a match or a dependency, and those whose target can't be found), the dependency closure
 * with its typed frontier (L3), and the three completeness flags. It is worked out by the section reader's planning
 * (applicability.ts), each matched block counting as a selected part of its section, so nothing here decides what
 * applies. Without `contract`, `smd query` prints what it always printed.
 */

export interface QueryViewOptions extends Omit<AgentViewOptions, 'pinned' | 'sections' | 'exactSections'> {}

/** A matched block, with one-based lines as in provenance. */
export interface QueryViewBlock {
  type: string;
  title: string;
  id?: string;
  line: number;
  endLine: number;
  section: string | null;
}

export interface QueryViewResult extends AgentViewResult {
  /** The blocks the selector matched, in document order, as querySmd gives them (zero-based lines). */
  matches: QueryMatch[];
}

/**
 * The agent view of the blocks `selector` matches in `text`, with what they need (see the module comment), or null when
 * nothing matches. Throws SelectorError for a selector that can't be read.
 */
export function queryView(text: string, selector: string, options: QueryViewOptions = {}): QueryViewResult | null {
  const matches = querySmd(text, parseSelector(selector), { brief: options.brief, lineRefs: options.lineRefs, today: options.today });
  if (!matches.length) return null;
  const lines = text.split(/\r?\n/);
  const sections = sectionsOf(parseSmd(text).headings, lines.length);
  const blocks = matches.map((m) => [m.line, m.endLine] as const);
  const count = `${matches.length} block${matches.length === 1 ? '' : 's'}`;
  const result = agentView(text, {
    ...options,
    pinned: { ranges: pinLines(lines, sections, blocks), whole: [], selects: true, label: `(excerpt — query: ${selector}; ${count})`, appendix: '', blocks },
  });
  if (result.provenance) result.provenance.query = { selector, matches: matches.map(queryViewBlock) };
  return { ...result, matches };
}

export function queryViewBlock(m: QueryMatch): QueryViewBlock {
  return { type: m.type, title: m.title, ...(typeof m.attrs.id === 'string' ? { id: m.attrs.id } : {}), line: m.line + 1, endLine: m.endLine + 1, section: m.section };
}
