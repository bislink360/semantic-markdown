import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Sandbox, smdTools } from '../../src/mcp';
import { ABLATIONS, ablatedForRead, renderContext, renderDoc, smdRead, type Ablation, type RenderContext, type Rendered, type SmdReadArgs } from './conditions';
import { estimate, loadCorpus, type Corpus, type CorpusDoc } from './corpus';
import { MD_READ_DESCRIPTION, MD_READ_SCHEMA, mdRead, type MdReadArgs } from './mdTool';
import { parseAnswer, SYSTEM_PROMPT, toolMessage, wholeTextMessage } from './prompts';
import { parseAnswers } from './score';
import type { AnswerRecord, Task } from './types';

/**
 * `run`: the model runner. It runs tasks × conditions × runs against models through a Chat Completions-compatible
 * HTTP API (`POST {baseUrl}/chat/completions` with a bearer key), which most providers offer, so no provider is named
 * in the code. Keys are read only from the environment variable each model names, and are never printed, logged or
 * written. Every other command of the harness sends nothing anywhere.
 */

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** Conditions that put the rendered text in the user message. */
export const WHOLE_TEXT_CONDITIONS = ['M1', 'S1', 'S2', 'S4-brief', 'S4-budget', 'O', 'S2.all-audiences', 'S2.plain-blocks', 'S2.no-agent-block'] as const;
/** Conditions where the model reads with the tool: M2, S3 and the S3 ablations. */
export const TOOL_CONDITIONS = ['M2', 'S3', ...ABLATIONS.map((a) => `S3.${a}`)] as const;
/** Every condition `run` accepts, in the default order. */
export const RUN_CONDITIONS: readonly string[] = ['M1', 'M2', 'S1', 'S2', 'S3', 'S4-brief', 'S4-budget', 'O', ...WHOLE_TEXT_CONDITIONS.slice(6), ...TOOL_CONDITIONS.slice(2)];

const isToolCondition = (c: string) => (TOOL_CONDITIONS as readonly string[]).includes(c);
const formatOf = (c: string): 'md' | 'smd' => (c.startsWith('M') ? 'md' : 'smd');
const fileOf = (c: string) => (formatOf(c) === 'md' ? 'doc.md' : 'doc.smd');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ModelConfig {
  /** A short name for paths and records, e.g. `model-a`. */
  label: string;
  /** The provider's pinned model id. */
  model: string;
  /** The API root; requests go to `{baseUrl}/chat/completions`. */
  baseUrl: string;
  /** The environment variable that holds the key. The key itself never goes in the config. */
  apiKeyEnv: string;
  /** The output limit sent with every request (default 1024), the same for every condition. */
  maxOutputTokens?: number;
  /** The request field for the output limit (default `max_tokens`; some APIs want `max_completion_tokens`). */
  outputLimitField?: string;
  /** Prices per million tokens, for the dry-run estimate only. */
  price?: { inputPerMTok: number; outputPerMTok: number };
  /** Send a run-dependent `seed` (only when the API supports it). */
  sendSeed?: boolean;
  /** Other request fields, sent as given (never temperature: the protocol keeps the provider default). */
  extraBody?: Record<string, unknown>;
  /** Per request (default: the run config's, else 120000). */
  timeoutMs?: number;
}

export interface RunConfig {
  models: ModelConfig[];
  /** Runs per task and condition (default 5). */
  runs?: number;
  /** Default: every condition in RUN_CONDITIONS. */
  conditions?: string[];
  /** Base of the run seeds (default 1); run n sends seed × 1000 + n when the model has `sendSeed`. */
  seed?: number;
  /** Tool calls a model may make per answer (default 8). */
  maxToolCalls?: number;
  /** Requests at the same time (default 2). */
  concurrency?: number;
  /** Retries on 429, 5xx, timeouts and network errors (default 5). */
  retries?: number;
  /** Per request (default 120000). */
  timeoutMs?: number;
}

