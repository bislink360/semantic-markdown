import { validateSmd } from '../../src/core';
import {
  evidenceLabel, evidencePattern, isSpan, linesOf, loadCorpus, normalise, spanText, type Corpus, type CorpusDoc,
} from './corpus';
import { markupSimilarity } from './markup';
import { ITEM_KINDS, TASK_TYPES, type AnnotationItem, type Span, type Task } from './types';

/**
 * Checks a corpus before any run: ids, spans, evidence inside the spans of both formats, task references and expected
 * answers. The similarity of the `.smd` text without markup to the `.md` text is reported, not enforced.
 */

export interface DocReport {
  doc: string;
  items: number;
  tasks: number;
  /** 1 when the `.smd` text without markup has the same lines as the `.md` text (see markupSimilarity). */
  similarity: number;
  errors: string[];
  warnings: string[];
}

export interface ValidationReport {
  corpus: string;
  docs: DocReport[];
  /** Problems with the corpus as a whole: loading, task ids repeated across documents. */
  errors: string[];
  ok: boolean;
}

/** Item kinds a constraint check may cite. */
const CONSTRAINT_KINDS = new Set(['constraint', 'negation', 'limit']);

function checkSpan(span: unknown, text: string, where: string, errors: string[]): span is Span {
  if (!isSpan(span)) { errors.push(`${where}: span must be [start, end], 1-based, start <= end`); return false; }
  const total = linesOf(text).length;
  if (span[1] > total) { errors.push(`${where}: span [${span.join(', ')}] is past the end (${total} lines)`); return false; }
  return true;
}

function checkItem(doc: CorpusDoc, item: AnnotationItem, errors: string[], warnings: string[]): void {
  const at = `item ${item.id ?? '(no id)'}`;
  if (typeof item.id !== 'string' || !item.id) errors.push(`${at}: needs an id`);
  if (!ITEM_KINDS.includes(item.kind)) errors.push(`${at}: kind must be one of ${ITEM_KINDS.join(', ')}`);
  if (!item.annotator) errors.push(`${at}: needs an annotator`);
  if (!Array.isArray(item.evidence) || !item.evidence.length) { errors.push(`${at}: needs evidence`); return; }
  const patterns: Array<RegExp | undefined> = item.evidence.map((e) => {
    try { return evidencePattern(e); } catch (err) { errors.push(`${at}: evidence ${evidenceLabel(e)} is not a valid regex (${(err as Error).message})`); return undefined; }
  });
  for (const format of ['md', 'smd'] as const) {
    const text = doc[format];
    if (!checkSpan(item[format], text, `${at} (${format})`, errors)) continue;
    const inside = normalise(spanText(text, item[format]));
    const lines = linesOf(text);
    const outside = normalise([...lines.slice(0, item[format][0] - 1), '', ...lines.slice(item[format][1])].join('\n'));
    item.evidence.forEach((e, k) => {
      const re = patterns[k];
      if (!re) return;
      if (!re.test(inside)) errors.push(`${at}: evidence ${evidenceLabel(e)} is not in doc.${format} L${item[format].join('-')}`);
      else if (re.test(outside)) warnings.push(`${at}: evidence ${evidenceLabel(e)} also appears outside the span in doc.${format}; the survival check cannot tell the copies apart`);
    });
  }
}

const nonEmpty = (list: unknown) => Array.isArray(list) && list.length > 0 && list.every((s) => typeof s === 'string' && s.trim());

function checkExpected(doc: CorpusDoc, task: Task, items: Map<string, AnnotationItem>, errors: string[]): void {
  const at = `task ${task.id}`;
  const e = task.expected as unknown as Record<string, unknown> | undefined;
  if (!e || typeof e !== 'object') { errors.push(`${at}: needs "expected"`); return; }
  switch (task.type) {
    case 'fact-lookup':
      if (!nonEmpty(e.accepted)) errors.push(`${at}: expected.accepted must list accepted answers`);
      break;
    case 'constraint-check': {
      if (!nonEmpty(e.verdict)) errors.push(`${at}: expected.verdict must list accepted verdicts`);
      const c = items.get(String(e.constraint));
      if (!c) errors.push(`${at}: expected.constraint must be an item id`);
      else if (!CONSTRAINT_KINDS.has(c.kind)) errors.push(`${at}: expected.constraint ${c.id} is a ${c.kind}, not a constraint, negation or limit`);
      else if (!task.items.includes(c.id)) errors.push(`${at}: expected.constraint ${c.id} must also be in items`);
      break;
    }
    case 'decision-status':
      if (!nonEmpty(e.option)) errors.push(`${at}: expected.option must list accepted spellings`);
      if (!nonEmpty(e.superseded)) errors.push(`${at}: expected.superseded must list the superseded or rejected options`);
      break;
    case 'open-question':
      if (!nonEmpty(e.fallback)) errors.push(`${at}: expected.fallback must list accepted spellings of the fallback`);
      break;
    case 'qualification': {
      const rubric = e.rubric as Array<{ id?: string; text?: string; items?: string[] }> | undefined;
      if (!Array.isArray(rubric) || !rubric.length) { errors.push(`${at}: expected.rubric must list rubric entries`); break; }
      for (const r of rubric) {
        if (!r.id || !r.text) errors.push(`${at}: every rubric entry needs an id and text`);
        for (const id of r.items ?? []) if (!items.has(id)) errors.push(`${at}: rubric ${r.id} names unknown item ${id}`);
      }
      break;
    }
    case 'edit-plan':
      for (const format of ['md', 'smd'] as const) {
        const spans = e[format];
        if (!Array.isArray(spans) || !spans.length) errors.push(`${at}: expected.${format} must list line spans`);
        else spans.forEach((s, k) => checkSpan(s, doc[format], `${at} expected.${format}[${k}]`, errors));
      }
      break;
  }
}

