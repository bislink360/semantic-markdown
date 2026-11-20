/**
 * Token meter: the KPIs and the section graph, computed from meter events. Pure and browser-safe: the Node hosts
 * write and read the log (src/meter), and the extension and `smd meter report` both call these functions, so they
 * show the same numbers for the same log. Design: docs/rfcs/token-metering-design.smd.
 */

import { DocumentGraph, type GraphNode } from './graph';
import { parseSmd } from './parse';

export const METER_SCHEMA_VERSION = 1;

/** How an access came in. */
export type MeterVia = 'mcp' | 'cli' | 'hook' | 'editor';

/**
 * What was read. `outline`, `section` and `query` are targeted reads, `agent` and `brief` whole-file views, `tasks` a
 * cross-file list, `raw-read` the agent's own file read (from a hook) and `copy` a person copying a view for an agent.
 */
export type MeterOp = 'outline' | 'section' | 'agent' | 'brief' | 'query' | 'tasks' | 'raw-read' | 'copy';

export const METER_OPS: readonly MeterOp[] = ['outline', 'section', 'agent', 'brief', 'query', 'tasks', 'raw-read', 'copy'];

export interface MeterEvent {
  v: 1;
  /** ISO 8601 time. */
  ts: string;
  /** `mcp-…` per MCP connection, `hook-…` from an agent hook, `cli-…` from the idle-gap rule, `editor-…`. */
  session: string;
  client: { name: string; version?: string; via: MeterVia };
  op: MeterOp;
  /** The document, relative to the workspace root with `/`. Absent for cross-file operations (`tasks`). */
  file?: string;
  /** The documents a cross-file operation read. */
  files?: string[];
  /** First 8 hex characters of the SHA-256 of the file text. */
  fileHash?: string;
  /** Slugs of the sections the result held. Empty or absent for a whole-file read. */
  sections?: string[];
  /** Block ids the result held. */
  ids?: string[];
  /** Section-level dependency edges the read followed, as slugs. */
  follow?: Array<{ from: string; to: string }>;
  /** A query selector, as written. Never its matches. */
  query?: string;
  tokens: {
    /** Tokens of everything the agent received. */
    served: number;
    /** Tokens of the raw file, and of the files its view read (includes and code embeds), for the baseline. */
    file?: number;
    includes?: number;
    /** `estimate` (≈4 characters per token) or an encoding name such as `o200k_base`. */
    tokenizer: string;
  };
  outcome: 'ok' | 'not-found' | 'error';
}

/** Ops that read through smd (everything but raw reads and people's copies). */
const SMD_OPS = new Set<MeterOp>(['outline', 'section', 'agent', 'brief', 'query', 'tasks']);
const TARGETED_OPS = new Set<MeterOp>(['outline', 'section', 'query']);

/** Is this a well-formed event of a schema version this code reads? Lines that aren't are skipped. */
export function isMeterEvent(value: unknown): value is MeterEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<MeterEvent>;
  return e.v === METER_SCHEMA_VERSION && typeof e.ts === 'string' && typeof e.session === 'string'
    && !!e.client && typeof e.client.name === 'string' && typeof e.op === 'string' && (METER_OPS as readonly string[]).includes(e.op)
    && !!e.tokens && typeof e.tokens.served === 'number' && typeof e.tokens.tokenizer === 'string';
}

/** Parse JSON Lines, skipping blank, torn and unknown lines. */
export function parseMeterLines(text: string): MeterEvent[] {
  const events: MeterEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isMeterEvent(value)) events.push(value);
    } catch {
      // A torn or foreign line costs one event, never the file.
    }
  }
  return events;
}

export interface MeterFilter {
  /** Inclusive lower bound, an ISO date or time. */
  since?: string;
  /** Exclusive upper bound, an ISO date or time. */
  until?: string;
  /** Only these files, or files under these folders (relative, with `/`). */
  paths?: string[];
}

export function filterEvents(events: readonly MeterEvent[], filter: MeterFilter = {}): MeterEvent[] {
  const { since, until, paths } = filter;
  const under = (file: string) => paths!.some((p) => {
    const prefix = p.replace(/\/+$/, '');
    return prefix === '' || prefix === '.' || file === prefix || file.startsWith(`${prefix}/`);
  });
  return events.filter((e) => (!since || e.ts >= since) && (!until || e.ts < until)
    && (!paths?.length || (e.file ? under(e.file) : (e.files ?? []).some(under))));
}