export const DEFAULTS = { runs: 5, seed: 1, maxToolCalls: 8, concurrency: 2, retries: 5, timeoutMs: 120_000, maxOutputTokens: 1024, outputLimitField: 'max_tokens' };

const SECRET_KEY = /^(api[-_]?key|key|token|secret|password|authorization|headers?)$/i;
/** Fields the runner sets itself, so extraBody may not set them. */
const RESERVED_BODY = new Set(['model', 'messages', 'tools', 'tool_choice', 'seed', 'temperature', 'stream']);

/** Checks a run config; throws on anything that could leak a key or break the protocol. */
export function checkConfig(config: RunConfig): RunConfig {
  if (!config || !Array.isArray(config.models) || !config.models.length) throw new Error('run config: "models" must list at least one model');
  const labels = new Set<string>();
  const walk = (value: unknown, at: string) => {
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) throw new Error(`run config: ${at}${k} looks like a secret. Put the key in the environment variable that "apiKeyEnv" names, never in the config.`);
      walk(v, `${at}${k}.`);
    }
  };
  walk(config, '');
  for (const m of config.models) {
    for (const f of ['label', 'model', 'baseUrl', 'apiKeyEnv'] as const) if (typeof m[f] !== 'string' || !m[f].trim()) throw new Error(`run config: every model needs "${f}"`);
    if (!/^[\w.-]+$/.test(m.label)) throw new Error(`run config: label "${m.label}" may only use letters, digits, ".", "_" and "-"`);
    if (labels.has(m.label)) throw new Error(`run config: label "${m.label}" is used twice`);
    labels.add(m.label);
    if (!/^https?:\/\//.test(m.baseUrl)) throw new Error(`run config: baseUrl of ${m.label} must start with http:// or https://`);
    if (!/^[A-Za-z_]\w*$/.test(m.apiKeyEnv)) throw new Error(`run config: apiKeyEnv of ${m.label} must be an environment variable name`);
    for (const k of Object.keys(m.extraBody ?? {})) if (RESERVED_BODY.has(k)) throw new Error(`run config: extraBody of ${m.label} may not set "${k}"`);
  }
  for (const c of config.conditions ?? []) checkCondition(c);
  return config;
}

function checkCondition(c: string): void {
  if (RUN_CONDITIONS.includes(c)) return;
  if (/oracle|outline/.test(c)) throw new Error(`condition ${c} is an offline render (npm run eval -- render); run uses the model-choice versions M2 and S3`);
  throw new Error(`unknown condition ${c}; run takes ${RUN_CONDITIONS.join(', ')}`);
}

const modelName = (m: ModelConfig) => `${m.label}:${m.model}`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** A tool definition as Chat Completions takes it. */
export interface ToolDef { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }

/** The MCP `read` tool's own description and schema, so S conditions get exactly what an MCP client lists. */
function mcpReadTool(root: string): ToolDef {
  const read = smdTools(new Sandbox(root)).find((t) => t.name === 'read')!;
  return { type: 'function', function: { name: 'read', description: read.description, parameters: read.inputSchema as unknown as Record<string, unknown> } };
}

export const MD_READ_TOOL: ToolDef = { type: 'function', function: { name: 'read', description: MD_READ_DESCRIPTION, parameters: MD_READ_SCHEMA as unknown as Record<string, unknown> } };

/** What the tool says in a whole-text condition, where the document is already in the message. */
export const INERT_RESULT = 'The whole document is already in the message. This tool has nothing more to give.';
export const LIMIT_RESULT = (n: number) => `Error: the tool call limit (${n}) is reached. Answer now with the JSON object.`;

