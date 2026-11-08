import type { Omission, OmissionKind, Provenance } from './core';

/**
 * The editor's "What the Agent View Leaves Out" list: what the agent view hid, condensed or could not resolve, why,
 * and where it is in the source. Built from the view's provenance manifest, so it says exactly what the CLI and MCP
 * views do. No VS Code here, so it can be tested on its own (see agentViewUi.ts for the command).
 */

const LABELS: Record<OmissionKind, string> = {
  'skipped-section': 'Section skipped for agents',
  'not-selected': 'Section not selected',
  budget: 'Section left out for the token budget',
  human: ':::human block',
  details: ':::details block condensed',
  diagram: 'Diagram condensed',
  code: 'Long code cut',
  'completed-tasks': 'Completed tasks counted',
  comment: 'HTML comment',
  include: 'Include not shown',
  embed: 'Code embed not shown',
  outline: 'Outline instead of text',
  deprecated: 'Deprecated requirement condensed',
};

const ICONS: Record<OmissionKind, string> = {
  'skipped-section': 'eye-closed', 'not-selected': 'filter', budget: 'dashboard', human: 'person', details: 'fold',
  diagram: 'type-hierarchy', code: 'code', 'completed-tasks': 'tasklist', comment: 'comment', include: 'file-symlink-file',
  embed: 'file-code', outline: 'list-tree', deprecated: 'circle-slash',
};

export interface OmissionItem {
  /** `$(person) :::human block`, with the section heading when there is one. */
  label: string;
  /** `L12–L20`, and the file when it isn't the document. */
  description: string;
  /** Why it was left out, and what shows it. */
  detail: string;
  /** Where to go: the file as the manifest names it, and zero-based first and last line. */
  file: string;
  start: number;
  end: number;
  /** True when the file is the document itself (else an included or embedded file, relative to its folder). */
  own: boolean;
}

/** One list item per omission, in the manifest's order (the document first, then included files). */
export function omissionItems(p: Provenance): OmissionItem[] {
  return p.omissions.map((o) => item(o, p.source.file));
}

function item(o: Omission, document: string): OmissionItem {
  const own = o.file === document;
  const [a, b] = o.lines;
  const lines = a === b ? `L${a}` : `L${a}–L${b}`;
  const extra = [o.count ? `${o.count} task${o.count > 1 ? 's' : ''}` : '', o.tokens ? `≈${o.tokens} tokens` : ''].filter(Boolean).join(', ');
  return {
    label: `$(${ICONS[o.kind]}) ${LABELS[o.kind]}${o.heading ? `: ${o.heading}` : ''}`,
    description: [own ? lines : `${o.file} ${lines}`, extra].filter(Boolean).join(' · '),
    detail: `${capitalize(o.reason)}.${o.retrieve ? ` Shown by: ${o.retrieve}` : ''}`,
    file: o.file, start: a - 1, end: b - 1, own,
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One line for the top of the agent view document: `Left out: 2 :::human blocks, 1 section skipped for agents.`, or
 * an empty string when nothing was left out.
 */
export function omissionSummary(p: Provenance): string {
  const counts = new Map<OmissionKind, number>();
  for (const o of p.omissions) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  if (!counts.size) return '';
  const parts = [...counts].map(([kind, n]) => `${n} × ${LABELS[kind].toLowerCase()}`);
  return `Left out: ${parts.join(', ')}. See "What the Agent View Leaves Out…" for each one and why.`;
}

/**
 * The omissions that only the brief view adds, as items: what an author gives up by sharing the brief view instead of
 * the full one.
 */
export function briefOnlyItems(full: Provenance, brief: Provenance): OmissionItem[] {
  const key = (o: Omission) => `${o.kind}|${o.file}|${o.lines[0]}|${o.lines[1]}`;
  const inFull = new Set(full.omissions.map(key));
  return brief.omissions.filter((o) => !inFull.has(key(o))).map((o) => item(o, brief.source.file));
}
