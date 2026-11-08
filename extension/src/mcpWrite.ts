import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { DECISION_STATUS, extractTasks, parseSmd, specVersion, STATUS_VALUES, type Diagnostic } from './core';
import { findSection, sectionsOf } from './core/sections';
import { applyLineEdits, type LineEdit } from './core/sourceEdit';
import { isFrontMatterRefusal, setFrontMatterValue } from './core/frontMatterEdit';
import { addSuggestion, normalizeActor } from './core/review';
import { loadRuleConfig } from './config';
import { taskCheckbox } from './editing';
import { loadMermaidParser } from './mermaidLoader';
import { ToolError, type McpTool, type ToolInputSchema } from './mcpProtocol';
import { diagnose, read } from './workspace';
import type { Sandbox } from './mcp';

/**
 * Opt-in write tools for `smd mcp --allow-write`: tick a task, set a document's status, add a decision. Each one
 * changes only the lines it is about, keeps the file's line endings, stays inside the server's root, and refuses a
 * change that would add validation errors, checked as the `validate` tool checks (the folder's rule config and
 * Mermaid). A write goes to a temporary file that replaces the document, and is refused when the document changed
 * since it was read: since the given `revision`, or while the tool ran.
 */

const FILE = { type: 'string', description: 'Path of a .smd file, relative to the root folder.' } as const;
const REVISION = { type: 'string', description: 'From "read".' } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** A document's revision: the first 12 hex digits of the SHA-256 of its text. It identifies content, not who wrote it. */
export function revisionOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function schema(properties: ToolInputSchema['properties'], required: string[]): ToolInputSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function writeTools(box: Sandbox, today: () => string = isoToday): McpTool[] {
  return [
    {
      name: 'check_task',
      description: 'Tick (or untick) one task in a .smd file. "line" is the 1-based line that "tasks" prints.',
      inputSchema: schema({
        file: FILE,
        line: { type: 'integer', minimum: 1, description: '1-based line of the task.' },
        done: { type: 'boolean', description: 'false unticks it (default true).' },
        text: { type: 'string', description: 'Part of the task text; refused if the line no longer has it.' },
        revision: REVISION,
      }, ['file', 'line']),
      annotations: { ...WRITE, idempotentHint: true },
      run: (args) => checkTask(box, args),
    },
    {
      name: 'set_status',
      description: 'Set the front matter status of a .smd file (and "updated" to today when it has one).',
      inputSchema: schema({ file: FILE, status: { type: 'string', enum: STATUS_VALUES, description: 'New status.' }, revision: REVISION }, ['file', 'status']),
      annotations: { ...WRITE, idempotentHint: true },
      run: (args) => setStatus(box, args, today()),
    },
    {
      name: 'add_decision',
      description: 'Append a :::decision block at the end of a section of a .smd file.',
      inputSchema: schema({
        file: FILE,
        section: { type: 'string', description: 'Heading text or id of the section.' },
        title: { type: 'string', description: 'One-line title.' },
        body: { type: 'string', description: 'Markdown: what was decided and why.' },
        status: { type: 'string', enum: DECISION_STATUS, description: 'Default: proposed.' },
        owner: { type: 'string', description: 'e.g. "@maya".' },
        revision: REVISION,
      }, ['file', 'section', 'title', 'body']),
      annotations: { ...WRITE, idempotentHint: false },
      run: (args) => addDecision(box, args, today()),
    },
  ];
}

/**
 * `smd mcp --allow-suggest`: one tool, `suggest`, that proposes new body text for a block as a `:::suggestion` with the
 * block's revision, for a person to accept or reject (collaboration RFC, "Agents as collaborators"). It never edits
 * content, needs the document's revision from "read", and refuses when the document changed since.
 */
export function suggestTool(box: Sandbox, today: () => string = isoToday): McpTool {
  return {
    name: 'suggest',
    description: 'Propose new body text for the block with this {#id} as a :::suggestion a person accepts or rejects. Content is not edited.',
    inputSchema: schema({
      file: FILE,
      id: { type: 'string', description: 'The id of the block (requirement, decision, task, heading…).' },
      text: { type: 'string', description: 'Markdown: the whole replacement body.' },
      title: { type: 'string', description: 'One line: the gist.' },
      author: { type: 'string', description: 'Default: @agent.' },
      revision: { type: 'string', description: 'From "read": refused if the file changed since.' },
    }, ['file', 'id', 'text', 'revision']),
    annotations: { ...WRITE, idempotentHint: false },
    run: (args) => suggest(box, args, today()),
  };
}

