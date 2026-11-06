import { agentView, outline, type AgentViewOptions, type AgentViewResult, type Tokenizer } from '../../src/core';
import { readDocument } from '../../src/readView';
import { corpusReader, DEFAULT_TODAY, estimate, type Corpus, type CorpusDoc } from './corpus';
import { documentSections, plainBlocks, sectionsHolding, withoutAgentBlocks, withoutSkipMarks } from './markup';
import { mdRead, transcriptResults, transcriptText, type MdReadArgs, type ToolCall, type Transcript } from './mdTool';
import type { AnnotationItem, Task } from './types';

/**
 * What each study condition shows, rendered offline and deterministically. Conditions where the model navigates
 * (M2, S3) can only be rendered here with the oracle choice (the sections holding the task's items); the variant where
 * the model chooses needs a model run and is recorded from its transcript.
 */

export const DOC_CONDITIONS = ['M1', 'M2-outline', 'S1', 'S2', 'S4-brief', 'S4-budget'] as const;
export const TASK_CONDITIONS = ['M2-oracle', 'S3-oracle', 'O'] as const;
export const ABLATIONS = ['all-audiences', 'plain-blocks', 'no-agent-block', 'no-doc-context'] as const;
export type Ablation = (typeof ABLATIONS)[number];

export const CONDITION_NOTES: Record<string, string> = {
  M1: 'Plain Markdown, whole file.',
  'M2-outline': 'M2 first call only: the heading list. M2 itself needs a model run.',
  'M2-oracle': 'M2 with the oracle choice: heading list, then the sections holding the task items. The agent-chosen M2 needs a model run.',
  S1: '.smd raw file.',
  S2: 'Whole agent view.',
  'S3-oracle': 'MCP read outline, then the sections holding the task items. The agent-chosen S3 needs a model run.',
  'S4-brief': 'Brief agent view.',
  'S4-budget': 'Agent view with maxTokens at half the full view.',
  O: 'Agent view of the sections holding the task items, handed over.',
  'all-audiences': 'Ablation: :::human kept and {agent=skip} marks removed from the source.',
  'plain-blocks': 'Ablation: semantic block fences removed from the source (titles and text kept).',
  'no-agent-block': 'Ablation: :::agent blocks removed from the source.',
  'no-doc-context': 'Ablation: :::agent blocks outside the selected sections removed, so no document-wide instructions.',
};

export interface RenderContext {
  /** "Today" for agent views. */
  today: string;
  /** Reads includes relative to the document. */
  readFile: (rel: string) => string | undefined;
  /** An exact tokenizer, when one is loaded: adds `tokensCounted`. */
  tokenizer?: Tokenizer;
}

export function renderContext(corpus: Corpus, doc: CorpusDoc, tokenizer?: Tokenizer): RenderContext {
  return { today: corpus.config.today ?? DEFAULT_TODAY, readFile: corpusReader(corpus.dir, doc.dir), tokenizer };
}

/** One condition as shown to the model. */
export interface Rendered {
  condition: string;
  doc: string;
  /** For conditions that depend on the task. */
  task?: string;
  /** Whose line numbers the view uses, for line spans in answers. */
  format: 'md' | 'smd';
  /** What the render command writes: the view, or the transcript of tool calls. */
  text: string;
  /** What the model reads: the view, or the tool results only. */
  shown: string;
  /** Estimated tokens of `shown` (≈ characters / 4). An estimate, not provider usage. */
  tokensEstimate: number;
  /** `shown` counted with the loaded tokenizer, when one is given. Still not provider usage. */
  tokensCounted?: { tokenizer: string; tokens: number };
  transcript?: Transcript;
  /** Provider-independent metadata from the tool: sections resolved, skipped, missing, omitted by a budget. */
  meta: Record<string, unknown>;
  notes: string[];
}

function rendered(base: Omit<Rendered, 'tokensEstimate' | 'shown' | 'text' | 'notes' | 'meta'> & { text: string; shown?: string; meta?: Record<string, unknown>; notes?: string[] }, ctx: RenderContext): Rendered {
  const shown = base.shown ?? base.text;
  const out: Rendered = { ...base, shown, meta: base.meta ?? {}, notes: base.notes ?? [], tokensEstimate: estimate(shown) };
  if (ctx.tokenizer) out.tokensCounted = { tokenizer: ctx.tokenizer.name, tokens: ctx.tokenizer.count(shown) };
  return out;
}

const viewOptions = (ctx: RenderContext): AgentViewOptions => ({ readFile: ctx.readFile, today: ctx.today, file: 'doc.smd' });