/** Checks call arguments against a tool's JSON schema (the types the read schemas use); an error text, or undefined. */
export function checkArgs(schema: Record<string, unknown>, args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be a JSON object';
  const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: string[]; items?: { type?: string } }>;
  for (const k of (schema.required ?? []) as string[]) if (!(k in args)) return `missing "${k}"`;
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) return `unknown argument "${k}"`;
    const ok = (type: string | undefined, x: unknown) =>
      type === 'string' ? typeof x === 'string' : type === 'boolean' ? typeof x === 'boolean' : type === 'integer' ? Number.isInteger(x) : true;
    if (p.type === 'array') {
      if (!Array.isArray(v) || !v.every((x) => ok(p.items?.type, x))) return `"${k}" must be an array of ${p.items?.type ?? 'values'}`;
    } else if (!ok(p.type, v)) return `"${k}" must be ${p.type}`;
    if (p.enum && !p.enum.includes(v as string)) return `"${k}" must be one of ${p.enum.join(', ')}`;
  }
  return undefined;
}

const sameFile = (asked: unknown, file: string) => typeof asked === 'string' && asked.replace(/^\.\//, '') === file;

/** One condition of one task, ready to send: the user message, the tool and what the tool does. */
export interface Setup {
  condition: string;
  format: 'md' | 'smd';
  file: string;
  usesTool: boolean;
  tool: ToolDef;
  user: string;
  /** Runs one call of the tool; errors come back as `Error: …` text, as a tool result would. */
  execute: (args: unknown) => string;
}

export class Conditions {
  private readonly smdTool: ToolDef;
  private readonly renders = new Map<string, { doc: Map<string, Rendered>; tasks: Map<string, Map<string, Rendered>>; ctx: RenderContext }>();

  constructor(private readonly corpus: Corpus) {
    this.smdTool = mcpReadTool(corpus.dir);
  }

  /** The tool definition a format's conditions get. */
  toolFor(condition: string): ToolDef {
    return formatOf(condition) === 'md' ? MD_READ_TOOL : this.smdTool;
  }

  private rendered(doc: CorpusDoc) {
    let r = this.renders.get(doc.name);
    if (!r) {
      const out = renderDoc(this.corpus, doc);
      r = {
        doc: new Map(out.doc.map((x) => [x.condition, x])),
        tasks: new Map([...out.tasks].map(([id, list]) => [id, new Map(list.map((x) => [x.condition, x]))])),
        ctx: renderContext(this.corpus, doc),
      };
      this.renders.set(doc.name, r);
    }
    return r;
  }

  setup(doc: CorpusDoc, task: Task, condition: string): Setup {
    checkCondition(condition);
    const file = fileOf(condition);
    const tool = this.toolFor(condition);
    const base = { condition, format: formatOf(condition), file, tool };
    const r = this.rendered(doc);
    if (!isToolCondition(condition)) {
      const shown = (condition === 'O' ? r.tasks.get(task.id)?.get('O') : r.doc.get(condition))?.shown;
      if (shown === undefined) throw new Error(`no render of ${condition} for ${doc.name}/${task.id}`);
      return { ...base, usesTool: false, user: wholeTextMessage(file, shown, task), execute: () => INERT_RESULT };
    }
    const schema = tool.function.parameters;
    const guard = (args: unknown, run: (a: Record<string, unknown>) => string) => {
      const problem = checkArgs(schema, args);
      if (problem) return `Error: ${problem}.`;
      const a = args as Record<string, unknown>;
      if (!sameFile(a.file, file)) return `Error: Not found: ${String(a.file)}`;
      try { return run(a); } catch (e) { return `Error: ${(e as Error).message}`; }
    };
    if (condition === 'M2') return { ...base, usesTool: true, user: toolMessage(file, task), execute: (args) => guard(args, (a) => mdRead(doc.md, { ...(a as unknown as MdReadArgs), file })) };
    const ablation = condition.includes('.') ? condition.split('.')[1] as Ablation : undefined;
    return {
      ...base, usesTool: true, user: toolMessage(file, task),
      execute: (args) => guard(args, (a) => {
        const readArgs = a as SmdReadArgs;
        const source = ablatedForRead(doc.smd, ablation, readArgs);
        return smdRead(source.text, readArgs, r.ctx, source.includeHuman);
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

export interface RunDeps {
  fetch: FetchLike;
  env: Record<string, string | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (s: string) => void;
  /** The tool's commit and whether the working tree had changes; null outside a repository. */
  commit: () => { commit: string; dirty: boolean } | null;
}

export function defaultDeps(log: (s: string) => void = (s) => process.stdout.write(s)): RunDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    log,
    commit: () => {
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' });
      if (head.status !== 0) return null;
      const status = spawnSync('git', ['status', '--porcelain'], { cwd: __dirname, encoding: 'utf8' });
      return { commit: head.stdout.trim(), dirty: !!status.stdout?.trim() };
    },
  };
}

/** A failed request: the status (0 for network errors and timeouts) and whether trying again may help. */
export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) { super(message); }
}

/** Removes a key, and any bearer token, from a text before it is logged or written. */
export function redact(text: string, key: string | undefined): string {
  let out = text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  if (key) out = out.split(key).join('[redacted]');
  return out;
}

const retryableStatus = (s: number) => s === 408 || s === 409 || s === 429 || s >= 500;

/** Backoff before retry `attempt` (0-based): Retry-After when the server gives one (up to a minute), else 1 s, 2 s, 4 s … up to 32 s. */
export function backoff(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  return Math.min(32_000, 1000 * 2 ** attempt);
}

interface Posted { json: Record<string, any>; status: number; attempts: number; latencyMs: number }

async function post(url: string, key: string, body: unknown, opts: { timeoutMs: number; retries: number }, deps: RunDeps): Promise<Posted> {
  const started = deps.now().getTime();
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let error: RequestError;
    let retryAfter: string | null = null;
    try {
      const res = await deps.fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: controller.signal,
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return { json: JSON.parse(text), status: res.status, attempts: attempt + 1, latencyMs: deps.now().getTime() - started };
        } catch {
          throw new RequestError(`HTTP ${res.status}: the response is not JSON: ${redact(text.slice(0, 300), key)}`, res.status, false);
        }
      }
      retryAfter = res.headers.get('retry-after');
      error = new RequestError(`HTTP ${res.status}: ${redact(text.slice(0, 500), key)}`, res.status, retryableStatus(res.status));
    } catch (e) {
      if (e instanceof RequestError) throw e;
      const aborted = (e as Error).name === 'AbortError';
      error = new RequestError(redact(aborted ? `timed out after ${opts.timeoutMs} ms` : `network error: ${(e as Error).message}`, key), 0, true);
    } finally {
      clearTimeout(timer);
    }
    if (!error.retryable || attempt >= opts.retries) throw new RequestError(`${error.message}${attempt ? ` (after ${attempt + 1} attempts)` : ''}`, error.status, false);
    await deps.sleep(backoff(attempt, retryAfter));
  }
}

