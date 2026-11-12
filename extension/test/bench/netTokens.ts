import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentView, estimateTokens, formatQueryResult, outline, queryDocuments, querySmd, queryResultSummary, type Tokenizer } from '../../src/core';
import { agentViewRanges, sectionCosts, type SectionCost } from '../../src/core/agentView';
import { rulesBody } from '../../src/agentTargets';
import { Sandbox, smdTools } from '../../src/mcp';
import { McpServer } from '../../src/mcpProtocol';
import { readDocument } from '../../src/readView';
import { loadTokenizer } from '../../src/tokenizer';

/**
 * Net tokens: what an agent spends to use a `.smd` document with plain reading versus the smd tools, counting the
 * tools' own fixed overhead (skill descriptions, the reader SKILL.md, agent rules, MCP tool definitions).
 *
 *   npm run bench:tokens                         test/samples/ (markdown report on stdout)
 *   npm run bench:tokens -- --docs               also docs/rfcs/*.smd and docs/requirements/*.smd
 *   npm run bench:tokens -- --tokenizer o200k_base   exact OpenAI counts (needs js-tiktoken), else ≈ chars / 4
 *   npm run bench:tokens -- --json               raw numbers, with a record of the run (commit, hashes, Node, OS, settings)
 *   npm run bench:tokens -- --reader cli         require the built CLI for `smd read` (or `in-process`); default: the
 *                                                CLI when built. Research runs should name one.
 *
 * Every overhead is read at run time from the files and the MCP server, so the report follows their changes.
 * docs/reports/tokens.md explains the method and holds the published results.
 */

const repo = path.join(__dirname, '..', '..', '..');
const samplesDir = path.join(__dirname, '..', 'samples');
const cli = path.join(__dirname, '..', '..', 'dist', 'cli.js');
const TODAY = '2026-10-28';
/** Tokens per tool call besides its result: the call itself and the result's framing (an assumption, same for every call). */
export const CALL = 20;
/** `smd read`'s default budget. */
export const READ_BUDGET = 2000;

export interface FixedCosts {
  /** Both skills' front matter (name + description): in context every session in Claude Code. */
  descriptions: number;
  /** The reader SKILL.md, loaded when the skill triggers. */
  readerSkill: number;
  /** skills/agent-rules.md as installed (Cursor rule, Copilot instructions, AGENTS.md section). */
  agentRules: number;
  /** MCP `tools/list` result plus the server instructions. */
  mcp: number;
  mcpSource: string;
  /** Writer: SKILL.md, the syntax index, one syntax topic file (median) and the style guide. */
  writer: { skill: number; syntaxIndex: number; syntaxTopicMedian: number; styleGuide: number };
}

function frontMatter(text: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
}

export async function fixedCosts(count: (t: string) => number): Promise<FixedCosts> {
  const skill = (name: string, rel = 'SKILL.md') => fs.readFileSync(path.join(repo, 'skills', name, rel), 'utf8');
  const reader = skill('semantic-markdown-reader');
  const writer = skill('semantic-markdown-writer');
  const topicsDir = path.join(repo, 'skills', 'semantic-markdown-writer', 'references', 'syntax');
  const topics = fs.existsSync(topicsDir) ? fs.readdirSync(topicsDir).map((f) => count(fs.readFileSync(path.join(topicsDir, f), 'utf8'))) : [];
  const { tokens, source } = await mcpCost(count);
  return {
    descriptions: count(frontMatter(reader)) + count(frontMatter(writer)),
    readerSkill: count(reader),
    agentRules: count(rulesBody(fs.readFileSync(path.join(repo, 'skills', 'agent-rules.md'), 'utf8'))),
    mcp: tokens,
    mcpSource: source,
    writer: {
      skill: count(writer),
      syntaxIndex: count(skill('semantic-markdown-writer', 'references/syntax.md')),
      syntaxTopicMedian: topics.length ? median(topics) : 0,
      styleGuide: count(skill('semantic-markdown-writer', 'references/style-guide.md')),
    },
  };
}

