import * as fs from 'node:fs';
import * as path from 'node:path';
import { meterReport, methodLabel, type MeterEvent, type MeterReport } from './core';
import { CONFIG_FILES } from './config';
import {
  appendEvents, clearEvents, eventFiles, folderBytes, meterSettings, readEvents, setMeterConfig, type MeterSettings,
} from './meter/log';
import { beginMeterCall, claudeSession, cliClient, cliSession, endMeterCall, fileHash, meterCounter, recordCall } from './meter/record';

/**
 * `smd meter`: the token meter from the command line. `report` prints the KPIs from the log, `on` and `off` turn it on
 * or off in the workspace config, `clear` deletes the log, `hook` records a raw read from an agent hook, and `status`
 * (the default) says whether it is on and how much it has recorded. Design: docs/rfcs/token-metering-design.smd.
 */

export const METER_HELP = `smd meter [status|on|off|report|clear|hook] [--root <dir>]
  Records, on this machine only, what agents read through smd (MCP server and CLI) and how many tokens
  that saved against reading the raw files. Off until turned on. Nothing leaves the machine; no document text is stored.
    status   whether it is on, where the log is and how much it holds (default)
    on, off  turn it on or off for the workspace ("meter" in .smdrc)
    report [paths…] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
             KPIs: session net savings, tokens served, smd share, targeted reads, re-reads; files, sections, agents
    clear    delete every recorded event
    hook     record an agent's own read of a .smd file, from a Claude Code PostToolUse hook (JSON on stdin)
  The workspace is the nearest folder with .smdrc, smd.config.json or .git (or --root).`;

/** Commands that serve .smd content to an agent, and so are metered. */
export const METERED_COMMANDS = new Set(['read', 'agent', 'outline', 'query', 'tasks']);

/** The workspace a path belongs to: the nearest folder with a config file or `.git`, else the start folder. */
export function findMeterRoot(start = process.cwd()): string {
  const from = path.resolve(start);
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (CONFIG_FILES.some((name) => fs.existsSync(path.join(dir, name))) || fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return from;
  }
}

/**
 * Run a CLI command with the meter around it: what it writes to stdout is what the agent received. Off (the default),
 * the command runs untouched.
 */
export function meteredCli(command: string | undefined, run: () => number | Promise<number>): number | Promise<number> {
  if (!command || !METERED_COMMANDS.has(command)) return run();
  let settings: MeterSettings;
  try {
    settings = meterSettings(findMeterRoot());
  } catch {
    return run();
  }
  if (!settings.enabled) return run();
  const chunks: string[] = [];
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stdout.write;
  beginMeterCall();
  const finish = (code: number) => {
    stdout.write = write;
    const call = endMeterCall();
    // A failed read is recorded too, with its outcome and nothing served (R1).
    if (call?.notes.length) {
      const client = cliClient();
      recordCall(call, { settings, client, session: cliSession(settings, client.name), served: chunks.join('') });
    }
    return code;
  };
  try {
    const result = run();
    return typeof result === 'number' ? finish(result) : result.then(finish, (e: unknown) => { finish(2); throw e; });
  } catch (e) {
    finish(2);
    throw e;
  }
}

export interface MeterCommandOptions {
  sub?: string;
  positional: string[];
  root?: string;
  since?: string;
  until?: string;
  json: boolean;
  /** For `hook`: the JSON the agent sent on stdin. */
  stdin?: () => string;
}

export function runMeter(options: MeterCommandOptions): number {
  const root = path.resolve(options.root ?? findMeterRoot());
  const settings = meterSettings(root);
  switch (options.sub ?? 'status') {
    case 'status':
      process.stdout.write(statusText(settings));
      return 0;
    case 'on':
    case 'off': {
      const file = setMeterConfig(root, options.sub === 'on');
      console.log(options.sub === 'on'
        ? `Token metering is on for ${root} ("meter" in ${path.basename(file)}). Agents' reads through smd are recorded in ${settings.dir}.`
        : `Token metering is off for ${root}. The recorded events are kept; "smd meter clear" deletes them.`);
      return 0;
    }
    case 'report': {
      const events = readEvents(settings.dir);
      const paths = options.positional.map((p) => path.relative(root, path.resolve(p)).split(path.sep).join('/') || '.');
      const report = meterReport(events, { since: options.since, until: options.until, paths });
      process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : meterReportText(report, settings));
      return 0;
    }
    case 'clear': {
      const n = clearEvents(settings.dir);
      console.log(`Deleted ${n} event file(s) from ${settings.dir}.`);
      return 0;
    }
    case 'hook':
      // A hook must never block or fail the agent: every problem ends here with exit code 0.
      try { meterHook(options.stdin?.() ?? '', settings); } catch { /* never fail the agent */ }
      return 0;
    default:
      console.error(`Unknown subcommand "${options.sub}".\n${METER_HELP}`);
      return 2;
  }
}