// ---------------------------------------------------------------------------
// One answer
// ---------------------------------------------------------------------------

export interface Job { model: ModelConfig; doc: CorpusDoc; task: Task; condition: string; run: number; seed?: number }

export interface RecordedCall { id: string; name: string; arguments: unknown; result: string; executed: boolean }

export interface Transcript {
  model: { label: string; id: string; baseUrl: string };
  doc: string; task: string; condition: string; run: number; seed?: number;
  startedAt: string; finishedAt?: string;
  /** The request settings besides the messages (the same in every request of the answer). */
  request: Record<string, unknown>;
  messages: unknown[];
  toolCalls: RecordedCall[];
  /** Per request: the provider's response metadata, finish reason and usage. */
  responses: unknown[];
  usage: Record<string, number>;
  final?: string;
  record?: AnswerRecord;
  error?: string;
}

/** Adds a provider usage object into a running total: numbers summed, nested objects flattened as `a.b`. */
export function addUsage(total: Record<string, number>, usage: unknown, prefix = ''): void {
  if (!usage || typeof usage !== 'object') return;
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === 'number') total[prefix + k] = (total[prefix + k] ?? 0) + v;
    else if (v && typeof v === 'object') addUsage(total, v, `${prefix}${k}.`);
  }
}

const contentText = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('') : '';

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return raw; }
}

