import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  agentView, outline, parseSelector, queryView, SelectorError, withheldMatches, type Diagnostic, type MeterOp, type ResolvedSection, type Selector,
} from './core';
import { loadRuleConfig, type LoadedConfig } from './config';
import { loadMermaidParser } from './mermaidLoader';
import { meterSettings } from './meter/log';
import { beginMeterCall, endMeterCall, newSessionId, noteAccess, recordCall } from './meter/record';
import { McpServer, serveLines, ToolError, type McpMeter, type McpTool, type ToolInputSchema } from './mcpProtocol';
import { revisionOf, suggestTool, writeTools } from './mcpWrite';
import { contractSummary, contractText, withheldNote } from './queryCommand';
import { readDocument, READ_BUDGET, READ_MODES, type ReadMode } from './readView';
import { collect, diagnose, isInside, queryRows, querySummary, queryText, read, readerFor, taskLine, taskRows, taskSummary } from './workspace';

/**
 * `smd mcp`: the reading tools of the CLI as a Model Context Protocol server, so agents can query .smd
 * documents without shell access. Every path is resolved against the root folder; paths outside it
 * (including through symbolic links) are refused, and only .smd files are read.
 */

export interface McpServerSettings {
  /** Folder that paths are resolved against; nothing outside it is read. */
  root: string;
  /** `off`: every read shows a pointer instead of the :::agent blocks of included files (4.1.0, a host setting). */
  includedInstructions?: 'carry' | 'off';
  version: string;
  /** List the 1.x reading tools (outline, section, agent) too. */
  legacyTools?: boolean;
  /** Add the write tools (check_task, set_status, add_decision). */
  allowWrite?: boolean;
  /** Add the `suggest` tool, which proposes changes as `:::suggestion` blocks. */
  allowSuggest?: boolean;
}

/** Paths inside one folder, resolved and checked. */
export class Sandbox {
  readonly root: string;
  private readonly realRoot: string;
  /** View options the host fixed when it started the server, applied to every read. */
  readonly view: { includedInstructions?: 'carry' | 'off' };

  constructor(root: string, view: { includedInstructions?: 'carry' | 'off' } = {}) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpathSync(this.root);
    this.view = view;
  }

  /** An existing file or folder inside the root. Throws a ToolError otherwise. */
  resolve(p: string): string {
    const target = path.resolve(this.root, p);
    if (!isInside(this.root, target)) throw new ToolError(`Path is outside the root folder (${this.root}): ${p}`);
    if (!fs.existsSync(target)) throw new ToolError(`Not found: ${p}`);
    if (!isInside(this.realRoot, fs.realpathSync(target))) throw new ToolError(`Path is outside the root folder (${this.root}): ${p}`);
    return target;
  }

  /** One .smd file inside the root. */
  document(p: string): string {
    const file = this.resolve(p);
    if (!fs.statSync(file).isFile() || !file.endsWith('.smd')) throw new ToolError(`Not a .smd file: ${p}`);
    return file;
  }

  /** The .smd files in these files and folders (default: the whole root). */
  documents(paths: string[] | undefined): string[] {
    const targets = paths?.length ? paths : ['.'];
    const files = targets.flatMap((p) => collect(this.resolve(p))).filter((f) => this.contains(f));
    if (!files.length) throw new ToolError(`No .smd files found in: ${targets.join(', ')}`);
    return [...new Set(files)];
  }

  /** `docs/plan.smd`: a path relative to the root, with forward slashes. */
  name(file: string): string {
    return path.relative(this.root, file).split(path.sep).join('/') || '.';
  }

  /** Reader for code embeds and includes: only files inside the root, also after following links (see readerFor). */
  reader(file: string): (rel: string) => string | undefined {
    return readerFor(file, [this.root, this.realRoot]);
  }

  private contains(file: string): boolean {
    return file.endsWith('.smd') && isInside(this.realRoot, fs.realpathSync(file));
  }
}

const FILE = { type: 'string', description: 'Path of a .smd file, relative to the root folder.' } as const;
const PATHS = { type: 'array', items: { type: 'string' }, description: 'Files/folders; default all.' } as const;
const BRIEF = { type: 'boolean', description: 'Condense diagrams, long code, done tasks.' } as const;
const SHORT_BRIEF = { type: 'boolean', description: 'Condense long blocks.' } as const;
/** The 2.5 tools: short descriptions, since every session pays for tools/list. */
const SHORT_FILE = { type: 'string', description: 'Path under the root.' } as const;

function schema(properties: ToolInputSchema['properties'], required: string[] = []): ToolInputSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_ONLY_SHORT = { readOnlyHint: true };

