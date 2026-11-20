import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateTokens, parseSmd, type MeterEvent, type MeterOp, type MeterVia } from '../core';
import { loadTokenizer } from '../tokenizer';
import { appendEvents, type MeterSettings } from './log';

/**
 * Recording reads for the token meter. A metered call (one MCP tool call, one CLI command) collects notes from the
 * code that serves content, then turns them into events with the text the agent received. Nothing here runs unless a
 * call is open, so with metering off the reading code pays one `undefined` check per note.
 */

export interface AccessNote {
  /** The document, as an absolute or working-directory-relative path. */
  file: string;
  op: MeterOp;
  /** Slugs of the sections the result held. */
  sections?: string[];
  /** Heading texts of the sections the result held, resolved to slugs when the event is built (query matches). */
  sectionTitles?: string[];
  ids?: string[];
  /** Dependencies followed, as heading texts of the two sections. */
  follow?: Array<{ from: string | null; to: string | null }>;
  /** This document's part of the result, when one call serves several documents. */
  served?: string;
  query?: string;
  outcome?: MeterEvent['outcome'];
}

interface MeterCall {
  notes: AccessNote[];
  /** Text read through each document's reader (includes and code embeds), by document then path. */
  reads: Map<string, Map<string, string>>;
}

let current: MeterCall | undefined;

/** Start collecting notes. A call already open is replaced (calls don't nest). */
export function beginMeterCall(): void {
  current = { notes: [], reads: new Map() };
}

/** Stop collecting; returns what was collected, or undefined when no call was open. */
export function endMeterCall(): MeterCall | undefined {
  const call = current;
  current = undefined;
  return call;
}

/** Note an access. Does nothing unless a metered call is open. */
export function noteAccess(note: AccessNote): void {
  current?.notes.push(note);
}

/** True while a metered call is open, so callers can skip work that only the meter needs. */
export const metering = (): boolean => current !== undefined;

/** Wrap a document's reader so a metered call counts what its view read besides the document (the baseline's includes). */
export function trackReads<T extends (rel: string) => string | undefined>(document: string, reader: T): T {
  return ((rel: string) => {
    const text = reader(rel);
    const call = current;
    if (call && text !== undefined) {
      const key = path.resolve(document);
      const reads = call.reads.get(key) ?? new Map<string, string>();
      reads.set(rel, text);
      call.reads.set(key, reads);
    }
    return text;
  }) as T;
}

// Counting

const counters = new Map<string, { name: string; count: (text: string) => number }>();

/** The counter for a settings' tokenizer: exact when js-tiktoken loads, else the estimate. Cached per name. */
export function meterCounter(tokenizer: string | undefined): { name: string; count: (text: string) => number } {
  const key = tokenizer ?? 'estimate';
  let counter = counters.get(key);
  if (!counter) {
    counter = { name: 'estimate', count: estimateTokens };
    if (tokenizer) {
      try {
        const t = loadTokenizer(tokenizer);
        counter = { name: t.name, count: t.count };
      } catch {
        // No js-tiktoken or an unknown name: the estimate, labelled as such.
      }
    }
    counters.set(key, counter);
  }
  return counter;
}

export const fileHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8);

// Clients and sessions

export interface MeterClient {
  name: string;
  version?: string;
  via: MeterVia;
}

/**
 * The agent that ran the CLI, from what it leaves in the environment. `SMD_CLIENT` wins. The markers of Claude Code,
 * Codex and Cursor are best-effort (the design marks them to verify); anything else is `unknown`.
 */
export function cliClient(env: NodeJS.ProcessEnv = process.env): MeterClient {
  const named = env.SMD_CLIENT?.trim();
  if (named) return { name: named, via: 'cli' };
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return { name: 'claude-code', via: 'cli' };
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return { name: 'codex', via: 'cli' };
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return { name: 'cursor', via: 'cli' };
  return { name: 'unknown', via: 'cli' };
}

export const newSessionId = (prefix: string): string => `${prefix}-${randomBytes(4).toString('hex')}`;

const safeId = (id: string) => id.replaceAll(/[^\w.-]/g, '').slice(0, 64);

/** The meter session of a Claude Code session id, the same from its shell and from its hooks. */
export const claudeSession = (id: string): string => `claude-${safeId(id)}`;

/** CLI calls one client makes with less than this gap between them belong to one session. */
export const CLI_IDLE_GAP_MS = 30 * 60_000;

/**
 * The session of a CLI call: `SMD_SESSION` when set, else the client's last session in this workspace if its last
 * call was within the idle gap, else a new one. The state lives beside the log in `cli-sessions.json`.
 */
export function cliSession(settings: MeterSettings, client: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const given = env.SMD_SESSION?.trim();
  if (given) return `cli-${safeId(given)}`;
  // Claude Code gives its shell commands the session id, which its hooks receive too: one session for both.
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claude && client === 'claude-code') return claudeSession(claude);
  const file = path.join(settings.dir, 'cli-sessions.json');
  let sessions: Record<string, { id: string; last: number }> = {};
  try { sessions = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof sessions; } catch { /* first call */ }
  const known = sessions[client];
  const id = known && now - known.last < CLI_IDLE_GAP_MS ? known.id : newSessionId('cli');
  sessions[client] = { id, last: now };
  try {
    fs.mkdirSync(settings.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sessions));
  } catch { /* the next call starts a new session */ }
  return id;
}