export interface Savings {
  baseline: number;
  served: number;
  saved: number;
  /** saved ÷ baseline, rounded; 0 without a baseline. Negative when smd served more. */
  percent: number;
}

export interface FileStat extends Savings {
  file: string;
  reads: number;
  sessions: number;
  rawReads: number;
}

export interface SectionStat {
  file: string;
  slug: string;
  reads: number;
  sessions: number;
  /** Tokens of the reads that held this section, split evenly between the sections each read held. */
  served: number;
  /** Reads of this section that repeated one earlier in the same session. */
  rereads: number;
  lastRead: string;
}

export interface ClientStat {
  name: string;
  /** How it came in: `mcp`, `cli`, `hook`, `editor`, in first-seen order. */
  via: MeterVia[];
  sessions: number;
  smdReads: number;
  rawReads: number;
  /** smdReads ÷ (smdReads + rawReads), or null when raw reads aren't measured for this client (no hook event seen). */
  share: number | null;
  served: number;
}

export interface MeterReport {
  period: { from?: string; to?: string };
  events: number;
  /** Counting methods in the period; more than one means figures mix methods (see `byTokenizer`). */
  tokenizers: string[];
  kpis: {
    /** K1, the headline: each file's baseline once per session against everything smd served for it in that session. */
    sessionNet: Savings;
    /** K1 per counting method, when the period mixes methods. */
    byTokenizer?: Record<string, Savings>;
    /** K2: every read against a whole-file baseline. Overstates; secondary. */
    perRead: Savings;
    /** K3. */
    served: number;
    reads: number;
    sessions: number;
    /** K4, over clients with raw reads measured; null when none are. */
    smdShare: number | null;
    /** K5. */
    targeted: { count: number; of: number; percent: number };
    /** K6. */
    rereads: { count: number; of: number; percent: number };
    /** K7: what whole-file views left out (human-only content, condensing), not a saving the agent chose. */
    withheld: number;
  };
  files: FileStat[];
  sections: SectionStat[];
  clients: ClientStat[];
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const savings = (baseline: number, served: number): Savings => ({ baseline, served, saved: baseline - served, percent: pct(baseline - served, baseline) });
const baseOf = (e: MeterEvent) => (e.tokens.file ?? 0) + (e.tokens.includes ?? 0);
const isSmd = (e: MeterEvent) => SMD_OPS.has(e.op);
const sorted = (events: readonly MeterEvent[]) => [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

/** Session net savings (K1) over events that read one file through smd and know its size. */
function sessionNet(events: readonly MeterEvent[]): Savings {
  // Per session and file: the latest baseline (the file may change during a session) and the sum served.
  const pairs = new Map<string, { base: number; served: number }>();
  for (const e of sorted(events)) {
    if (!isSmd(e) || !e.file || e.tokens.file === undefined || e.outcome !== 'ok') continue;
    const key = `${e.session}\u0000${e.file}`;
    const pair = pairs.get(key) ?? { base: 0, served: 0 };
    pair.base = baseOf(e);
    pair.served += e.tokens.served;
    pairs.set(key, pair);
  }
  let base = 0;
  let served = 0;
  for (const p of pairs.values()) { base += p.base; served += p.served; }
  return savings(base, served);
}

/** The KPIs, files, sections and clients of a period. `filter` narrows the events first. */
export function meterReport(all: readonly MeterEvent[], filter: MeterFilter = {}): MeterReport {
  const events = sorted(filterEvents(all, filter));
  const smd = events.filter(isSmd);
  const ok = smd.filter((e) => e.outcome === 'ok');
  const tokenizers = [...new Set(events.map((e) => e.tokens.tokenizer))];

  const perReadEvents = ok.filter((e) => e.file && e.tokens.file !== undefined);
  const perRead = savings(perReadEvents.reduce((n, e) => n + baseOf(e), 0), perReadEvents.reduce((n, e) => n + e.tokens.served, 0));
  const byTokenizer = tokenizers.length > 1
    ? Object.fromEntries(tokenizers.map((t) => [t, sessionNet(events.filter((e) => e.tokens.tokenizer === t))]))
    : undefined;

  // Sections: counts, sessions, served (split between the sections of a read), re-reads within a session.
  const sectionMap = new Map<string, SectionStat & { sessionSet: Set<string> }>();
  const seen = new Set<string>();
  let sectionReads = 0;
  let rereads = 0;
  for (const e of ok) {
    if (!e.file || !e.sections?.length) continue;
    const share = e.tokens.served / e.sections.length;
    for (const slug of new Set(e.sections)) {
      const key = `${e.file}#${slug}`;
      const stat = sectionMap.get(key) ?? { file: e.file, slug, reads: 0, sessions: 0, served: 0, rereads: 0, lastRead: e.ts, sessionSet: new Set<string>() };
      stat.reads++;
      stat.served += share;
      stat.lastRead = e.ts;
      stat.sessionSet.add(e.session);
      const once = `${e.session}\u0000${key}`;
      sectionReads++;
      if (seen.has(once)) { stat.rereads++; rereads++; } else seen.add(once);
      sectionMap.set(key, stat);
    }
  }
  const sections = [...sectionMap.values()]
    .map(({ sessionSet, ...s }) => ({ ...s, sessions: sessionSet.size, served: Math.round(s.served) }))
    .sort((a, b) => b.reads - a.reads || a.file.localeCompare(b.file) || a.slug.localeCompare(b.slug));

  // Files: session net savings per file, reads, sessions, raw reads.
  const fileNames = [...new Set(events.flatMap((e) => (e.file ? [e.file] : [])))];
  const files = fileNames.map((file): FileStat => {
    const mine = events.filter((e) => e.file === file);
    const reads = mine.filter(isSmd);
    return {
      file, ...sessionNet(mine), reads: reads.length, sessions: new Set(reads.map((e) => e.session)).size,
      rawReads: mine.filter((e) => e.op === 'raw-read').length,
    };
  }).sort((a, b) => b.saved - a.saved || b.reads - a.reads || a.file.localeCompare(b.file));

  // Clients: reads through smd, raw reads (only measured where a hook reported one), share.
  const clientMap = new Map<string, { via: MeterVia[]; sessions: Set<string>; smd: number; raw: number; served: number; hooked: boolean }>();
  for (const e of events) {
    const c = clientMap.get(e.client.name) ?? { via: [], sessions: new Set<string>(), smd: 0, raw: 0, served: 0, hooked: false };
    if (!c.via.includes(e.client.via)) c.via.push(e.client.via);
    c.sessions.add(e.session);
    if (e.client.via === 'hook') c.hooked = true;
    if (e.op === 'raw-read') c.raw++;
    else if (isSmd(e)) { c.smd++; c.served += e.tokens.served; }
    clientMap.set(e.client.name, c);
  }
  const clients = [...clientMap.entries()].map(([name, c]): ClientStat => ({
    name, via: c.via, sessions: c.sessions.size, smdReads: c.smd, rawReads: c.raw,
    share: c.hooked ? pct(c.smd, c.smd + c.raw) : null, served: c.served,
  })).sort((a, b) => b.smdReads - a.smdReads || a.name.localeCompare(b.name));

  const measured = clients.filter((c) => c.share !== null);
  const measuredSmd = measured.reduce((n, c) => n + c.smdReads, 0);
  const measuredRaw = measured.reduce((n, c) => n + c.rawReads, 0);
  const targeted = smd.filter((e) => TARGETED_OPS.has(e.op)).length;
  const withheld = ok.filter((e) => e.op === 'agent' && e.tokens.file !== undefined)
    .reduce((n, e) => n + Math.max(0, baseOf(e) - e.tokens.served), 0);

  return {
    period: { from: events[0]?.ts ?? filter.since, to: events.at(-1)?.ts ?? filter.until },
    events: events.length,
    tokenizers,
    kpis: {
      sessionNet: sessionNet(events),
      ...(byTokenizer ? { byTokenizer } : {}),
      perRead,
      served: smd.reduce((n, e) => n + e.tokens.served, 0),
      reads: smd.length,
      sessions: new Set(smd.map((e) => e.session)).size,
      smdShare: measured.length ? pct(measuredSmd, measuredSmd + measuredRaw) : null,
      targeted: { count: targeted, of: smd.length, percent: pct(targeted, smd.length) },
      rereads: { count: rereads, of: sectionReads, percent: pct(rereads, sectionReads) },
      withheld,
    },
    files,
    sections,
    clients,
  };
}

// Section graph

export interface SectionNode {
  /** `file#slug`. */
  key: string;
  file: string;
  slug: string;
  reads: number;
}

export type SectionEdgeKind = 'co-read' | 'followed' | 'declared';

export interface SectionEdge {
  /** Node keys; for co-read and declared edges `a` sorts before `b`, followed edges point from `a` to `b`. */
  a: string;
  b: string;
  kind: SectionEdgeKind;
  /** Sessions (co-read) or traversals (followed); 0 for declared. */
  weight: number;
  /** For declared edges: the edge type, e.g. `depends-on`. */
  type?: string;
}

export interface SectionGraph {
  nodes: SectionNode[];
  edges: SectionEdge[];
  findings: {
    /** Declared edges with no co-read or followed weight in the period. */
    declaredNeverFollowed: SectionEdge[];
    /** Co-read edges at or above the threshold with no declared edge between the two sections. */
    readTogetherNotLinked: SectionEdge[];
  };
}

export interface SectionGraphOptions extends MeterFilter {
  /** Two section reads in one session this close together form a co-read edge. Default 10 minutes. */
  windowMinutes?: number;
  /** The documents' declared links between sections, as `file#slug` keys (the host derives them from the graph). */
  declared?: Array<{ from: string; to: string; type: string }>;
  /** Sessions a co-read edge needs to be listed as "read together, not linked". Default 3. */
  threshold?: number;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Sections as nodes, co-read, followed and declared edges, and the two findings. */
export function sectionGraph(all: readonly MeterEvent[], options: SectionGraphOptions = {}): SectionGraph {
  const { windowMinutes = 10, declared = [], threshold = 3 } = options;
  const events = sorted(filterEvents(all, options)).filter((e) => isSmd(e) && e.outcome === 'ok' && e.file);
  const window = windowMinutes * 60_000;
  const nodes = new Map<string, SectionNode>();
  const node = (file: string, slug: string) => {
    const key = `${file}#${slug}`;
    if (!nodes.has(key)) nodes.set(key, { key, file, slug, reads: 0 });
    return nodes.get(key)!;
  };

  // Co-reads: per session, pairs of distinct sections read within the window, counted once per session.
  const coRead = new Map<string, Set<string>>();
  const bySession = new Map<string, Array<{ key: string; t: number }>>();
  const followed = new Map<string, number>();
  for (const e of events) {
    for (const slug of new Set(e.sections ?? [])) {
      node(e.file!, slug).reads++;
      const reads = bySession.get(e.session) ?? [];
      reads.push({ key: `${e.file}#${slug}`, t: Date.parse(e.ts) });
      bySession.set(e.session, reads);
    }
    for (const f of e.follow ?? []) {
      const from = node(e.file!, f.from).key;
      const to = node(e.file!, f.to).key;
      if (from !== to) followed.set(`${from}\u0000${to}`, (followed.get(`${from}\u0000${to}`) ?? 0) + 1);
    }
  }
  for (const [session, reads] of bySession) {
    for (let i = 0; i < reads.length; i++) {
      for (let j = i + 1; j < reads.length && reads[j].t - reads[i].t <= window; j++) {
        if (reads[i].key === reads[j].key) continue;
        const key = pairKey(reads[i].key, reads[j].key);
        const sessions = coRead.get(key) ?? new Set<string>();
        sessions.add(session);
        coRead.set(key, sessions);
      }
    }
  }

  const edges: SectionEdge[] = [];
  for (const [key, sessions] of coRead) {
    const [a, b] = key.split('\u0000');
    edges.push({ a, b, kind: 'co-read', weight: sessions.size });
  }
  for (const [key, weight] of followed) {
    const [a, b] = key.split('\u0000');
    edges.push({ a, b, kind: 'followed', weight });
  }
  const declaredPairs = new Set<string>();
  for (const d of declared) {
    if (d.from === d.to) continue;
    const pair = pairKey(d.from, d.to);
    if (declaredPairs.has(pair)) continue;
    declaredPairs.add(pair);
    const [a, b] = pair.split('\u0000');
    for (const k of [a, b]) {
      const hash = k.lastIndexOf('#');
      node(k.slice(0, hash), k.slice(hash + 1));
    }
    edges.push({ a, b, kind: 'declared', weight: 0, type: d.type });
  }
  edges.sort((x, y) => y.weight - x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  const used = new Set<string>([
    ...coRead.keys(),
    ...[...followed.keys()].map((k) => { const [a, b] = k.split('\u0000'); return pairKey(a, b); }),
  ]);
  return {
    nodes: [...nodes.values()].sort((a, b) => b.reads - a.reads || a.key.localeCompare(b.key)),
    edges,
    findings: {
      declaredNeverFollowed: edges.filter((e) => e.kind === 'declared' && !used.has(pairKey(e.a, e.b))),
      readTogetherNotLinked: edges.filter((e) => e.kind === 'co-read' && e.weight >= threshold && !declaredPairs.has(pairKey(e.a, e.b))),
    },
  };
}

/** The graph as a Mermaid flowchart, for pasting into a document. */
export function sectionGraphMermaid(graph: SectionGraph): string {
  const ids = new Map(graph.nodes.map((n, i) => [n.key, `s${i}`]));
  const label = (n: SectionNode) => `${n.slug} · ${n.reads}`.replaceAll('"', "'");
  const lines = ['flowchart LR', '  accTitle: Sections agents read together'];
  for (const n of graph.nodes) lines.push(`  ${ids.get(n.key)}["${label(n)}"]`);
  for (const e of graph.edges) {
    const a = ids.get(e.a);
    const b = ids.get(e.b);
    if (!a || !b) continue;
    if (e.kind === 'co-read') lines.push(`  ${a} ---|${e.weight}| ${b}`);
    else if (e.kind === 'followed') lines.push(`  ${a} -->|followed ${e.weight}| ${b}`);
    else lines.push(`  ${a} -.-|${e.type ?? 'declared'}| ${b}`);
  }
  return lines.join('\n') + '\n';
}

/** Round to a short count: 6312 → "6.3k". */
export function shortTokens(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs < 1000) return `${sign}${abs}`;
  if (abs < 1_000_000) {
    const k = abs / 1000;
    return `${sign}${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "≈4 chars/token" or the encoding name, joined when a period mixes methods. */
export function methodLabel(tokenizers: readonly string[]): string {
  if (!tokenizers.length) return '≈4 chars/token';
  return tokenizers.map((t) => (t === 'estimate' ? '≈4 chars/token' : t)).join(' + ');
}

/**
 * A document's declared links between its own sections (depends-on, applies-to, verifies, :ref, anchor links), as
 * `file#slug` keys for sectionGraph. An edge written in or pointing at a heading counts for that heading's section.
 */
export function declaredSectionEdges(file: string, text: string): Array<{ from: string; to: string; type: string }> {
  const graph = new DocumentGraph([{ path: file, text }]);
  const headings = parseSmd(text).headings;
  const slugOf = (title: string | null | undefined) => {
    if (!title) return undefined;
    const t = title.trim().toLowerCase();
    return headings.find((h) => h.text.trim().toLowerCase() === t)?.slug;
  };
  const sectionOf = (n: GraphNode) => slugOf(n.type === 'heading' ? n.title : n.section);
  const path = graph.paths[0];
  const edges: Array<{ from: string; to: string; type: string }> = [];
  for (const e of path ? graph.edgesOf(path) : []) {
    if (e.status !== 'resolved' || !e.to || e.to.file !== e.from.file || e.type === 'include') continue;
    const from = sectionOf(e.from);
    const to = sectionOf(e.to);
    if (from && to && from !== to) edges.push({ from: `${file}#${from}`, to: `${file}#${to}`, type: e.type });
  }
  return edges;
}