function checkTask(doc: CorpusDoc, task: Task, items: Map<string, AnnotationItem>, errors: string[]): void {
  const at = `task ${task.id ?? '(no id)'}`;
  if (typeof task.id !== 'string' || !task.id) errors.push(`${at}: needs an id`);
  if (!TASK_TYPES.includes(task.type)) { errors.push(`${at}: type must be one of ${TASK_TYPES.join(', ')}`); return; }
  if (!task.prompt?.trim()) errors.push(`${at}: needs a prompt`);
  if (!Array.isArray(task.items) || !task.items.length) errors.push(`${at}: needs items`);
  for (const id of task.items ?? []) if (!items.has(id)) errors.push(`${at}: unknown item ${id}`);
  for (const v of task.violations ?? []) {
    const c = items.get(v.item);
    if (!c) errors.push(`${at}: violation names unknown item ${v.item}`);
    else if (!CONSTRAINT_KINDS.has(c.kind)) errors.push(`${at}: violation item ${c.id} is a ${c.kind}, not a constraint, negation or limit`);
    if (!nonEmpty(v.answers)) errors.push(`${at}: violation for ${v.item} must list answers`);
  }
  checkExpected(doc, task, items, errors);
}

export function validateDoc(doc: CorpusDoc): DocReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const items = new Map<string, AnnotationItem>();
  for (const item of doc.annotations.items) {
    if (items.has(item.id)) errors.push(`item ${item.id}: id used twice`);
    items.set(item.id, item);
    checkItem(doc, item, errors, warnings);
  }
  const taskIds = new Set<string>();
  for (const task of doc.tasks) {
    if (taskIds.has(task.id)) errors.push(`task ${task.id}: id used twice`);
    taskIds.add(task.id);
    checkTask(doc, task, items, errors);
  }
  const used = new Set(doc.tasks.flatMap((t) => t.items ?? []));
  const unused = [...items.keys()].filter((id) => !used.has(id));
  if (unused.length) warnings.push(`items no task uses: ${unused.join(', ')}`);
  const smdErrors = validateSmd(doc.smd).filter((d) => d.severity === 'error');
  if (smdErrors.length) warnings.push(`doc.smd has ${smdErrors.length} validation error(s), first: L${smdErrors[0].line + 1} ${smdErrors[0].message}`);
  return { doc: doc.name, items: items.size, tasks: doc.tasks.length, similarity: markupSimilarity(doc.md, doc.smd), errors, warnings };
}

export function validateCorpus(corpus: Corpus): ValidationReport {
  const errors = corpus.problems.map((p) => `${p.doc}: ${p.message}`);
  if (!corpus.docs.length && !errors.length) errors.push('no document folders');
  const docs = corpus.docs.map(validateDoc);
  const seen = new Map<string, string>();
  for (const doc of corpus.docs) {
    for (const t of doc.tasks) {
      const other = seen.get(t.id);
      if (other && other !== doc.name) errors.push(`task ${t.id} is in both ${other} and ${doc.name}; task ids must be unique across the corpus`);
      seen.set(t.id, doc.name);
    }
  }
  return { corpus: corpus.dir, docs, errors, ok: !errors.length && docs.every((d) => !d.errors.length) };
}

export const validatePath = (dir: string) => validateCorpus(loadCorpus(dir));

export function validationText(r: ValidationReport): string {
  const out = [`Corpus ${r.corpus}: ${r.docs.length} document(s)`];
  for (const e of r.errors) out.push(`  error: ${e}`);
  for (const d of r.docs) {
    out.push(`${d.doc}: ${d.items} items, ${d.tasks} tasks, similarity ${d.similarity.toFixed(3)} (smd without markup vs md)`);
    for (const e of d.errors) out.push(`  error: ${e}`);
    for (const w of d.warnings) out.push(`  warning: ${w}`);
  }
  const errors = r.errors.length + r.docs.reduce((n, d) => n + d.errors.length, 0);
  out.push(r.ok ? 'OK' : `${errors} error(s)`);
  return out.join('\n') + '\n';
}
