import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_FILES } from '../config';
import { parseMeterLines, type MeterEvent } from '../core';

/**
 * The meter log: `<workspace>/.smd/meter/events-YYYY-MM.jsonl`, one JSON object per line, appended by the CLI, the MCP
 * server, agent hooks and the extension. `.smd/.gitignore` ignores the folder. Off until turned on (see meterSettings).
 */

export const METER_DIR = path.join('.smd', 'meter');
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_MAX_MEGABYTES = 20;
const EVENTS_FILE = /^events-(\d{4})-(\d{2})\.jsonl$/;

export interface MeterSettings {
  enabled: boolean;
  /** The workspace root the log belongs to. */
  root: string;
  /** The folder of event files. */
  dir: string;
  retentionDays: number;
  maxBytes: number;
  /** An encoding for exact counts (js-tiktoken), or undefined for the estimate. */
  tokenizer?: string;
  /** Why it is off, for messages: `config`, `env` or undefined when on. */
  off?: 'config' | 'env';
}

/** The `meter` value of a config file: `true`, `false` or an object. Anything else counts as off. */
export interface MeterConfig {
  enabled?: boolean;
  retentionDays?: number;
  maxMegabytes?: number;
  tokenizer?: string;
  /** A folder for the log instead of `.smd/meter` (for read-only or synced workspaces). */
  dir?: string;
}

/** The config file at the workspace root, if any (the first of CONFIG_FILES). */
export function rootConfigFile(root: string): string | undefined {
  return CONFIG_FILES.map((name) => path.join(root, name)).find((f) => fs.existsSync(f));
}

export function readMeterConfig(root: string): MeterConfig {
  const file = rootConfigFile(root);
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const meter = data?.meter;
    if (meter === true) return { enabled: true };
    if (meter && typeof meter === 'object' && !Array.isArray(meter)) {
      const m = meter as Record<string, unknown>;
      return {
        enabled: m.enabled !== false,
        ...(typeof m.retentionDays === 'number' && m.retentionDays > 0 ? { retentionDays: m.retentionDays } : {}),
        ...(typeof m.maxMegabytes === 'number' && m.maxMegabytes > 0 ? { maxMegabytes: m.maxMegabytes } : {}),
        ...(typeof m.tokenizer === 'string' ? { tokenizer: m.tokenizer } : {}),
        ...(typeof m.dir === 'string' && m.dir.trim() ? { dir: m.dir } : {}),
      };
    }
    return { enabled: false };
  } catch {
    return {};
  }
}

/**
 * Whether metering is on for a workspace and where its log is. On when the root config says `"meter": true` (or an
 * object without `enabled: false`), or when `force` is set (the extension's setting); `SMD_METER=off` wins over both.
 */
export function meterSettings(root: string, options: { force?: boolean; env?: NodeJS.ProcessEnv } = {}): MeterSettings {
  const env = options.env ?? process.env;
  const config = readMeterConfig(root);
  const dir = config.dir ? path.resolve(root, config.dir) : path.join(root, METER_DIR);
  const base = {
    root, dir,
    retentionDays: config.retentionDays ?? DEFAULT_RETENTION_DAYS,
    maxBytes: (config.maxMegabytes ?? DEFAULT_MAX_MEGABYTES) * 1024 * 1024,
    ...(config.tokenizer ? { tokenizer: config.tokenizer } : {}),
  };
  if ((env.SMD_METER ?? '').toLowerCase() === 'off') return { ...base, enabled: false, off: 'env' };
  const enabled = !!(config.enabled || options.force);
  return { ...base, enabled, ...(enabled ? {} : { off: 'config' as const }) };
}