/** What the agent view result says besides its text. */
function viewMeta(r: AgentViewResult): Record<string, unknown> {
  const meta: Record<string, unknown> = { viewTokens: r.tokens, fileTokens: r.originalTokens, skippedSections: r.skippedSections, missingSections: r.missingSections };
  if (r.resolvedSections) meta.resolvedSections = r.resolvedSections;
  if (r.budget) meta.budget = r.budget;
  return meta;
}

/** The source and view options an ablation uses. `selected`: zero-based section ranges, for no-doc-context. */
function ablated(smd: string, ablation: Ablation | undefined, selected: Array<[number, number]> = []): { text: string; includeHuman?: boolean } {
  switch (ablation) {
    case 'all-audiences': return { text: withoutSkipMarks(smd), includeHuman: true };
    case 'plain-blocks': return { text: plainBlocks(smd) };
    case 'no-agent-block': return { text: withoutAgentBlocks(smd) };
    case 'no-doc-context': return { text: withoutAgentBlocks(smd, (line) => !selected.some(([a, b]) => line >= a && line <= b)) };
    default: return { text: smd };
  }
}

/** The conditions that depend only on the document, with the S2 ablations (no-doc-context does not apply to a whole view). */
export function docConditions(doc: CorpusDoc, ctx: RenderContext): Rendered[] {
  const base = { doc: doc.name };
  const view = viewOptions(ctx);
  const s2 = agentView(doc.smd, view);
  const brief = agentView(doc.smd, { ...view, brief: true });
  const half = Math.floor(s2.tokens / 2);
  const budget = agentView(doc.smd, { ...view, maxTokens: half });
  const outlineCall: ToolCall = { tool: 'read', args: { file: 'doc.md', mode: 'outline' }, result: mdRead(doc.md, { file: 'doc.md', mode: 'outline' }) };
  const out: Rendered[] = [
    rendered({ ...base, condition: 'M1', format: 'md', text: doc.md }, ctx),
    rendered({ ...base, condition: 'M2-outline', format: 'md', text: transcriptText({ calls: [outlineCall] }), shown: outlineCall.result, transcript: { calls: [outlineCall] }, notes: [CONDITION_NOTES['M2-outline']] }, ctx),
    rendered({ ...base, condition: 'S1', format: 'smd', text: doc.smd }, ctx),
    rendered({ ...base, condition: 'S2', format: 'smd', text: s2.text, meta: viewMeta(s2) }, ctx),
    rendered({ ...base, condition: 'S4-brief', format: 'smd', text: brief.text, meta: viewMeta(brief) }, ctx),
    rendered({ ...base, condition: 'S4-budget', format: 'smd', text: budget.text, meta: { ...viewMeta(budget), maxTokens: half } }, ctx),
  ];
  for (const ablation of ABLATIONS) {
    if (ablation === 'no-doc-context') continue;
    const { text, includeHuman } = ablated(doc.smd, ablation);
    const r = agentView(text, { ...view, includeHuman });
    out.push(rendered({ ...base, condition: `S2.${ablation}`, format: 'smd', text: r.text, meta: viewMeta(r), notes: [CONDITION_NOTES[ablation]] }, ctx));
  }
  return out;
}

/** The items of a task, in task order, that exist. */
export function taskItems(doc: CorpusDoc, task: Task): AnnotationItem[] {
  const byId = new Map(doc.annotations.items.map((i) => [i.id, i]));
  return task.items.map((id) => byId.get(id)).filter((i): i is AnnotationItem => !!i);
}

/** Heading ids of the sections holding the items in one format, the zero-based ranges, and items above the first heading. */
function oracleSections(text: string, items: AnnotationItem[], format: 'md' | 'smd') {
  const sections = documentSections(text);
  const ids: string[] = [];
  const ranges: Array<[number, number]> = [];
  const unplaced: AnnotationItem[] = [];
  for (const item of items) {
    const held = sectionsHolding(sections, item[format]);
    if (!held.length) unplaced.push(item);
    for (const s of held) {
      if (ids.includes(s.heading.slug)) continue;
      ids.push(s.heading.slug);
      ranges.push([s.start, s.end]);
    }
  }
  return { ids, ranges, unplaced };
}

/** `read` as the MCP tool runs it, with `includeHuman` for the all-audiences ablation (readDocument has no such option). */
function smdRead(text: string, args: { mode?: 'outline' | 'full'; sections?: string[]; exact?: boolean }, ctx: RenderContext, includeHuman?: boolean): string {
  const view = viewOptions(ctx);
  if (!includeHuman) return readDocument(text, { ...view, mode: args.mode, sections: args.sections, exactSections: args.exact }).text;
  if (args.sections?.length) return agentView(text, { ...view, includeHuman, sections: args.sections, exactSections: args.exact }).text;
  if (args.mode === 'full') return agentView(text, { ...view, includeHuman }).text;
  return `${outline(text, { ...view, includeHuman }).trimEnd()}\n\nRead only the sections you need next.\n`;
}

