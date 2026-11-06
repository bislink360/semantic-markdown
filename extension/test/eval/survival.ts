import type { Tokenizer } from '../../src/core';
import { renderDoc, taskItems, type Rendered } from './conditions';
import { evidenceFound, type Corpus } from './corpus';
import type { ItemKind } from './types';

/**
 * Evidence survival: for each condition and annotation item, does the item's evidence appear in what the condition
 * shows? A deterministic projection check with no model. It is NOT task accuracy: an item can be shown and still be
 * misread, and text search cannot tell copies of a phrase apart.
 */

export const SURVIVAL_LABEL = 'Evidence survival: a deterministic projection check (no model). Not task accuracy.';

export interface SurvivalCell {
  doc: string;
  condition: string;
  /** For conditions that depend on the task. */
  task?: string;
  item: string;
  kind: ItemKind;
  /** Every evidence entry appears. */
  visible: boolean;
  /** How many of the evidence entries appear. */
  found: number;
  of: number;
  tokensEstimate: number;
}

export interface SurvivalAggregate { condition: string; visible: number; total: number; rate: number; byKind: Record<string, { visible: number; total: number }> }

export interface SurvivalReport {
  label: string;
  cells: SurvivalCell[];
  aggregate: SurvivalAggregate[];
}

function cellsFor(r: Rendered, items: Corpus['docs'][number]['annotations']['items']): SurvivalCell[] {
  return items.map((item) => {
    const found = evidenceFound(r.shown, item);
    const n = found.filter(Boolean).length;
    return {
      doc: r.doc, condition: r.condition, ...(r.task ? { task: r.task } : {}), item: item.id, kind: item.kind,
      visible: n === found.length, found: n, of: found.length, tokensEstimate: r.tokensEstimate,
    };
  });
}

export function survival(corpus: Corpus, tokenizer?: Tokenizer): SurvivalReport {
  const cells: SurvivalCell[] = [];
  for (const doc of corpus.docs) {
    const { doc: docViews, tasks } = renderDoc(corpus, doc, tokenizer);
    for (const r of docViews) cells.push(...cellsFor(r, doc.annotations.items));
    for (const task of doc.tasks) {
      const items = taskItems(doc, task);
      for (const r of tasks.get(task.id) ?? []) cells.push(...cellsFor(r, items));
    }
  }
  return { label: SURVIVAL_LABEL, cells, aggregate: aggregate(cells) };
}

function aggregate(cells: SurvivalCell[]): SurvivalAggregate[] {
  const by = new Map<string, SurvivalAggregate>();
  for (const c of cells) {
    const a = by.get(c.condition) ?? { condition: c.condition, visible: 0, total: 0, rate: 0, byKind: {} };
    a.total++;
    if (c.visible) a.visible++;
    const k = (a.byKind[c.kind] ??= { visible: 0, total: 0 });
    k.total++;
    if (c.visible) k.visible++;
    by.set(c.condition, a);
  }
  return [...by.values()].map((a) => ({ ...a, rate: a.total ? a.visible / a.total : 0 }));
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(head), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...rows.map(line)];
}

/** Markdown tables: per document (items × document conditions, then task × item × task conditions), then the aggregate. */
export function survivalText(r: SurvivalReport): string {
  const out = [`# ${r.label}`, '', 'yes = every evidence entry appears; n/m = how many appear when not all do.', ''];
  const mark = (c: SurvivalCell) => (c.visible ? 'yes' : `${c.found}/${c.of}`);
  for (const doc of [...new Set(r.cells.map((c) => c.doc))]) {
    const docCells = r.cells.filter((c) => c.doc === doc);
    out.push(`## ${doc}`, '');
    const plain = docCells.filter((c) => !c.task);
    const conds = [...new Set(plain.map((c) => c.condition))];
    const items = [...new Set(plain.map((c) => c.item))];
    out.push(...table(['item', 'kind', ...conds], items.map((id) => {
      const row = plain.filter((c) => c.item === id);
      return [id, row[0].kind, ...conds.map((cond) => mark(row.find((c) => c.condition === cond)!))];
    })), '');
    const perTask = docCells.filter((c) => c.task);
    if (perTask.length) {
      const tconds = [...new Set(perTask.map((c) => c.condition))];
      const keys = [...new Set(perTask.map((c) => `${c.task}\u0000${c.item}`))];
      out.push(...table(['task', 'item', ...tconds], keys.map((key) => {
        const [task, item] = key.split('\u0000');
        const row = perTask.filter((c) => c.task === task && c.item === item);
        return [task, item, ...tconds.map((cond) => mark(row.find((c) => c.condition === cond)!))];
      })), '');
    }
  }
  out.push('## Aggregate per condition', '', 'Document conditions count items; task conditions count (task, item) pairs.', '');
  const kinds = [...new Set(r.cells.map((c) => c.kind))];
  out.push(...table(['condition', 'visible', 'total', 'rate', ...kinds], r.aggregate.map((a) => [
    a.condition, String(a.visible), String(a.total), pct(a.visible, a.total), ...kinds.map((k) => (a.byKind[k] ? `${a.byKind[k].visible}/${a.byKind[k].total}` : '-')),
  ])));
  return out.join('\n') + '\n';
}