/** Turn metering on or off in the root config: `"meter": true` added, or the key removed. Other keys are kept. */
export function setMeterConfig(root: string, enabled: boolean): string {
  const file = rootConfigFile(root) ?? path.join(root, '.smdrc');
  let data: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path.basename(file)} must be a JSON object.`);
      data = parsed as Record<string, unknown>;
    }
  }
  const current = data.meter;
  if (enabled) data.meter = current && typeof current === 'object' ? { ...(current as object), enabled: true } : true;
  else if (current && typeof current === 'object') data.meter = { ...(current as object), enabled: false };
  else delete data.meter;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

export const eventsFileFor = (dir: string, date: Date) => path.join(dir, `events-${date.toISOString().slice(0, 7)}.jsonl`);

/** The event files in a folder, oldest first. */
export function eventFiles(dir: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => EVENTS_FILE.test(n)).sort().map((n) => path.join(dir, n));
}

/** Every event in the folder, oldest file first. Unreadable files and torn lines are skipped. */
export function readEvents(dir: string): MeterEvent[] {
  return eventFiles(dir).flatMap((file) => {
    try { return parseMeterLines(fs.readFileSync(file, 'utf8')); } catch { return []; }
  });
}

export function folderBytes(dir: string): number {
  return eventFiles(dir).reduce((n, f) => {
    try { return n + fs.statSync(f).size; } catch { return n; }
  }, 0);
}

/** Delete monthly files whose whole month ended more than `retentionDays` ago. Returns the files deleted. */
export function pruneEvents(dir: string, retentionDays: number, now = new Date()): string[] {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const deleted: string[] = [];
  for (const file of eventFiles(dir)) {
    const [, y, m] = EVENTS_FILE.exec(path.basename(file))!;
    const monthEnd = Date.UTC(Number(y), Number(m), 1); // first day of the next month
    if (monthEnd < cutoff) {
      try { fs.rmSync(file); deleted.push(file); } catch { /* left for the next run */ }
    }
  }
  return deleted;
}

/** Delete every event file. Returns how many were deleted. */
export function clearEvents(dir: string): number {
  let n = 0;
  for (const file of eventFiles(dir)) {
    try { fs.rmSync(file); n++; } catch { /* reported by the caller through the count */ }
  }
  return n;
}

/** `.smd/.gitignore` with `*`, so nothing under `.smd/` is committed; written once, never overwritten. */
function ensureGitignore(settings: MeterSettings): void {
  const smdDir = path.join(settings.root, '.smd');
  if (!isInsideDir(smdDir, settings.dir)) return;
  const ignore = path.join(smdDir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Written by smd: the token meter log is local and never committed.\n*\n');
}

const isInsideDir = (outer: string, inner: string) => {
  const rel = path.relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Per-process state: when the size was last checked, and whether a warning was printed. */
const state = { checkedAt: 0, full: false, warned: false, pruned: false };

/**
 * Append events, one line each. Never throws: a failure is reported once per process on `warn` (stderr by default).
 * Returns false when nothing was written (off, over the cap, or an error).
 */
export function appendEvents(settings: MeterSettings, events: readonly MeterEvent[], warn: (m: string) => void = (m) => process.stderr.write(`${m}\n`)): boolean {
  if (!settings.enabled || !events.length) return false;
  const once = (m: string) => { if (!state.warned) { state.warned = true; warn(m); } };
  try {
    fs.mkdirSync(settings.dir, { recursive: true });
    ensureGitignore(settings);
    if (!state.pruned) { state.pruned = true; pruneEvents(settings.dir, settings.retentionDays); }
    const now = Date.now();
    if (now - state.checkedAt > 60_000) {
      state.checkedAt = now;
      state.full = folderBytes(settings.dir) >= settings.maxBytes;
    }
    if (state.full) {
      once(`[smd] token meter paused: ${settings.dir} reached ${Math.round(settings.maxBytes / 1048576)} MB. Run "smd meter clear" or raise meter.maxMegabytes.`);
      return false;
    }
    // One write per event, so concurrent writers interleave whole lines.
    const file = eventsFileFor(settings.dir, new Date());
    for (const e of events) fs.appendFileSync(file, JSON.stringify(e) + '\n', { flag: 'a' });
    return true;
  } catch (e) {
    once(`[smd] token meter could not write to ${settings.dir}: ${(e as Error).message}. Reads are not affected.`);
    return false;
  }
}

/** For tests: forget the per-process state. */
export function resetMeterLogState(): void {
  Object.assign(state, { checkedAt: 0, full: false, warned: false, pruned: false });
}
