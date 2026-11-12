
/**
 * Progress with a basis (research AF25, feedback-loop RFC "Progress with a basis"). `:progress{basis=tasks}` counts
 * the checked tasks of its section, `:progress{value=unknown}` is unknown progress, and `basis=measured|estimate`
 * says how a written value was found. A bar with none of these is read as before.
 */

/** The checked and total tasks a `basis=tasks` bar counts. */
export interface TaskCount { checked: number; total: number }

export type ProgressState =
  /** `basis=tasks`: the section's tasks; no percent when it has none. */
  | { kind: 'tasks'; checked: number; total: number; percent?: number }
  | { kind: 'unknown' }
  /** A written value with `basis=measured` or `basis=estimate`. */
  | { kind: 'value'; percent: number; basis: 'measured' | 'estimate' }
  /** A bar as it was before bases: read as before. */
  | { kind: 'plain' };

/** The basis written on a bar, in lower case, or undefined. */
export function progressBasis(values: Readonly<Record<string, string>>): string | undefined {
  return values.basis?.trim().toLowerCase() || undefined;
}

export const countsTasks = (values: Readonly<Record<string, string>>): boolean => progressBasis(values) === 'tasks';

/** Whether a written value says progress is unknown. */
export const isUnknownValue = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'unknown';

/** A written value as a percentage from 0 to 100 (0 when it is not a number), as bars always read it. */
export function writtenPercent(value: string | undefined, content = ''): number {
  const raw = Number.parseFloat(value ?? content ?? '0');
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
}

/** What a bar shows. `counts` are its section's tasks, for `basis=tasks`. */
export function progressState(values: Readonly<Record<string, string>>, content: string, counts?: TaskCount): ProgressState {
  const basis = progressBasis(values);
  if (basis === 'tasks') {
    const { checked, total } = counts ?? { checked: 0, total: 0 };
    return total ? { kind: 'tasks', checked, total, percent: Math.round((checked / total) * 100) } : { kind: 'tasks', checked, total };
  }
  if (isUnknownValue(values.value ?? content)) return { kind: 'unknown' };
  if (basis === 'measured' || basis === 'estimate') return { kind: 'value', percent: writtenPercent(values.value, content), basis };
  return { kind: 'plain' };
}

/** "8 of 10 tasks checked", "unknown", "40% (estimated)" in English: what agent views and `smd to-md` write. */
export function progressWords(state: Exclude<ProgressState, { kind: 'plain' }>): string {
  if (state.kind === 'tasks') return `${state.checked} of ${state.total} tasks checked`;
  if (state.kind === 'unknown') return 'unknown';
  return `${Math.round(state.percent)}% (${state.basis === 'measured' ? 'measured' : 'estimated'})`;
}

/** The agent view of a bar with a basis: `[progress 80%: 8 of 10 tasks checked]`, `[progress unknown]`, `[progress 40% (estimated)]`. */
export function progressTag(state: Exclude<ProgressState, { kind: 'plain' }>): string {
  if (state.kind === 'tasks') return `[progress${state.percent === undefined ? '' : ` ${state.percent}%`}: ${progressWords(state)}]`;
  return `[progress ${progressWords(state)}]`;
}