/**
 * What an MCP client puts in context: the `tools/list` result and the `initialize` instructions. Asks the built
 * server (`dist/cli.js mcp`) so the numbers are what clients see; without a build, lists `smdTools` in process
 * (without the instructions, which only the server knows).
 */
async function mcpCost(count: (t: string) => number): Promise<{ tokens: number; source: string }> {
  if (fs.existsSync(cli)) {
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ];
    const res = spawnSync(process.execPath, [cli, 'mcp', '--root', repo], { input: messages.map((m) => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`smd mcp failed (exit ${res.status}): ${res.stderr || res.error?.message}`);
    const replies = res.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
    const init = replies.find((r) => r.id === 1)?.result;
    const list = replies.find((r) => r.id === 2)?.result;
    if (list) {
      const instructions = typeof init?.instructions === 'string' ? init.instructions : '';
      return { tokens: count(JSON.stringify(list.tools)) + count(instructions), source: 'dist/cli.js mcp: tools/list + instructions' };
    }
  }
  const server = new McpServer({ name: 'semantic-markdown', version: '0', tools: smdTools(new Sandbox(repo)) });
  const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: unknown } };
  return { tokens: count(JSON.stringify(reply.result.tools)), source: 'smdTools in process: tools/list only (run npm run build to add the instructions)' };
}

/** A document: its text, the folder its relative includes and embeds resolve in, and its path when it is a file on disk. */
export interface Doc { name: string; text: string; dir: string; file?: string }

/** What `smd read` returned, and which of its outputs it was (as it reports it, not guessed from the length). */
export interface ReadOutput { text: string; shown: 'full' | 'outline' | 'sections' }

export type ReaderMode = 'cli' | 'in-process';

/**
 * `smd read FILE`: the built CLI's (`cli`), or the same function in process (`in-process`). Every strategy gets the
 * same date (`TODAY`) and tokenizer. A file on disk is read at its own path, so its relative includes resolve as they
 * do for an agent; a generated document is written beside the files it was made from. A failed read throws, so it can't
 * pass for a cheap strategy.
 */
export class Reader {
  readonly mode: ReaderMode;
  constructor(mode?: ReaderMode, private readonly tokenizer?: Tokenizer) {
    const built = fs.existsSync(cli) && spawnSync(process.execPath, [cli, 'read', path.join(samplesDir, 'feature-spec.smd')], { encoding: 'utf8' }).status === 0;
    if (mode === 'cli' && !built) throw new Error(`--reader cli needs a working ${cli}: run npm run build first.`);
    this.mode = mode ?? (built ? 'cli' : 'in-process');
  }

  get viaCli(): boolean { return this.mode === 'cli'; }

  read(doc: Doc): ReadOutput {
    if (this.mode === 'in-process') {
      const result = readDocument(doc.text, { ...options(doc), tokenizer: this.tokenizer, file: doc.file });
      return { text: result.text, shown: result.shown };
    }
    if (doc.file) return this.cliRead(doc.file);
    // A generated document: a hidden file in its folder (smd skips dot files), removed afterwards.
    const file = path.join(doc.dir, `.smd-bench-${process.pid}.smd`);
    fs.writeFileSync(file, doc.text);
    try {
      return this.cliRead(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  private cliRead(file: string): ReadOutput {
    const args = [cli, 'read', file, '--today', TODAY, ...(this.tokenizer ? ['--tokenizer', this.tokenizer.name] : [])];
    const res = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: path.dirname(file) });
    if (res.status !== 0) throw new Error(`smd read ${file} failed (exit ${res.status}): ${res.stderr || res.error?.message}`);
    const shown = /^\[smd\] (full|outline|sections) ·/m.exec(res.stderr)?.[1] as ReadOutput['shown'] | undefined;
    if (!shown) throw new Error(`smd read ${file}: no "[smd] full|outline|sections" line on stderr: ${res.stderr}`);
    return { text: res.stdout, shown };
  }
}

function options(doc: Doc) {
  return { today: TODAY, readFile: (rel: string) => readIn(doc.dir, rel) };
}

function readIn(dir: string, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return undefined;
  }
}