export interface Settings { maxToolCalls: number; retries: number; timeoutMs: number }

/** Asks one question: sends the conversation, runs the tool for each call, until the model answers. */
export async function answerJob(job: Job, setup: Setup, key: string, settings: Settings, deps: RunDeps): Promise<Transcript> {
  const m = job.model;
  const url = `${m.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const request: Record<string, unknown> = {
    model: m.model, tools: [setup.tool], [m.outputLimitField ?? DEFAULTS.outputLimitField]: m.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    ...(job.seed !== undefined ? { seed: job.seed } : {}), ...(m.extraBody ?? {}),
  };
  const messages: any[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: setup.user }];
  const t: Transcript = {
    model: { label: m.label, id: m.model, baseUrl: m.baseUrl }, doc: job.doc.name, task: job.task.id, condition: job.condition, run: job.run,
    ...(job.seed !== undefined ? { seed: job.seed } : {}), startedAt: deps.now().toISOString(), request, messages, toolCalls: [], responses: [], usage: {},
  };
  let executed = 0;
  let overLimit = false;
  let error: string | undefined;
  let final = '';
  for (;;) {
    const res = await post(url, key, { ...request, messages }, { timeoutMs: m.timeoutMs ?? settings.timeoutMs, retries: settings.retries }, deps);
    const choice = res.json.choices?.[0];
    t.responses.push({
      id: res.json.id, model: res.json.model, created: res.json.created, system_fingerprint: res.json.system_fingerprint,
      finish_reason: choice?.finish_reason, usage: res.json.usage, status: res.status, attempts: res.attempts, latencyMs: res.latencyMs,
    });
    addUsage(t.usage, res.json.usage);
    const message = choice?.message;
    if (!message) throw new RequestError('the response has no message', res.status, false);
    const calls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      final = contentText(message.content);
      messages.push({ role: 'assistant', content: final });
      break;
    }
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
    if (overLimit) {
      // It was told the limit is reached and called again: stop, recording the calls it made.
      error = 'tool-limit';
      for (const call of calls) t.toolCalls.push({ id: String(call.id ?? ''), name: String(call.function?.name), arguments: parseArguments(call.function?.arguments), result: '', executed: false });
      break;
    }
    for (const call of calls) {
      const name = call.function?.name;
      const args = parseArguments(call.function?.arguments);
      let result: string;
      let ran = false;
      if (executed >= settings.maxToolCalls) { result = LIMIT_RESULT(settings.maxToolCalls); overLimit = true; }
      else if (name !== setup.tool.function.name) result = `Error: unknown tool ${String(name)}. The only tool is ${setup.tool.function.name}.`;
      else if (typeof args === 'string') result = 'Error: the arguments are not valid JSON.';
      else { result = setup.execute(args); executed++; ran = true; }
      t.toolCalls.push({ id: String(call.id ?? ''), name: String(name), arguments: args, result, executed: ran });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  const parsed = error ? { answer: final, error } : parseAnswer(final);
  t.final = final;
  t.record = {
    task: job.task.id, doc: job.doc.name, condition: job.condition, run: job.run, ...(job.seed !== undefined ? { seed: job.seed } : {}),
    model: modelName(m), ...parsed, usage: { ...t.usage, requests: t.responses.length }, toolCalls: t.toolCalls.length,
  };
  t.finishedAt = deps.now().toISOString();
  return t;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
  corpusDir: string;
  config: RunConfig;
  out: string;
  dryRun?: boolean;
  docs?: string[];
  tasks?: string[];
  conditions?: string[];
  runs?: number;
  /** At most this many new answers in this invocation. */
  limit?: number;
  concurrency?: number;
  /** The config file, for the manifest. */
  configFile?: string;
}

export interface RunSummary { planned: number; skipped: number; attempted: number; answered: number; failed: number; dryRun: boolean }

const jobKey = (model: string, doc: string, task: string, condition: string, run: number | string) => [model, doc, task, condition, String(run)].join('\u0000');
const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');

export function transcriptPath(out: string, job: Pick<Job, 'model' | 'task' | 'condition' | 'run'>): string {
  return path.join(out, 'transcripts', safe(job.model.label), safe(job.task.id), safe(job.condition), `run-${job.run}.json`);
}

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The jobs of a run, model by model, then run by run, so a partial run (--limit) covers conditions evenly. */
export function planJobs(corpus: Corpus, config: RunConfig, options: Omit<RunOptions, 'corpusDir' | 'config' | 'out'>): Job[] {
  const conditions = options.conditions ?? config.conditions ?? [...RUN_CONDITIONS];
  conditions.forEach(checkCondition);
  const runs = options.runs ?? config.runs ?? DEFAULTS.runs;
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a whole number of at least 1');
  const known = new Set(corpus.docs.map((d) => d.name));
  for (const d of options.docs ?? []) if (!known.has(d)) throw new Error(`no document ${d} in the corpus`);
  const docs = corpus.docs.filter((d) => !options.docs || options.docs.includes(d.name));
  const taskIds = new Set(corpus.docs.flatMap((d) => d.tasks.map((t) => t.id)));
  for (const t of options.tasks ?? []) if (!taskIds.has(t)) throw new Error(`no task ${t} in the corpus`);
  const jobs: Job[] = [];
  for (const model of config.models) {
    for (let run = 1; run <= runs; run++) {
      const seed = model.sendSeed ? (config.seed ?? DEFAULTS.seed) * 1000 + run : undefined;
      for (const doc of docs) {
        for (const task of doc.tasks) {
          if (options.tasks && !options.tasks.includes(task.id)) continue;
          for (const condition of conditions) jobs.push({ model, doc, task, condition, run, ...(seed !== undefined ? { seed } : {}) });
        }
      }
    }
  }
  return jobs;
}

function doneKeys(file: string): Set<string> {
  if (!fs.existsSync(file)) return new Set();
  const { records } = parseAnswers(fs.readFileSync(file, 'utf8'));
  return new Set(records.map((r) => jobKey(r.model ?? '', r.doc ?? '', r.task, r.condition, r.run)));
}

function extensionVersion(): string | null {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

const usd = (x: number) => `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`;

/** The dry run: the plan, estimated tokens and cost, and the first request body of each model and condition. Sends nothing. */
function dryRun(jobs: Job[], skipped: number, conds: Conditions, out: string, deps: RunDeps): void {
  const rows = new Map<string, { model: ModelConfig; condition: string; calls: number; tokens: number; tool: boolean }>();
  const samples: string[] = [];
  for (const job of jobs) {
    const setup = conds.setup(job.doc, job.task, job.condition);
    const key = `${job.model.label}\u0000${job.condition}`;
    const row = rows.get(key) ?? { model: job.model, condition: job.condition, calls: 0, tokens: 0, tool: setup.usesTool };
    row.calls++;
    row.tokens += estimate(SYSTEM_PROMPT + setup.user + JSON.stringify([setup.tool]));
    if (!rows.has(key)) {
      const m = job.model;
      const body = {
        model: m.model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: setup.user }], tools: [setup.tool],
        [m.outputLimitField ?? DEFAULTS.outputLimitField]: m.maxOutputTokens ?? DEFAULTS.maxOutputTokens, ...(job.seed !== undefined ? { seed: job.seed } : {}), ...(m.extraBody ?? {}),
      };
      const file = path.join(out, 'dry-run', safe(m.label), `${safe(job.condition)}.${safe(job.task.id)}.run-${job.run}.json`);
      writeFile(file, JSON.stringify({ url: `${m.baseUrl.replace(/\/+$/, '')}/chat/completions`, note: 'The Authorization header is left out.', body }, null, 2) + '\n');
      samples.push(file);
    }
    rows.set(key, row);
  }
  const lines = [
    'Dry run: nothing is sent and no key is read.',
    `${jobs.length} request(s) to make${skipped ? `, ${skipped} already in answers.jsonl` : ''}.`,
    'Input tokens are estimates (≈ characters / 4) of the first request of each answer. For tool conditions (M2, S3) the model reads more and every later request repeats the conversation, so their tokens and cost are lower bounds.',
    '',
  ];
  const plan: unknown[] = [];
  for (const model of new Set([...rows.values()].map((r) => r.model))) {
    const own = [...rows.values()].filter((r) => r.model === model);
    const price = model.price;
    lines.push(`## ${model.label} (${model.model})`, '', '| condition | requests | est. input tokens | est. cost |', '|-|-|-|-|');
    let low = 0;
    let high = 0;
    let toolLow = 0;
    for (const r of own) {
      const maxOut = model.maxOutputTokens ?? DEFAULTS.maxOutputTokens;
      const inCost = price ? (r.tokens * price.inputPerMTok) / 1e6 : 0;
      const outMax = price ? (r.calls * maxOut * price.outputPerMTok) / 1e6 : 0;
      if (r.tool) toolLow += inCost;
      else { low += inCost; high += inCost + outMax; }
      const cost = !price ? '-' : r.tool ? `≥ ${usd(inCost)} (lower bound)` : `${usd(inCost)} – ${usd(inCost + outMax)}`;
      lines.push(`| ${r.condition} | ${r.calls} | ${r.tool ? '≥ ' : ''}${r.tokens} | ${cost} |`);
      plan.push({ model: model.label, condition: r.condition, requests: r.calls, inputTokensEstimate: r.tokens, lowerBound: r.tool, ...(price ? { costEstimate: r.tool ? { atLeast: inCost } : { low: inCost, high: inCost + outMax } } : {}) });
    }
    const total = own.reduce((s, r) => s + r.calls, 0);
    lines.push('', `Total: ${total} request(s)${price ? `, est. cost ${usd(low)} – ${usd(high)} for whole-text conditions${own.some((r) => r.tool) ? ` and ≥ ${usd(toolLow)} (lower bound) for tool conditions` : ''}` : ''}.`, '');
  }
  lines.push(`Wrote ${samples.length} request bodies to ${path.join(out, 'dry-run')}`);
  writeFile(path.join(out, 'dry-run', 'plan.json'), JSON.stringify({ estimates: 'characters / 4, not provider usage', skipped, rows: plan }, null, 2) + '\n');
  deps.log(lines.join('\n') + '\n');
}

