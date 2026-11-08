import { formatTaskViewInspection, formatTaskViewList, taskView, TaskViewError, type Provenance, type TaskViewOptions } from './core';

/** `smd agent <file> --view <name> [--inspect]` and `smd agent <file> --views`, as text and an exit code. */

export interface TaskViewFlags extends Omit<TaskViewOptions, 'file'> {
  /** The view to build, or undefined with `list`. */
  view?: string;
  /** List the views (`--views`). */
  list?: boolean;
  /** An account for people instead of the view (`--inspect`). */
  inspect?: boolean;
}

export interface TaskViewOutput { code: number; stdout: string; stderr: string; provenance?: Provenance }

export function runTaskView(text: string, file: string, flags: TaskViewFlags): TaskViewOutput {
  if (flags.list) return { code: 0, stdout: formatTaskViewList(text, file), stderr: '' };
  if (!flags.view || flags.view.startsWith('-')) return { code: 2, stdout: '', stderr: 'smd agent --view needs a view name, e.g. --view implement-r1. List them with --views.\n' };
  const { view, list: _list, inspect, ...options } = flags;
  let result;
  try {
    result = taskView(text, view, { ...options, file });
  } catch (e) {
    if (e instanceof TaskViewError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
  const notes: string[] = [];
  if (result.missingSections.length) notes.push(`[smd] no heading matches: ${result.missingSections.join(', ')}. Run "smd outline ${file}" to list sections.`);
  if (!result.view.complete) {
    const n = result.view.unsatisfied.length;
    const budget = result.budget && !result.budget.fits ? 'the required content does not fit the budget' : '';
    const parts = [n ? `${n} unsatisfied requirement${n === 1 ? '' : 's'}` : '', budget].filter(Boolean).join(', and ');
    notes.push(`[smd] warning: the view "${view}" is incomplete: ${parts}. --inspect lists them.`);
  }
  const unit = result.counted ? `${result.counted.tokenizer} tokens` : 'tokens';
  const size = result.counted ? `${result.counted.tokens}` : `≈${result.tokens}`;
  notes.push(`[smd] task view "${view}": ${size} ${unit}${result.budget ? ` of ${result.budget.maxTokens}` : ''}${result.view.complete ? ', complete' : ''}`);
  return {
    code: 0,
    stdout: inspect ? formatTaskViewInspection(result, file) : result.text,
    stderr: notes.map((l) => `${l}\n`).join(''),
    ...(result.provenance ? { provenance: result.provenance } : {}),
  };
}