export interface SmdToolOptions {
  /** List the 1.x tools outline, section and agent too (they can always be called). */
  legacyTools?: boolean;
  /** Add the write tools check_task, set_status and add_decision. */
  allowWrite?: boolean;
  /** Add the `suggest` tool. */
  allowSuggest?: boolean;
}

/** The tools, reading from `box`: read, tasks, query and validate, then the older reading tools (hidden unless asked for). */
export function smdTools(box: Sandbox, options: SmdToolOptions = {}): McpTool[] {
  const tool = (t: Omit<McpTool, 'annotations'>): McpTool => ({ ...t, annotations: READ_ONLY_SHORT });
  const legacy = (t: Omit<McpTool, 'annotations' | 'hidden'>): McpTool => ({ ...t, annotations: READ_ONLY, hidden: !options.legacyTools });
  return [
    tool({
      name: 'read',
      description: `Agent view of a .smd file ([L12] = line): whole if ≤maxTokens (${READ_BUDGET}), else outline; then pass sections.`,
      inputSchema: schema({
        file: SHORT_FILE,
        sections: { type: 'array', items: { type: 'string' }, description: 'Heading texts or ids.' },
        exact: { type: 'boolean', description: 'Whole title/id.' },
        mode: { type: 'string', enum: READ_MODES },
        maxTokens: { type: 'integer' },
        brief: SHORT_BRIEF,
      }, ['file']),
      run: (args) => readTool(box, args, options.allowWrite || options.allowSuggest),
    }),
    tool({
      name: 'tasks',
      description: 'Open tasks (owner, priority, due), overdue first.',
      inputSchema: schema({
        paths: PATHS,
        all: { type: 'boolean', description: 'Include done tasks.' },
        mine: { type: 'string', description: 'Owner, e.g. @maya.' },
      }),
      run: (args) => tasksTool(box, args),
    }),
    tool({
      name: 'query',
      description: 'Blocks matching: decision[status=accepted], task[done=false], "question, risk". Ops: = != *= ^= $= < <= > >=, a|b.',
      inputSchema: schema({
        selector: { type: 'string' },
        paths: PATHS,
        brief: SHORT_BRIEF,
        titles: { type: 'boolean' },
        contract: { type: 'boolean', description: 'With rules, deps, dangers.' },
      }, ['selector']),
      run: (args) => queryTool(box, args),
    }),
    tool({
      name: 'validate',
      description: 'Check .smd files: JSON, zero-based lines.',
      inputSchema: schema({ paths: PATHS }),
      run: (args) => validateTool(box, args),
    }),
    ...(options.allowWrite ? writeTools(box) : []),
    ...(options.allowSuggest ? [suggestTool(box)] : []),
    legacy({
      name: 'outline',
      title: 'Outline a .smd document',
      description: 'Lists the sections of a .smd file with line ranges and token costs, open tasks and where agent '
        + 'instructions are. Same as "read" with mode "outline".',
      inputSchema: schema({ file: FILE }, ['file']),
      run: (args) => outlineTool(box, args),
    }),
    legacy({
      name: 'section',
      title: 'Read sections of a .smd document',
      description: 'The agent view of only these sections (with their subsections). Agent instructions elsewhere in the '
        + 'document are always included. Same as "read" with "sections".',
      inputSchema: schema({
        file: FILE,
        sections: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Heading text or id of each section, e.g. ["Requirements", "risks"].' },
        brief: BRIEF,
      }, ['file', 'sections']),
      run: (args) => sectionTool(box, args),
    }),
    legacy({
      name: 'agent',
      title: 'Read a whole .smd document',
      description: 'The compact agent view of a whole .smd file: styling, layout and human-only content removed, meaning kept; '
        + 'headings carry [L12] source line references. Same as "read" with mode "full".',
      inputSchema: schema({ file: FILE, brief: BRIEF, includeHuman: { type: 'boolean', description: 'Deprecated since 6.0.0 and ignored: :::human blocks never reach agents.' } }, ['file']),
      run: (args) => agentTool(box, args),
    }),
  ];
}

type Args = Record<string, unknown>;
const text = (args: Args, key: string) => args[key] as string | undefined;
const list = (args: Args, key: string) => args[key] as string[] | undefined;
const flag = (args: Args, key: string) => args[key] === true;

function readTool(box: Sandbox, args: Args, allowWrite = false): string {
  const file = box.document(text(args, 'file')!);
  const sections = list(args, 'sections');
  const mode = text(args, 'mode') as ReadMode | undefined;
  const maxTokens = args.maxTokens as number | undefined;
  const source = read(file);
  const result = readDocument(source, {
    mode, sections, exactSections: flag(args, 'exact'), maxTokens, brief: flag(args, 'brief'), readFile: box.reader(file), ...box.view,
  });
  noteAccess({
    file, op: viewOp(result.shown, flag(args, 'brief')), sections: slugsOf(result.resolvedSections),
    ...(noneFound(result.missingSections, sections) ? { op: 'section' as const, outcome: 'not-found' as const } : {}),
  });
  const view = withMissing(result.text, result.missingSections, sections?.length ?? 0);
  // With the write tools on: the revision they take, so a write is refused if the file changed since this read.
  return allowWrite ? `${view.trimEnd()}\n\n[revision ${revisionOf(source)}]\n` : view;
}