// Events

export interface BuildContext {
  settings: MeterSettings;
  client: MeterClient;
  session: string;
  /** Everything the agent received in this call. */
  served: string;
  /** Overrides for tests. */
  now?: Date;
  readText?: (file: string) => string | undefined;
}

const readText = (file: string): string | undefined => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
};

const relative = (root: string, file: string) => path.relative(root, path.resolve(file)).split(path.sep).join('/');

/** Heading text → slug, for one document's text. */
function slugsOf(text: string): (title: string | null) => string | undefined {
  let headings: Array<{ text: string; slug: string }> | undefined;
  return (title) => {
    if (!title) return undefined;
    headings ??= parseSmd(text).headings;
    const t = title.trim().toLowerCase();
    return headings.find((h) => h.text.trim().toLowerCase() === t)?.slug;
  };
}

/** The events a call's notes describe, one per document (notes of one document and op are merged). */
export function buildEvents(full: MeterCall, ctx: BuildContext): MeterEvent[] {
  // Only documents inside the workspace: a read of a file elsewhere belongs to no workspace's log.
  const call = { ...full, notes: full.notes.filter((n) => !relative(ctx.settings.root, n.file).startsWith('../') && !path.isAbsolute(relative(ctx.settings.root, n.file))) };
  if (!call.notes.length) return [];
  const { settings, client, session } = ctx;
  const counter = meterCounter(settings.tokenizer);
  const ts = (ctx.now ?? new Date()).toISOString();
  const read = ctx.readText ?? readText;
  const servedTokens = counter.count(ctx.served);
  const base = { v: 1 as const, ts, session, client: { name: client.name, ...(client.version ? { version: client.version } : {}), via: client.via } };

  // Cross-file lists: one event naming the files, with no baseline (K3 and K5 only).
  const lists = call.notes.filter((n) => n.op === 'tasks');
  const events: MeterEvent[] = lists.length ? [{
    ...base, op: 'tasks', files: [...new Set(lists.map((n) => relative(settings.root, n.file)))],
    tokens: { served: servedTokens, tokenizer: counter.name }, outcome: 'ok',
  }] : [];

  const groups = new Map<string, AccessNote[]>();
  for (const n of call.notes.filter((x) => x.op !== 'tasks')) {
    const key = `${path.resolve(n.file)}\u0000${n.op}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const shared = groups.size ? Math.round(servedTokens / groups.size) : 0;
  for (const notes of groups.values()) {
    const first = notes[0];
    const abs = path.resolve(first.file);
    const text = read(abs);
    const slug = text === undefined ? () => undefined : slugsOf(text);
    const sections = new Set<string>();
    for (const n of notes) {
      for (const s of n.sections ?? []) sections.add(s);
      for (const t of n.sectionTitles ?? []) { const s = slug(t); if (s) sections.add(s); }
    }
    const ids = [...new Set(notes.flatMap((n) => n.ids ?? []))];
    const follow = notes.flatMap((n) => n.follow ?? []).flatMap((f) => {
      const from = slug(f.from);
      const to = slug(f.to);
      return from && to && from !== to ? [{ from, to }] : [];
    });
    const perFile = notes.every((n) => n.served !== undefined) ? counter.count(notes.map((n) => n.served).join('\n')) : undefined;
    const includes = [...(call.reads.get(abs)?.values() ?? [])].reduce((n, t) => n + counter.count(t), 0);
    const outcome = notes.find((n) => n.outcome && n.outcome !== 'ok')?.outcome ?? 'ok';
    events.push({
      ...base,
      op: first.op,
      file: relative(settings.root, abs),
      ...(text !== undefined ? { fileHash: fileHash(text) } : {}),
      ...(sections.size ? { sections: [...sections] } : {}),
      ...(ids.length ? { ids } : {}),
      ...(follow.length ? { follow } : {}),
      ...(first.query ? { query: first.query } : {}),
      tokens: {
        served: outcome === 'ok' ? perFile ?? (groups.size === 1 ? servedTokens : shared) : 0,
        ...(text !== undefined ? { file: counter.count(text) } : {}),
        ...(includes ? { includes } : {}),
        tokenizer: counter.name,
      },
      outcome,
    });
  }
  return events;
}

/** Build a call's events and append them. Never throws. */
export function recordCall(call: MeterCall | undefined, ctx: BuildContext): MeterEvent[] {
  if (!call || !ctx.settings.enabled) return [];
  try {
    const events = buildEvents(call, ctx);
    appendEvents(ctx.settings, events);
    return events;
  } catch (e) {
    process.stderr.write(`[smd] token meter skipped a read: ${(e as Error).message}\n`);
    return [];
  }
}