function statusText(s: MeterSettings): string {
  const files = eventFiles(s.dir);
  const events = files.length ? readEvents(s.dir).length : 0;
  const state = s.enabled ? 'on' : s.off === 'env' ? 'off (SMD_METER=off)' : 'off ("smd meter on" turns it on)';
  return [
    `Token meter: ${state}`,
    `Workspace:   ${s.root}`,
    `Log:         ${s.dir}  (${events} event(s) in ${files.length} file(s), ${(folderBytes(s.dir) / 1024).toFixed(1)} KB)`,
    `Counting:    ${s.tokenizer ?? 'estimate (≈4 characters per token)'} · keeps ${s.retentionDays} days · stops at ${Math.round(s.maxBytes / 1048576)} MB`,
    '',
  ].join('\n');
}

/** What Claude Code sends a PostToolUse hook (the fields used here). */
interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string };
}

/**
 * Record a raw read: the agent read a .smd file with its own tool, so it received the whole file (a partial read with
 * offset/limit is counted whole, which overstates the bypass). Files outside the workspace are ignored.
 */
export function meterHook(input: string, settings: MeterSettings, now = new Date()): MeterEvent | undefined {
  if (!settings.enabled || !input.trim()) return undefined;
  const data = JSON.parse(input) as HookInput;
  const target = data.tool_input?.file_path ?? data.tool_input?.path;
  if (typeof target !== 'string' || !target.toLowerCase().endsWith('.smd')) return undefined;
  const file = path.resolve(data.cwd ?? settings.root, target);
  const rel = path.relative(settings.root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  const counter = meterCounter(settings.tokenizer);
  const tokens = counter.count(text);
  const session = data.session_id ? claudeSession(String(data.session_id)) : 'hook-unknown';
  const event: MeterEvent = {
    v: 1, ts: now.toISOString(), session, client: { name: 'claude-code', via: 'hook' }, op: 'raw-read',
    file: rel.split(path.sep).join('/'), fileHash: fileHash(text),
    tokens: { served: tokens, file: tokens, tokenizer: counter.name }, outcome: 'ok',
  };
  appendEvents(settings, [event], () => undefined);
  return event;
}

// Report text

const n = (x: number) => x.toLocaleString('en-US');
const plural = (x: number, word: string) => `${n(x)} ${word}${x === 1 ? '' : 's'}`;

export function meterReportText(r: MeterReport, settings?: MeterSettings): string {
  if (!r.events) {
    const off = settings && !settings.enabled ? ' Metering is off: "smd meter on" turns it on.' : '';
    return `No agent reads recorded for this period.${off}\n`;
  }
  const k = r.kpis;
  const day = (ts?: string) => ts?.slice(0, 10) ?? '—';
  const share = k.smdShare === null ? 'not measured (no raw-read hook)' : `${k.smdShare}%`;
  const notMeasured = r.clients.filter((c) => c.share === null && c.smdReads).map((c) => c.name);
  const lines = [
    `Token meter · ${day(r.period.from)} to ${day(r.period.to)} · ${methodLabel(r.tokenizers)}`,
    '',
    `Session net savings   ${n(k.sessionNet.saved)} tokens (${k.sessionNet.percent}%) vs ${n(k.sessionNet.baseline)} baseline`,
    `Tokens served         ${n(k.served)} in ${plural(k.reads, 'read')}, ${plural(k.sessions, 'session')}`,
    `Per-read savings      ${n(k.perRead.saved)} (${k.perRead.percent}%), overstates`,
    `smd share             ${share}${notMeasured.length && k.smdShare !== null ? ` · not measured: ${notMeasured.join(', ')}` : ''}`,
    `Targeted reads        ${k.targeted.percent}%   Re-reads ${k.rereads.percent}%`,
  ];
  if (k.byTokenizer) {
    lines.push('', 'By counting method (the period mixes methods):');
    for (const [t, s] of Object.entries(k.byTokenizer)) lines.push(`  ${t.padEnd(12)} ${n(s.saved)} of ${n(s.baseline)} (${s.percent}%)`);
  }
  if (k.sessionNet.saved < 0) lines.push('', 'Agents received more through smd than reading each file once would have cost: see the files below.');
  if (r.files.length) {
    lines.push('', 'Files                                    reads  sessions  baseline    served  saved');
    for (const f of r.files.slice(0, 15)) {
      lines.push(`  ${f.file.padEnd(38).slice(0, 38)} ${String(f.reads).padStart(5)} ${String(f.sessions).padStart(9)} ${n(f.baseline).padStart(9)} ${n(f.served).padStart(9)}  ${f.baseline ? `${f.percent}%` : '—'}`);
    }
  }
  if (r.sections.length) {
    lines.push('', 'Most read sections');
    for (const s of r.sections.slice(0, 10)) lines.push(`  ${String(s.reads).padStart(4)}  ${s.file}#${s.slug}`);
  }
  if (r.clients.length) {
    lines.push('', 'Agents');
    for (const c of r.clients) {
      const raw = c.share === null ? 'raw n/m' : `${c.rawReads} raw, ${c.share}% via smd`;
      lines.push(`  ${c.name.padEnd(14)} ${plural(c.sessions, 'session').padStart(12)} ${plural(c.smdReads, 'read').padStart(11)} ${n(c.served).padStart(9)} served   ${raw}  (${c.via.join(', ')})`);
    }
  }
  lines.push('', 'Session net savings count each file once per session against everything smd sent for it. n/m: not measured.', '');
  return lines.join('\n');
}

// Claude Code hook setup (smd init --agent claude --meter)

export const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/skills/semantic-markdown-reader/scripts/smd.cjs" meter hook';

/**
 * `.claude/settings.json` with a PostToolUse hook on Read that runs `smd meter hook`; other settings and hooks kept.
 * Returns undefined when the hook is already there. Throws when the file isn't a JSON object, so it is never overwritten.
 */
export function mergeClaudeHook(existing: string | undefined): string | undefined {
  let data: Record<string, unknown> = {};
  if (existing?.trim()) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('.claude/settings.json must be a JSON object.');
    data = parsed as Record<string, unknown>;
  }
  const hooks = (data.hooks && typeof data.hooks === 'object' ? data.hooks : {}) as Record<string, unknown>;
  const post = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse as Array<Record<string, unknown>> : [];
  const present = post.some((m) => Array.isArray(m.hooks) && (m.hooks as Array<Record<string, unknown>>).some((h) => typeof h.command === 'string' && h.command.includes(' meter hook')));
  if (present) return undefined;
  post.push({ matcher: 'Read', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] });
  data.hooks = { ...hooks, PostToolUse: post };
  return JSON.stringify(data, null, 2) + '\n';
}