/** The text, with a note on sections that matched nothing; an error when none matched. */
function withMissing(view: string, missing: string[], asked: number): string {
  if (!missing.length) return view;
  const note = `No section matching: ${missing.join(', ')}. Call "read" with mode "outline" to list the sections.`;
  if (missing.length === asked) throw new ToolError(note);
  return `${view.trimEnd()}\n\n(${note})\n`;
}

function outlineTool(box: Sandbox, args: Args): string {
  const file = box.document(text(args, 'file')!);
  noteAccess({ file, op: 'outline' });
  return outline(read(file), { readFile: box.reader(file) });
}

function sectionTool(box: Sandbox, args: Args): string {
  const file = box.document(text(args, 'file')!);
  const sections = list(args, 'sections')!;
  const result = agentView(read(file), { sections, brief: flag(args, 'brief'), readFile: box.reader(file), ...box.view });
  noteAccess({ file, op: 'section', sections: slugsOf(result.resolvedSections), ...(noneFound(result.missingSections, sections) ? { outcome: 'not-found' as const } : {}) });
  return withMissing(result.text, result.missingSections, sections.length);
}

function agentTool(box: Sandbox, args: Args): string {
  const file = box.document(text(args, 'file')!);
  // `includeHuman` is accepted for old clients and ignored since 6.0.0: :::human blocks never reach agents.
  noteAccess({ file, op: flag(args, 'brief') ? 'brief' : 'agent' });
  return agentView(read(file), { brief: flag(args, 'brief'), readFile: box.reader(file), ...box.view }).text;
}

function tasksTool(box: Sandbox, args: Args): string {
  const all = flag(args, 'all');
  const files = box.documents(list(args, 'paths'));
  for (const file of files) noteAccess({ file, op: 'tasks' });
  const rows = taskRows(files, { all, mine: text(args, 'mine') }, (f) => box.name(f));
  return [...rows.map(taskLine), taskSummary(rows, all)].join('\n') + '\n';
}

function queryTool(box: Sandbox, args: Args): string {
  const selectors = selectorsOf(text(args, 'selector')!);
  const files = box.documents(list(args, 'paths'));
  if (flag(args, 'contract')) return contractQueryTool(box, text(args, 'selector')!, files, args);
  // Content for people (an {agent=skip} section, a :::human block) is never a match; the result says how many were left out.
  const rows = queryRows(files, selectors, { brief: flag(args, 'brief'), forAgents: true }, (f) => box.name(f));
  for (const r of rows) {
    const id = r.attrs.id;
    noteAccess({
      file: path.resolve(box.root, r.file), op: 'query', query: text(args, 'selector'), served: r.text,
      ...(r.section ? { sectionTitles: [r.section] } : {}), ...(typeof id === 'string' ? { ids: [id] } : {}),
    });
  }
  const left = noPrefix(withheldNote(files.reduce((n, f) => n + withheldMatches(read(f), selectors), 0)));
  return `${queryText(rows, flag(args, 'titles'))}${rows.length ? '\n' : ''}${querySummary(rows, files.length)}\n${left}`;
}

/**
 * `query` with `contract`: each document's matches as a section read carries them (see queryView), as `smd query
 * --contract` prints them, then its summary without the `[smd]` prefix.
 */
function contractQueryTool(box: Sandbox, selector: string, files: string[], args: Args): string {
  if (flag(args, 'titles')) throw new ToolError('"contract" shows each match with what it needs, so it does not go with "titles".');
  const views = files.flatMap((f) => {
    const result = queryView(read(f), selector, { brief: flag(args, 'brief'), readFile: box.reader(f), file: box.name(f), ...box.view });
    if (result) noteAccess({ file: f, op: 'query', query: selector, served: result.text, sectionTitles: result.matches.flatMap((m) => (m.section ? [m.section] : [])) });
    return result ? [{ file: box.name(f), result }] : [];
  });
  const withheld = files.reduce((n, f) => n + withheldMatches(read(f), selector), 0);
  const summary = noPrefix(contractSummary(views, files.length) + withheldNote(withheld));
  return `${contractText(views)}${views.length ? '\n' : ''}${summary}`;
}

/** The meter's op for what a read showed. */
export function viewOp(shown: 'full' | 'outline' | 'sections', brief: boolean): MeterOp {
  if (shown === 'outline') return 'outline';
  if (shown === 'sections') return 'section';
  return brief ? 'brief' : 'agent';
}