async function suggest(box: Sandbox, args: Args, today: string): Promise<string> {
  const path = box.document(args.file as string);
  const text = read(path);
  const name = box.name(path);
  const expected = String(args.revision ?? '').trim().toLowerCase();
  if (expected !== revisionOf(text)) throw new ToolError(`Not written: ${name} changed since revision ${expected || '(none)'} (now ${revisionOf(text)}). Call "read" again.`);
  const author = normalizeActor((args.author as string | undefined) ?? '@agent');
  if (!author) throw new ToolError('"author" must be one word, like "@agent".');
  const title = args.title as string | undefined;
  if (title !== undefined && /[\r\n]/.test(title)) throw new ToolError('"title" must be one line.');
  const result = addSuggestion(text, args.id as string, { by: author, today, text: args.text as string, title });
  if (!result.ok) throw new ToolError(`Not written: ${result.error}`);
  const added = await newErrors(text, result.text, path, box);
  if (added.length) {
    const list = added.slice(0, 3).map((d) => `line ${d.line + 1}: ${d.message} (${d.code})`).join('; ');
    throw new ToolError(`Not written: the suggestion would add ${added.length} validation error(s) to ${name}: ${list}`);
  }
  replaceFile(path, text, result.text, name);
  return `Suggested new text for ${args.id as string} in ${name}, line ${result.line + 1}. A person accepts or rejects it.  [revision ${revisionOf(result.text)}]\n`;
}

type Args = Record<string, unknown>;

async function checkTask(box: Sandbox, args: Args): Promise<string> {
  const doc = openDocument(box, args);
  const index = (args.line as number) - 1;
  const done = args.done !== false;
  const task = extractTasks(doc.text).find((t) => t.line === index);
  const box_ = task && taskCheckbox(doc.lines[index]);
  if (!task || !box_) throw new ToolError(`Line ${index + 1} of ${doc.name} is not a task. Call "tasks" for the current lines.`);
  const expected = args.text as string | undefined;
  if (expected && !doc.lines[index].toLowerCase().includes(expected.toLowerCase())) {
    throw new ToolError(`Line ${index + 1} of ${doc.name} no longer has "${expected}": ${doc.lines[index].trim()}. Call "tasks" again.`);
  }
  if (box_.done === done) return `Already ${done ? 'done' : 'open'}: ${doc.name}:${index + 1}  ${doc.lines[index].trim()}\n`;
  const line = doc.lines[index];
  const changed = line.slice(0, box_.column) + (done ? 'x' : ' ') + line.slice(box_.column + 1);
  const saved = await doc.save([{ start: index, end: index + 1, lines: [changed] }]);
  return `${done ? 'Done' : 'Reopened'}: ${doc.name}:${index + 1}  ${saved.lines[index].trim()}  [revision ${saved.revision}]\n`;
}

async function setStatus(box: Sandbox, args: Args, today: string): Promise<string> {
  const doc = openDocument(box, args);
  const status = args.status as string;
  const set = (lines: string[], key: string, value: string): string[] => {
    const edits = setFrontMatterValue(lines, key, value);
    if (isFrontMatterRefusal(edits)) throw new ToolError(`Can't set ${key} in ${doc.name}: ${edits.refused}`);
    return edits.length ? applyLineEdits(lines, edits) : lines;
  };
  let lines = set(doc.lines, 'status', status);
  if (lines === doc.lines) return `${doc.name} already has status: ${status}\n`;
  if (/^updated\s*:/m.test(frontMatterText(lines))) lines = set(lines, 'updated', today);
  const saved = await doc.saveLines(lines);
  return `${doc.name}: status ${status}  [revision ${saved.revision}]\n`;
}