async function pool<T>(items: T[], size: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

/** Runs (or, with dryRun, plans) every job not yet in `<out>/answers.jsonl`. */
export async function runEval(options: RunOptions, deps: RunDeps): Promise<RunSummary> {
  const config = checkConfig(options.config);
  const corpus = loadCorpus(options.corpusDir);
  if (corpus.problems.length) throw new Error(`the corpus has problems (run validate): ${corpus.problems.map((p) => `${p.doc}: ${p.message}`).join('; ')}`);
  const answersFile = path.join(options.out, 'answers.jsonl');
  const done = doneKeys(answersFile);
  const all = planJobs(corpus, config, options);
  const pending = all.filter((j) => !done.has(jobKey(modelName(j.model), j.doc.name, j.task.id, j.condition, j.run)));
  const skipped = all.length - pending.length;
  const jobs = options.limit !== undefined ? pending.slice(0, Math.max(0, options.limit)) : pending;
  const conds = new Conditions(corpus);
  if (options.dryRun) {
    dryRun(jobs, skipped, conds, options.out, deps);
    return { planned: all.length, skipped, attempted: 0, answered: 0, failed: 0, dryRun: true };
  }
  const keys = new Map<string, string>();
  for (const m of new Set(jobs.map((j) => j.model))) {
    const key = deps.env[m.apiKeyEnv];
    if (!key) throw new Error(`model ${m.label}: the environment variable ${m.apiKeyEnv} is not set. Set it to the provider's key (it is never written anywhere), or use --dry-run.`);
    keys.set(m.label, key);
  }
  const settings: Settings = {
    maxToolCalls: config.maxToolCalls ?? DEFAULTS.maxToolCalls, retries: config.retries ?? DEFAULTS.retries, timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
  };
  const manifestFile = path.join(options.out, 'run-manifest.json');
  const previous = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : undefined;
  const invocation: Record<string, unknown> = {
    started: deps.now().toISOString(), tool: deps.commit(), extensionVersion: extensionVersion(), node: process.version,
    filters: { docs: options.docs ?? null, tasks: options.tasks ?? null, conditions: options.conditions ?? null, runs: options.runs ?? null, limit: options.limit ?? null },
  };
  const conditions = options.conditions ?? config.conditions ?? [...RUN_CONDITIONS];
  const writeManifest = (summary?: RunSummary) => writeFile(manifestFile, JSON.stringify({
    corpus: corpus.dir, corpusVersion: corpus.config.version ?? null, today: corpus.config.today ?? null, configFile: options.configFile ?? null,
    config, conditions, settings,
    systemPrompt: SYSTEM_PROMPT,
    tools: { md: MD_READ_TOOL, smd: conds.toolFor('S3') },
    notes: [
      'Every condition gets the same system prompt, one tool named "read" and the same output limit. In whole-text conditions the tool is inert; M conditions get the M2 tool definition, S conditions the MCP read definition.',
      'S3 runs MCP read as the server does: the model picks the mode, and without one it is auto.',
      'Temperature is not sent (provider default). A seed is sent only for models with sendSeed.',
      'Token counts in answers.jsonl are provider usage summed over the requests of each answer.',
    ],
    invocations: [...(previous?.invocations ?? []), { ...invocation, ...(summary ? { finished: deps.now().toISOString(), counts: summary } : {}) }],
  }, null, 2) + '\n');
  writeManifest();
  const summary: RunSummary = { planned: all.length, skipped, attempted: 0, answered: 0, failed: 0, dryRun: false };
  fs.mkdirSync(options.out, { recursive: true });
  await pool(jobs, options.concurrency ?? config.concurrency ?? DEFAULTS.concurrency, async (job, i) => {
    summary.attempted++;
    const key = keys.get(job.model.label)!;
    const where = `[${i + 1}/${jobs.length}] ${job.model.label} ${job.task.id} ${job.condition} run ${job.run}`;
    const startedAt = deps.now().toISOString();
    try {
      const t = await answerJob(job, conds.setup(job.doc, job.task, job.condition), key, settings, deps);
      writeFile(transcriptPath(options.out, job), redact(JSON.stringify(t, null, 2), key) + '\n');
      fs.appendFileSync(answersFile, redact(JSON.stringify(t.record), key) + '\n');
      summary.answered++;
      const u = t.record!.usage ?? {};
      deps.log(`${where}: ${t.record!.error ? `answered (${t.record!.error})` : 'answered'}, ${t.toolCalls.length} tool call(s), usage in ${u.prompt_tokens ?? '-'} out ${u.completion_tokens ?? '-'}\n`);
    } catch (e) {
      summary.failed++;
      const message = redact((e as Error).message, key);
      writeFile(transcriptPath(options.out, job), JSON.stringify({
        model: { label: job.model.label, id: job.model.model }, doc: job.doc.name, task: job.task.id, condition: job.condition, run: job.run, startedAt, error: message,
      }, null, 2) + '\n');
      fs.appendFileSync(path.join(options.out, 'errors.jsonl'), JSON.stringify({
        at: deps.now().toISOString(), model: modelName(job.model), doc: job.doc.name, task: job.task.id, condition: job.condition, run: job.run, error: message,
      }) + '\n');
      deps.log(`${where}: failed: ${message}\n`);
    }
  });
  writeManifest(summary);
  deps.log(`${summary.answered} answered, ${summary.failed} failed, ${summary.skipped} already in answers.jsonl. Answers: ${answersFile}\n`);
  return summary;
}