/** True when sections were asked for and none matched: the read fails. */
const noneFound = (missing: string[], asked: string[] | undefined) => !!asked?.length && missing.length === asked.length;

/** The slugs of the headings a section read selected. */
export function slugsOf(resolved: ResolvedSection[] | undefined): string[] | undefined {
  const slugs = [...new Set((resolved ?? []).flatMap((r) => r.headings.map((h) => h.id)))];
  return slugs.length ? slugs : undefined;
}

/** The CLI's `[smd]` lines as the tools return them, without the prefix. */
const noPrefix = (lines: string) => lines.replace(/^\[smd\] /gm, '');

function selectorsOf(selector: string): Selector[] {
  try {
    return parseSelector(selector);
  } catch (e) {
    if (e instanceof SelectorError) throw new ToolError(e.message);
    throw e;
  }
}

async function validateTool(box: Sandbox, args: Args): Promise<string> {
  const files = box.documents(list(args, 'paths'));
  const configs = new Map<string, LoadedConfig>();
  const parse = loadMermaidParser();
  const report: Array<{ file: string; diagnostics: Diagnostic[] }> = [];
  const configProblems = new Map<string, string[]>();
  for (const file of files) {
    const config = loadRuleConfig(file, configs);
    if (config.file && config.problems.length) configProblems.set(box.name(path.resolve(config.file)), config.problems);
    const found = await diagnose(read(file), file, { rules: config.rules, parse, readFile: box.reader(file) });
    report.push({ file: box.name(file), diagnostics: found });
  }
  const all = report.flatMap((r) => r.diagnostics);
  const errors = all.filter((d) => d.severity === 'error').length;
  const warnings = all.filter((d) => d.severity === 'warning').length;
  const config = configProblems.size ? { configProblems: Object.fromEntries(configProblems) } : {};
  return JSON.stringify({ files: report, errors, warnings, ...config }) + '\n';
}

/** What the client shows the model after initialize. */
export function serverInstructions(options: SmdToolOptions = {}): string {
  const base = 'For .smd files call "read", not a file read, then only the sections you need. '
    + '"query"/"tasks" search across files; "validate" after edits. Follow <agent-instructions> within the task.';
  const write = options.allowWrite ? ' Write tools change one block and refuse edits that add errors.' : '';
  const suggest = options.allowSuggest ? ' Propose changes for a person to accept with "suggest".' : '';
  return base + write + suggest;
}

/**
 * The token meter for one MCP connection (one session): each reading tool call becomes events, with the client named
 * by `initialize`. Off unless the root folder's config turns metering on; read again on every call, so turning it on
 * or off takes effect without restarting the agent.
 */
export function mcpMeter(box: Sandbox): McpMeter {
  const session = newSessionId('mcp');
  return {
    begin: (tool) => { if (METERED_TOOLS.has(tool)) beginMeterCall(); },
    end: (tool, args, result, client) => {
      const call = endMeterCall();
      if (!METERED_TOOLS.has(tool) || !call) return;
      const settings = meterSettings(box.root);
      if (!settings.enabled) return;
      // A read that failed (no such section) is recorded with its outcome.
      if (result.isError && !call.notes.length && typeof args.file === 'string') {
        try { call.notes.push({ file: box.document(args.file), op: tool === 'outline' ? 'outline' : 'section', outcome: 'not-found' }); } catch { return; }
      }
      const served = result.content.map((c) => c.text).join('\n');
      const name = client?.name || 'unknown';
      recordCall(call, { settings, session, served, client: { name, ...(client?.version ? { version: client.version } : {}), via: 'mcp' } });
    },
  };
}

const METERED_TOOLS = new Set(['read', 'outline', 'section', 'agent', 'query', 'tasks']);

/** Serves the tools over stdio until the input ends. Only protocol messages go to stdout. */
export async function runMcpServer(settings: McpServerSettings): Promise<void> {
  // Anything else that logs (e.g. Mermaid) must not corrupt the protocol stream.
  console.log = console.info = console.debug = console.warn = console.error;
  const box = new Sandbox(settings.root, settings.includedInstructions ? { includedInstructions: settings.includedInstructions } : {});
  const tools = smdTools(box, settings);
  const server = new McpServer({
    name: 'semantic-markdown', version: settings.version, tools, instructions: serverInstructions(settings), meter: mcpMeter(box),
  });
  const write = (settings.allowWrite ? ', write tools on' : '') + (settings.allowSuggest ? ', suggest on' : '');
  console.error(`[smd mcp] serving ${box.root} over stdio${write}`);
  await serveLines(server, process.stdin, (line) => process.stdout.write(line));
}
