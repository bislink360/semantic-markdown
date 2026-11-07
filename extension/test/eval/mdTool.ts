import { parseSmd } from '../../src/core';
import { matchesExactly, matchesHeading, sectionsOf, type Section } from '../../src/core/sections';
import { estimate, isSpan, linesOf } from './corpus';
import type { Span } from './types';

/**
 * Condition M2: a reading tool for plain Markdown with the call shape of the MCP `read` tool (`file`, `sections`,
 * `exact`, `mode`, `maxTokens`), plus `query` (text search) and `lines` (a line range). It returns the file as
 * written, never an agent view, so it controls for ordinary retrieval without markup.
 */

export interface MdReadArgs {
  file: string;
  /** Heading texts or ids, as for `read`. */
  sections?: string[];
  /** Match the whole heading text or id. */
  exact?: boolean;
  mode?: 'auto' | 'outline' | 'full';
  /** For `auto`: the whole file at or under this many estimated tokens, else the heading list (default 2000). */
  maxTokens?: number;
  /** Lines containing this text, case-insensitive. */
  query?: string;
  /** A 1-based inclusive line range. */
  lines?: Span;
}

/** The same budget as `read`. */
export const MD_READ_BUDGET = 2000;
/** At most this many search hits are listed. */
export const MAX_HITS = 20;

/** The description the model harness gives the M2 tool, in the style of the MCP `read` tool's. */
export const MD_READ_DESCRIPTION = `Markdown file as written: whole if ≤maxTokens (${MD_READ_BUDGET}), else heading list (L12-30 = lines); then pass sections, query or lines.`;

/** The JSON schema the model harness gives the model for M2, next to the `read` schema it gives for S3. */
export const MD_READ_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Path under the root.' },
    sections: { type: 'array', items: { type: 'string' }, description: 'Heading texts or ids.' },
    exact: { type: 'boolean', description: 'Whole title/id.' },
    mode: { type: 'string', enum: ['auto', 'outline', 'full'] },
    maxTokens: { type: 'integer' },
    query: { type: 'string', description: 'Lines containing this text.' },
    lines: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[start, end], 1-based.' },
  },
  required: ['file'],
  additionalProperties: false,
} as const;

const headingsOf = (md: string) => parseSmd(md).headings;

/** `Title · file ≈N tokens`, then one line per heading with its line range and estimated tokens. */
export function headingList(md: string, file: string): string {
  const lines = linesOf(md);
  const headings = headingsOf(md);
  const title = headings.find((h) => h.level === 1)?.text ?? file;
  const rows = sectionsOf(headings, lines.length).map((s) => ({
    range: `L${s.start + 1}-${s.end + 1}`,
    head: `${'  '.repeat(Math.max(0, s.heading.level - 2))}${'#'.repeat(s.heading.level)} ${s.heading.text}`,
    tokens: `≈${estimate(lines.slice(s.start, s.end + 1).join('\n'))}`,
  }));
  const w1 = Math.max(5, ...rows.map((r) => r.range.length));
  const w2 = Math.max(10, ...rows.map((r) => r.head.length));
  return [
    `${title} · file ≈${estimate(md)} tokens`, '',
    ...rows.map((r) => `${r.range.padEnd(w1)}  ${r.head.padEnd(w2)}  ${r.tokens.padStart(6)}`),
    '', 'Read a section: {file, sections: ["<heading or id>"]}; search: {file, query: "<text>"}; a range: {file, lines: [start, end]}',
  ].join('\n') + '\n';
}

const range = (md: string, file: string, [a, b]: Span, label = '') =>
  `${file} L${a}-${b}${label}:\n${linesOf(md).slice(a - 1, b).join('\n')}`;

function sectionsPart(md: string, args: MdReadArgs): { text: string; missing: string[] } {
  const all = sectionsOf(headingsOf(md), linesOf(md).length);
  const matches = args.exact ? matchesExactly : matchesHeading;
  const missing: string[] = [];
  const picked: Section[] = [];
  for (const q of args.sections ?? []) {
    const hit = all.filter((s) => matches(s.heading, q));
    if (!hit.length) missing.push(q);
    for (const s of hit) if (!picked.includes(s)) picked.push(s);
  }
  const text = picked.map((s) => range(md, args.file, [s.start + 1, s.end + 1], ` (${'#'.repeat(s.heading.level)} ${s.heading.text})`)).join('\n\n');
  return { text, missing };
}

function searchPart(md: string, query: string): string {
  const q = query.toLowerCase();
  const hits = linesOf(md).map((l, i) => [i + 1, l] as const).filter(([, l]) => l.toLowerCase().includes(q));
  if (!hits.length) return `No line matches "${query}".`;
  const shown = hits.slice(0, MAX_HITS).map(([n, l]) => `L${n}: ${l}`);
  const more = hits.length > MAX_HITS ? [`(${hits.length - MAX_HITS} more; narrow the query)`] : [];
  return [`Lines matching "${query}" (${hits.length}):`, ...shown, ...more].join('\n');
}

/** One call of the M2 tool. Errors come back as `Error: …` text, as a tool result would. */
export function mdRead(md: string, args: MdReadArgs): string {
  const parts: string[] = [];
  if (args.sections?.length) {
    const { text, missing } = sectionsPart(md, args);
    const note = missing.length ? `No section matching: ${missing.join(', ')}. Call with mode "outline" to list the headings.` : '';
    if (missing.length === args.sections.length) return `Error: ${note}\n`;
    parts.push(note ? `${text}\n\n(${note})` : text);
  }
  if (args.query !== undefined) parts.push(searchPart(md, args.query));
  if (args.lines !== undefined) {
    const total = linesOf(md).length;
    if (!isSpan(args.lines) || args.lines[1] > total) return `Error: lines must be [start, end] within 1-${total}.\n`;
    parts.push(range(md, args.file, args.lines));
  }
  if (parts.length) return parts.join('\n\n') + '\n';
  const mode = args.mode ?? 'auto';
  if (mode === 'full' || (mode === 'auto' && estimate(md) <= (args.maxTokens ?? MD_READ_BUDGET))) return md.endsWith('\n') ? md : `${md}\n`;
  return headingList(md, args.file);
}

/** One tool call and its result. */
export interface ToolCall { tool: string; args: Record<string, unknown>; result: string }

/** What a navigating condition showed: its calls, in order. */
export interface Transcript { calls: ToolCall[] }

/** `>>> read {"file":"doc.md"}` and the result, per call. The format the render command writes. */
export function transcriptText(t: Transcript): string {
  return t.calls.map((c) => `>>> ${c.tool} ${JSON.stringify(c.args)}\n${c.result.trimEnd()}\n`).join('\n');
}

/** Only the results: what the model read. */
export const transcriptResults = (t: Transcript) => t.calls.map((c) => c.result).join('\n');