/** Install the hook and turn metering on in `root`. Prints what it changed. */
export function installMeterHook(root: string): number {
  const file = path.join(root, '.claude', 'settings.json');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  let content: string | undefined;
  try {
    content = mergeClaudeHook(existing);
  } catch (e) {
    console.error(`${(e as Error).message.replace(/^Unexpected.*/, '.claude/settings.json is not plain JSON')} Left it alone. Add this PostToolUse hook yourself:\n`
      + JSON.stringify({ matcher: 'Read', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] }, null, 2));
    return 1;
  }
  if (content === undefined) {
    console.log(`Unchanged ${file}  (token meter hook already there)`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`${existing === undefined ? 'Created' : 'Updated'} ${file}  (PostToolUse hook on Read: records raw reads of .smd files for the token meter)`);
  }
  const config = setMeterConfig(root, true);
  console.log(`Token metering is on ("meter" in ${path.relative(root, config) || config}). Events go to .smd/meter/, ignored by Git; "smd meter off" turns it off.`);
  return 0;
}

/** For the extension: record a person's copy of a view for an agent. Never throws. */
export function recordEditorCopy(root: string, file: string, served: string, session: string, force: boolean): void {
  try {
    const settings = meterSettings(root, { force });
    if (!settings.enabled) return;
    beginMeterCall();
    const call = endMeterCall()!;
    call.notes.push({ file, op: 'copy' });
    recordCall(call, { settings, session, served, client: { name: 'vscode', via: 'editor' } });
  } catch {
    // The copy already happened; the meter never gets in its way.
  }
}