async function addDecision(box: Sandbox, args: Args, today: string): Promise<string> {
  const doc = openDocument(box, args);
  const title = (args.title as string).trim();
  if (!title || /[\r\n]/.test(title)) throw new ToolError('"title" must be one non-empty line.');
  const owner = args.owner as string | undefined;
  if (owner !== undefined && !/^@[\w.-]+(?:\/[\w.-]+)?$/.test(owner)) throw new ToolError('"owner" must look like "@maya" or "@org/team".');
  const status = (args.status as string | undefined) ?? 'proposed';
  const parsed = parseSmd(doc.text);
  const section = findSection(sectionsOf(parsed.headings, doc.lines.length), args.section as string, specVersion(doc.text));
  if (!section) throw new ToolError(`No section matching "${args.section as string}" in ${doc.name}. Call "read" with mode "outline" to list them.`);
  let end = section.end;
  while (end > section.start && !doc.lines[end].trim()) end--;
  const attrs = [`status=${status}`, `date=${today}`, ...(owner ? [`owner=${owner}`] : [])].join(' ');
  const body = (args.body as string).replace(/\r\n?/g, '\n').trim().split('\n');
  const block = ['', `:::decision{${attrs}} ${title}`, ...body, ':::'];
  const next = doc.lines[end + 1];
  if (next !== undefined && next.trim()) block.push('');
  const saved = await doc.save([{ start: end + 1, end: end + 1, lines: block }]);
  return `Added the decision "${title}" (${status}) to ${doc.name} › ${section.heading.text}, lines ${end + 3}-${end + 4 + body.length}.  [revision ${saved.revision}]\n`;
}

interface Saved { lines: string[]; revision: string }

interface OpenDocument {
  name: string;
  text: string;
  lines: string[];
  /** Applies the edits, checks the result and writes it; returns the new lines and revision. */
  save(edits: LineEdit[]): Promise<Saved>;
  saveLines(lines: string[]): Promise<Saved>;
}

/** The document `args.file`, refused when `args.revision` is given and the file no longer has it. */
function openDocument(box: Sandbox, args: Args): OpenDocument {
  const path = box.document(args.file as string);
  const text = read(path);
  const name = box.name(path);
  const expected = args.revision as string | undefined;
  if (expected !== undefined && expected.trim().toLowerCase() !== revisionOf(text)) {
    throw new ToolError(`Not written: ${name} changed since revision ${expected} (now ${revisionOf(text)}). Call "read" again.`);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const saveLines = async (next: string[]): Promise<Saved> => {
    const out = next.join(eol);
    const added = await newErrors(text, out, path, box);
    if (added.length) {
      const list = added.slice(0, 3).map((d) => `line ${d.line + 1}: ${d.message} (${d.code})`).join('; ');
      throw new ToolError(`Not written: the change would add ${added.length} validation error(s) to ${name}: ${list}`);
    }
    replaceFile(path, text, out, name);
    return { lines: next, revision: revisionOf(out) };
  };
  return { name, text, lines, saveLines, save: (edits) => saveLines(applyLineEdits(lines, edits)) };
}

/**
 * Write `out` over `file`, which was read as `before`: into a temporary file beside it (with its mode), then renamed
 * over it, so a failed write leaves the document as it was. Refused when the document changed while the tool ran. The
 * check and the rename are two steps, so an editor saving between them is not caught. Where Windows refuses the rename
 * (another program holds the file open), the document is written in place.
 */
export function replaceFile(file: string, before: string, out: string, name = file): void {
  const temp = nodePath.join(nodePath.dirname(file), `.${nodePath.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, out, { mode: fs.statSync(file).mode });
    if (read(file) !== before) throw new ToolError(`Not written: ${name} changed while the tool ran. Call "read" again.`);
    try {
      fs.renameSync(temp, file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e;
      fs.writeFileSync(file, out);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Errors in `after` that `before` didn't have (compared by code and message, so moved lines don't count), found as the
 * `validate` tool finds them: with the rule config that applies to the file, and Mermaid's parser when it is shipped.
 */
async function newErrors(before: string, after: string, file: string, box: Sandbox): Promise<Diagnostic[]> {
  const options = { rules: loadRuleConfig(file).rules, parse: loadMermaidParser(), readFile: box.reader(file) };
  const errors = async (text: string) => (await diagnose(text, file, options)).filter((d) => d.severity === 'error');
  const seen = new Map<string, number>();
  for (const d of await errors(before)) seen.set(`${d.code} ${d.message}`, (seen.get(`${d.code} ${d.message}`) ?? 0) + 1);
  return (await errors(after)).filter((d) => {
    const key = `${d.code} ${d.message}`;
    const left = seen.get(key) ?? 0;
    if (left) seen.set(key, left - 1);
    return !left;
  });
}

function frontMatterText(lines: readonly string[]): string {
  if (lines[0]?.trim() !== '---') return '';
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  return close > 0 ? lines.slice(1, close).join('\n') : '';
}

function isoToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