/** Said when every item of a task is above the first heading, so no section holds it and the oracle reads the whole view. */
const WHOLE_VIEW_NOTE = 'Every item is above the first heading, so no section holds it: the oracle reads the whole view.';

function s3Oracle(doc: CorpusDoc, task: Task, ctx: RenderContext, ablation?: Ablation): Rendered {
  const items = taskItems(doc, task);
  const { ids, ranges, unplaced } = oracleSections(doc.smd, items, 'smd');
  const outlineSource = ablation === 'no-doc-context' ? { text: doc.smd } : ablated(doc.smd, ablation);
  // A whole view has no document-wide part to leave out.
  const sectionSource = ablation === 'no-doc-context' && !ids.length ? { text: doc.smd } : ablated(doc.smd, ablation, ranges);
  const calls: ToolCall[] = [{ tool: 'read', args: { file: 'doc.smd', mode: 'outline' }, result: smdRead(outlineSource.text, { mode: 'outline' }, ctx, outlineSource.includeHuman) }];
  const args = ids.length ? { file: 'doc.smd', sections: ids, exact: true } : { file: 'doc.smd', mode: 'full' as const };
  calls.push({ tool: 'read', args, result: smdRead(sectionSource.text, args, ctx, sectionSource.includeHuman) });
  const notes = [CONDITION_NOTES['S3-oracle'], ...(ablation ? [CONDITION_NOTES[ablation]] : [])];
  if (!ids.length) notes.push(WHOLE_VIEW_NOTE);
  else if (unplaced.length) notes.push(`Above the first heading, so in no section read (only :::agent blocks there still come along): ${unplaced.map((i) => i.id).join(', ')}.`);
  const transcript = { calls };
  return rendered({
    doc: doc.name, task: task.id, condition: ablation ? `S3-oracle.${ablation}` : 'S3-oracle', format: 'smd',
    text: transcriptText(transcript), shown: transcriptResults(transcript), transcript, meta: { sections: ids }, notes,
  }, ctx);
}

/** The conditions that depend on the task: M2 and S3 with the oracle choice, O, and the S3 ablations. */
export function taskConditions(doc: CorpusDoc, task: Task, ctx: RenderContext): Rendered[] {
  const items = taskItems(doc, task);
  const md = oracleSections(doc.md, items, 'md');
  const mdCalls: ToolCall[] = [{ tool: 'read', args: { file: 'doc.md', mode: 'outline' }, result: mdRead(doc.md, { file: 'doc.md', mode: 'outline' }) }];
  if (md.ids.length) {
    const args: MdReadArgs = { file: 'doc.md', sections: md.ids, exact: true };
    mdCalls.push({ tool: 'read', args: { ...args }, result: mdRead(doc.md, args) });
  }
  for (const item of md.unplaced) {
    const args: MdReadArgs = { file: 'doc.md', lines: item.md };
    mdCalls.push({ tool: 'read', args: { ...args }, result: mdRead(doc.md, args) });
  }
  const m2 = { calls: mdCalls };
  const smd = oracleSections(doc.smd, items, 'smd');
  const o = agentView(doc.smd, { ...viewOptions(ctx), ...(smd.ids.length ? { sections: smd.ids, exactSections: true } : {}) });
  const oNotes = [CONDITION_NOTES.O];
  if (!smd.ids.length) oNotes.push(WHOLE_VIEW_NOTE);
  else if (smd.unplaced.length) oNotes.push(`Above the first heading, so in no section (only :::agent blocks there still come along): ${smd.unplaced.map((i) => i.id).join(', ')}.`);
  return [
    rendered({
      doc: doc.name, task: task.id, condition: 'M2-oracle', format: 'md', text: transcriptText(m2), shown: transcriptResults(m2), transcript: m2,
      meta: { sections: md.ids }, notes: [CONDITION_NOTES['M2-oracle']],
    }, ctx),
    s3Oracle(doc, task, ctx),
    rendered({ doc: doc.name, task: task.id, condition: 'O', format: 'smd', text: o.text, meta: { ...viewMeta(o), sections: smd.ids }, notes: oNotes }, ctx),
    ...ABLATIONS.map((a) => s3Oracle(doc, task, ctx, a)),
  ];
}

/** Every condition of a document: the document ones, then each task's. */
export function renderDoc(corpus: Corpus, doc: CorpusDoc, tokenizer?: Tokenizer): { doc: Rendered[]; tasks: Map<string, Rendered[]> } {
  const ctx = renderContext(corpus, doc, tokenizer);
  return { doc: docConditions(doc, ctx), tasks: new Map(doc.tasks.map((t) => [t.id, taskConditions(doc, t, ctx)])) };
}