// Coverage proxy: are the key lines of what the agent needed present in what it read?

const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');

/**
 * A line's key phrase: its longest run of plain words between markup characters (so `- [ ] Add idempotency keys
 * :priority[P0]` gives "add idempotency keys", in the source and in the agent view alike), at most 8 words.
 * Lines with fewer than 3 words, and pointers the view writes itself (`[code: …]`), have none.
 */
export function keyPhrase(line: string): string | undefined {
  if (/^\s*\[(code|diagram|details|include|section omitted|image|risk matrix)\b/.test(line)) return undefined;
  // Text the view writes itself: tags with their attributes, the API header's method and path, task due dates.
  const own = line.replace(/<[^>\n]*>/g, ' ').replace(/^\s*API [A-Z]+ \S+ —/, ' ').replace(/\(due [^)]*\)/g, ' ');
  const fragments = own.split(/[[\](){}<>|*`_=:#@"]+|--/).map((f) => words(f).split(' ').filter(Boolean));
  const best = fragments.reduce((a, b) => (b.length > a.length ? b : a), [] as string[]);
  return best.length >= 3 ? best.slice(0, 8).join(' ') : undefined;
}

export function keyPhrases(reference: string): string[] {
  return [...new Set(reference.split('\n').map(keyPhrase).filter((k): k is string => !!k))];
}

/** Share of the key phrases found in what was read (1 when there are none). */
export function coverage(keys: string[], read: string): number {
  if (!keys.length) return 1;
  // Read the source as its words: attribute lists and directive names are markup, not text.
  const hay = ` ${words(read.replace(/\{[^}\n]*\}/g, ' ').replace(/:[a-z][\w-]*\[/g, ' '))} `;
  return keys.filter((k) => hay.includes(` ${k} `)).length / keys.length;
}

export interface Strategy { tokens: number; calls: number; coverage: number }
export interface DocResult {
  name: string;
  raw: number;
  sections: number;
  /** (a) Answer a question about one section: medians over the document's sections. */
  section: { raw: Strategy; outlineSection: Strategy; read: Strategy };
  /** (b) Understand the whole document. */
  whole: { raw: Strategy; agent: Strategy; brief: Strategy; read: Strategy };
  /** (c) A question whose answer is in several sections; absent when no block type spans two sections. */
  cross?: CrossSection;
}

/**
 * (c) Every block of one type across the document (the type found in the most sections), as a question that needs
 * several sections: outline, then one `smd agent --section` call per section (or one call naming them all), against
 * one `smd query "<type>" --constraints` call.
 */
export interface CrossSection {
  type: string;
  matches: number;
  sections: number;
  outlineSections: Strategy;
  outlineSectionsOneCall: Strategy;
  query: Strategy;
}

const CROSS_TYPES = ['decision', 'risk', 'question', 'api', 'requirement', 'constraint', 'warning', 'danger', 'task[done=false]'];

/** The block type of `doc` found in the most sections (at least two), with the section of each match. */
function crossTarget(doc: Doc): { type: string; sections: string[]; ranges: Array<[number, number]> } | undefined {
  let best: { type: string; sections: string[]; ranges: Array<[number, number]> } | undefined;
  for (const type of CROSS_TYPES) {
    const matches = querySmd(doc.text, type, { today: TODAY, lineRefs: false });
    const sections = [...new Set(matches.map((m) => [...m.ancestors].reverse().find((a) => a.type === 'heading')?.id).filter((id): id is string => !!id))];
    if (sections.length < 2) continue;
    if (!best || sections.length > best.sections.length || (sections.length === best.sections.length && matches.length > best.ranges.length)) {
      best = { type, sections, ranges: matches.map((m) => [m.line, m.endLine]) };
    }
  }
  return best;
}

export function measureCross(doc: Doc, count: (t: string) => number): CrossSection | undefined {
  const target = crossTarget(doc);
  if (!target) return undefined;
  const opts = options(doc);
  const range = agentViewRanges(doc.text, { ...opts, lineRefs: false });
  const keys = keyPhrases(target.ranges.map(([a, b]) => range(a, b)).join('\n'));
  const outlineText = outline(doc.text, opts);
  const views = target.sections.map((id) => agentView(doc.text, { ...opts, sections: [id], exactSections: true }).text);
  const all = agentView(doc.text, { ...opts, sections: target.sections, exactSections: true }).text;
  const result = queryDocuments([{ path: doc.name, text: doc.text }], target.type, { today: TODAY, constraints: true });
  const answer = `${formatQueryResult(result)}[smd] ${queryResultSummary(result, 1)}\n`;
  return {
    type: target.type,
    matches: target.ranges.length,
    sections: target.sections.length,
    outlineSections: strategy(count(outlineText) + views.reduce((n, v) => n + count(v), 0), 1 + views.length, coverage(keys, views.join('\n'))),
    outlineSectionsOneCall: strategy(count(outlineText) + count(all), 2, coverage(keys, all)),
    query: strategy(count(answer), 1, coverage(keys, answer)),
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const strategy = (tokens: number, calls: number, cov: number): Strategy => ({ tokens: tokens + calls * CALL, calls, coverage: cov });
const medianStrategy = (list: Strategy[]): Strategy => ({
  tokens: Math.round(median(list.map((s) => s.tokens))),
  calls: Math.round(median(list.map((s) => s.calls))),
  coverage: list.reduce((n, s) => n + s.coverage, 0) / list.length,
});

/** The sections an agent may be asked about: those agents see, without subsections of their own (the leaves). */
function targetSections(doc: Doc): SectionCost[] {
  const all = sectionCosts(doc.text, options(doc)).filter((s) => s.heading.agent !== 'skip');
  const leaves = all.filter((s) => !all.some((o) => o !== s && o.start > s.start && o.end <= s.end));
  return leaves.filter((s) => s.tokens > 10);
}

export function measure(doc: Doc, reader: Reader, count: (t: string) => number): DocResult {
  const opts = options(doc);
  const raw = count(doc.text);
  const full = agentView(doc.text, opts).text;
  const brief = agentView(doc.text, { ...opts, brief: true }).text;
  const outlineText = outline(doc.text, opts);
  const { text: readText, shown } = reader.read(doc);
  const readIsFull = shown === 'full';
  const range = agentViewRanges(doc.text, { ...opts, lineRefs: false });

  const sections = targetSections(doc).map((s) => {
    const keys = keyPhrases(range(s.start, s.end));
    const view = agentView(doc.text, { ...opts, sections: [s.heading.slug] }).text;
    return {
      raw: strategy(raw, 1, coverage(keys, doc.text)),
      outlineSection: strategy(count(outlineText) + count(view), 2, coverage(keys, view)),
      read: readIsFull
        ? strategy(count(readText), 1, coverage(keys, readText))
        : strategy(count(readText) + count(view), 2, coverage(keys, view)),
    };
  });
  const wholeKeys = keyPhrases(agentView(doc.text, { ...opts, lineRefs: false }).text);
  const cross = measureCross(doc, count);
  return {
    name: doc.name,
    raw,
    sections: sections.length,
    section: {
      raw: medianStrategy(sections.map((s) => s.raw)),
      outlineSection: medianStrategy(sections.map((s) => s.outlineSection)),
      read: medianStrategy(sections.map((s) => s.read)),
    },
    whole: {
      raw: strategy(raw, 1, coverage(wholeKeys, doc.text)),
      agent: strategy(count(full), 1, coverage(wholeKeys, full)),
      brief: strategy(count(brief), 1, coverage(wholeKeys, brief)),
      read: strategy(count(readText), 1, coverage(wholeKeys, readText)),
    },
    ...(cross ? { cross } : {}),
  };
}

// Documents: the test samples, optionally the RFCs and requirements in docs/, and larger documents built from the samples

function smdFiles(dir: string): Doc[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.smd')).sort()
    .map((f) => ({ name: path.relative(repo, path.join(dir, f)).replace(/\\/g, '/'), text: fs.readFileSync(path.join(dir, f), 'utf8'), dir, file: path.join(dir, f) }));
}

/**
 * A document of about `target` tokens made from the samples' bodies, one after another. Like a real large
 * spec it keeps one `:::agent` block (the first) and unique headings (each sample's are numbered).
 */
export function composite(target: number, count: (t: string) => number): Doc {
  const dir = samplesDir;
  const bodies = smdFiles(dir).map((d) => d.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
  const parts = ['---\nsmd: 1\ntitle: Composite\nsummary: Example documents one after another, for the size benchmark.\nstatus: draft\n---\n'];
  let agentKept = false;
  for (let i = 0; count(parts.join('')) < target; i++) {
    const lines = bodies[i % bodies.length].split(/\r?\n/);
    const out: string[] = [];
    let fence = '';
    let skipUntil: RegExp | undefined;
    for (const line of lines) {
      if (skipUntil) {
        if (skipUntil.test(line)) skipUntil = undefined;
        continue;
      }
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f && (!fence || f[1].startsWith(fence))) fence = fence ? '' : f[1];
      if (!fence) {
        const agent = /^(:{3,})\s*agent\b/.exec(line);
        if (agent && agentKept) {
          skipUntil = new RegExp(`^${agent[1]}\\s*$`);
          continue;
        }
        if (agent) agentKept = true;
        const h = /^(#{1,6})\s+(.*?)(\s*\{[^}]*\})?\s*$/.exec(line);
        if (h) {
          out.push(`${h[1]} ${h[2]} (${i + 1})${h[3] ?? ''}`);
          continue;
        }
      }
      out.push(line);
    }
    parts.push(`\n${out.join('\n')}\n`);
  }
  return { name: `composite ≈${Math.round(target / 1000)}k`, text: parts.join(''), dir };
}

/** Least-squares line through (raw size, tokens): tokens ≈ a + b · raw. */
function fit(points: Array<[number, number]>): { a: number; b: number } {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  const sxx = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const b = sxx ? points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx : 0;
  return { a: my - b * mx, b };
}

/** The raw size from which `tools + fixed` costs less than reading the raw file (one call), or undefined if never. */
export function breakEven(line: { a: number; b: number }, fixed: number): number | undefined {
  if (line.b >= 1) return undefined;
  return Math.max(0, (line.a + fixed - CALL) / (1 - line.b));
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const saving = (tools: number, raw: number) => `${Math.round((1 - tools / raw) * 100)}%`;

function report(results: DocResult[], sized: DocResult[], fixed: FixedCosts, readerViaCli: boolean, tokenizer: string): string {
  const out: string[] = [];
  const skillFixed = fixed.descriptions + fixed.readerSkill;
  out.push(`Tokens: ${tokenizer}. Each tool call adds ${CALL} tokens. Today: ${TODAY}. smd read: ${readerViaCli ? 'the CLI' : 'emulated (agent view ≤ 2,000 tokens, else outline)'}.`, '');
  out.push('### Fixed costs', '', '| Overhead | When it is paid | ≈ tokens |', '|---|---|---:|');
  out.push(`| Skill descriptions (reader + writer) | every Claude Code session | ${n(fixed.descriptions)} |`);
  out.push(`| Reader \`SKILL.md\` | when the reader skill triggers | ${n(fixed.readerSkill)} |`);
  out.push(`| \`agent-rules.md\` (as installed) | every session (AGENTS.md) or when a .smd file is in context (Cursor, Copilot) | ${n(fixed.agentRules)} |`);
  out.push(`| MCP \`tools/list\` + instructions | every session with the server | ${n(fixed.mcp)} |`);
  out.push(`| Writer \`SKILL.md\` | when the writer skill triggers | ${n(fixed.writer.skill)} |`);
  out.push(`| Writer syntax index + one topic (median) | when the writer needs syntax | ${n(fixed.writer.syntaxIndex)} + ${n(fixed.writer.syntaxTopicMedian)} |`);
  out.push(`| Writer style guide | when the writer reads it | ${n(fixed.writer.styleGuide)} |`, '');
  out.push(`MCP source: ${fixed.mcpSource}.`, '');

  out.push('### (a) Answer a question about one section', '');
  out.push('Median over each document\'s sections. Coverage: share of the section\'s key lines present in what was read (a proxy for accuracy).', '');
  out.push('| Document | raw | sections | Read raw | outline + section | `smd read` (+ section) | saving | + skill fixed | coverage raw / outline+section / read |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const r of results) {
    const s = r.section;
    out.push(`| ${r.name} | ${n(r.raw)} | ${r.sections} | ${n(s.raw.tokens)} | ${n(s.outlineSection.tokens)} | ${n(s.read.tokens)} | ${saving(s.read.tokens, s.raw.tokens)} | ${saving(s.read.tokens + skillFixed, s.raw.tokens)} | ${pct(s.raw.coverage)} / ${pct(s.outlineSection.coverage)} / ${pct(s.read.coverage)} |`);
  }
  out.push('', '### (b) Understand the whole document', '');
  out.push('| Document | Read raw | agent view | `--brief` | `smd read` | agent view saving | `--brief` saving | coverage raw / agent / brief / read |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const r of results) {
    const w = r.whole;
    out.push(`| ${r.name} | ${n(w.raw.tokens)} | ${n(w.agent.tokens)} | ${n(w.brief.tokens)} | ${n(w.read.tokens)} | ${saving(w.agent.tokens, w.raw.tokens)} | ${saving(w.brief.tokens, w.raw.tokens)} | ${pct(w.raw.coverage)} / ${pct(w.agent.coverage)} / ${pct(w.brief.coverage)} / ${pct(w.read.coverage)} |`);
  }

  out.push('', '### (c) Answer a question that needs several sections', '');
  out.push('Every block of the type found in the most sections: outline, then each section (one call each, or one call naming them all), against one `smd query "<type>" --constraints`. Documents where no type spans two sections are left out.', '');
  out.push('| Document | raw | type | matches | sections | outline + sections (calls) | outline + sections, one call | `smd query` | saving vs per-section | coverage per-section / one call / query |');
  out.push('|---|---:|---|---:|---:|---:|---:|---:|---:|---|');
  for (const r of [...results, ...sized]) {
    const c = r.cross;
    if (!c) continue;
    out.push(`| ${r.name} | ${n(r.raw)} | \`${c.type}\` | ${c.matches} | ${c.sections} | ${n(c.outlineSections.tokens)} (${c.outlineSections.calls}) | ${n(c.outlineSectionsOneCall.tokens)} | ${n(c.query.tokens)} | ${saving(c.query.tokens, c.outlineSections.tokens)} | ${pct(c.outlineSections.coverage)} / ${pct(c.outlineSectionsOneCall.coverage)} / ${pct(c.query.coverage)} |`);
  }

  const all = [...results, ...sized].sort((x, y) => x.raw - y.raw);
  out.push('', '### By document size', '');
  out.push('Examples and documents built from them. Net = raw read minus (tools + fixed cost), for one read in a session; positive means the tools save.', '');
  out.push('| Document | raw | (a) `smd read` + section | (a) net, no fixed | (a) net, skill | (b) `--brief` | (b) net, no fixed | (b) net, skill |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of all) {
    const a = r.section.read.tokens;
    const b = r.whole.brief.tokens;
    const raw = r.section.raw.tokens;
    out.push(`| ${r.name} | ${n(r.raw)} | ${n(a)} | ${n(raw - a)} | ${n(raw - a - skillFixed)} | ${n(b)} | ${n(raw - b)} | ${n(raw - b - skillFixed)} |`);
  }

  out.push('', '### Break-even', '');
  out.push('Raw document size (tokens) above which the tools cost less than reading the file, from a straight-line fit of tool cost against raw size over all documents above. "Skill" is the reader skill (descriptions + SKILL.md); with 5 reads in one session the fixed cost is shared by 5.', '');
  out.push('| Task and method | no fixed cost | skill, 1 read | skill, 5 reads | agent rules | MCP |', '|---|---:|---:|---:|---:|---:|');
  const rows: Array<[string, (r: DocResult) => number]> = [
    ['(a) one section: outline + section', (r) => r.section.outlineSection.tokens],
    ['(a) one section: `smd read` (+ section)', (r) => r.section.read.tokens],
    ['(b) whole doc: agent view', (r) => r.whole.agent.tokens],
    ['(b) whole doc: `--brief`', (r) => r.whole.brief.tokens],
  ];
  for (const [label, cost] of rows) {
    const line = fit(all.map((r) => [r.raw, cost(r)]));
    const be = (fixedCost: number) => {
      const x = breakEven(line, fixedCost);
      return x === undefined ? 'never' : n(Math.ceil(x / 100) * 100);
    };
    out.push(`| ${label} | ${be(0)} | ${be(skillFixed)} | ${be(skillFixed / 5)} | ${be(fixed.agentRules)} | ${be(fixed.mcp)} |`);
  }
  out.push('', `Fit: tool cost ≈ a + b × raw. Raw reads cost raw + ${CALL}.`);
  return out.join('\n') + '\n';
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function gitOut(args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * What a run depends on, for the `--json` report: the commit (and whether the tree had changes), the CLI build's hash,
 * Node and the OS, the reader mode, the date, the tokenizer for counting and for `smd read`'s routing, the assumed
 * per-call cost, the arguments and each document's hash.
 */
export function runRecord(reader: Reader, tokenizer: Tokenizer | undefined, docs: Doc[], args: string[]) {
  return {
    commit: gitOut(['rev-parse', 'HEAD']) ?? null,
    dirty: (gitOut(['status', '--porcelain', '--', 'extension/src', 'extension/test/bench', 'skills', 'extension/test/samples', 'docs']) ?? '') !== '',
    cli: fs.existsSync(cli) ? { file: 'extension/dist/cli.js', sha256: sha256(fs.readFileSync(cli)) } : null,
    node: process.version,
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    reader: reader.mode,
    today: TODAY,
    tokenizer: tokenizer?.name ?? 'estimate (≈ characters / 4)',
    routing: tokenizer ? `smd read routes on ${tokenizer.name} counts` : 'smd read routes on the estimate',
    callTokens: CALL,
    args,
    documents: docs.map((d) => ({ name: d.name, sha256: sha256(d.text) })),
  };
}

async function main(args: string[]): Promise<void> {
  const tokName = args.includes('--tokenizer') ? args[args.indexOf('--tokenizer') + 1] : undefined;
  const tokenizer: Tokenizer | undefined = tokName ? loadTokenizer(tokName) : undefined;
  const count = tokenizer ? tokenizer.count : estimateTokens;
  const label = tokenizer ? `${tokenizer.name} (exact OpenAI encoding; approximate for Claude)` : '≈ characters / 4 (estimateTokens, as smd outline)';

  const readerArg = args.includes('--reader') ? args[args.indexOf('--reader') + 1] : undefined;
  if (readerArg !== undefined && readerArg !== 'cli' && readerArg !== 'in-process') throw new Error('--reader takes cli or in-process.');
  const docs = smdFiles(samplesDir);
  if (args.includes('--docs')) for (const dir of ['rfcs', 'requirements']) docs.push(...smdFiles(path.join(repo, 'docs', dir)));
  const reader = new Reader(readerArg, tokenizer);
  const results = docs.map((d) => measure(d, reader, count));
  const composites = [4000, 8000, 16000, 32000].map((t) => composite(t, count));
  const sized = composites.map((d) => measure(d, reader, count));
  const fixed = await fixedCosts(count);
  if (args.includes('--json')) {
    const run = runRecord(reader, tokenizer, [...docs, ...composites], args);
    process.stdout.write(JSON.stringify({ run, tokenizer: label, call: CALL, fixed, results, sized }, null, 2) + '\n');
    return;
  }
  process.stdout.write(report(results, sized, fixed, reader.viaCli, label));
}

if (require.main === module) void main(process.argv.slice(2));
