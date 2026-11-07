import * as path from 'node:path';
import { agentView, estimateTokens } from './core';
import { fail } from './cliIo';
import { collect, read, readerFor } from './workspace';

/**
 * `smd savings`: how many tokens an agent saves by reading documents through the agent view instead of as raw
 * files, as a number and a percentage. Estimates use ≈4 characters per token, as `smd outline` does. No prices:
 * they change over time, and the token counts are what a reader can multiply by their own.
 */

export interface SavingsRow {
  file: string;
  /** Raw file, whole agent view, and agent view with --brief, in estimated tokens. */
  raw: number;
  agent: number;
  brief: number;
}

export interface SavingsReport {
  files: SavingsRow[];
  total: { raw: number; agent: number; brief: number; saved: number; savedBrief: number; percent: number; percentBrief: number };
}

/** Sizes of one document. */
export function savingsRow(file: string, text: string, options: { readFile?: (rel: string) => string | undefined; today?: string } = {}): SavingsRow {
  const view = agentView(text, { ...options, file });
  const brief = agentView(text, { ...options, file, brief: true });
  return { file, raw: estimateTokens(text), agent: view.tokens, brief: brief.tokens };
}

export function savingsReport(rows: SavingsRow[]): SavingsReport {
  const sum = (key: 'raw' | 'agent' | 'brief') => rows.reduce((n, r) => n + r[key], 0);
  const raw = sum('raw');
  const agent = sum('agent');
  const brief = sum('brief');
  const percent = (saved: number) => (raw ? Math.round((saved / raw) * 100) : 0);
  return {
    files: rows,
    total: { raw, agent, brief, saved: raw - agent, savedBrief: raw - brief, percent: percent(raw - agent), percentBrief: percent(raw - brief) },
  };
}

export function savingsText(report: SavingsReport): string {
  const pct = (part: number, whole: number) => (whole ? `${Math.round((1 - part / whole) * 100)}%` : '0%');
  const width = Math.max(4, ...report.files.map((r) => r.file.length));
  const head = `${'file'.padEnd(width)}  ${'raw'.padStart(7)}  ${'agent'.padStart(7)}  ${'saved'.padStart(5)}  ${'brief'.padStart(7)}  ${'saved'.padStart(5)}`;
  const line = (r: Omit<SavingsRow, 'file'>, name: string) =>
    `${name.padEnd(width)}  ${String(r.raw).padStart(7)}  ${String(r.agent).padStart(7)}  ${pct(r.agent, r.raw).padStart(5)}  ${String(r.brief).padStart(7)}  ${pct(r.brief, r.raw).padStart(5)}`;
  const { total } = report;
  return [
    head,
    ...report.files.map((r) => line(r, r.file)),
    line(total, 'total'),
    '',
    `Reading all ${report.files.length} document(s) once through the agent view saves ≈${total.saved} tokens (${total.percent}%); `
      + `with --brief ≈${total.savedBrief} tokens (${total.percentBrief}%).`,
    'Estimates at ≈4 characters per token. Reading only the sections a task needs (smd read, then --section) saves more.',
    '',
  ].join('\n');
}

export function runSavings(targets: string[], options: { json: boolean; price?: string; today?: string }): number {
  // --price was removed; accept and ignore it so existing scripts keep running.
  if (options.price !== undefined) process.stderr.write('smd savings: --price was removed; savings are reported in tokens and percent only.\n');
  const files = targets.flatMap((t) => collect(t));
  if (!files.length) return fail(`No .smd files found in: ${targets.join(', ')}`);
  const rows = [...new Set(files)].map((f) => savingsRow(relative(f), read(f), { readFile: readerFor(f), today: options.today }));
  const report = savingsReport(rows);
  process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : savingsText(report));
  return 0;
}

function relative(file: string): string {
  return path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/') || file;
}
