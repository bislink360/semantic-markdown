import { normalizePath, resolvePath } from './graph';
import { splitIdRef } from './idTarget';
import type { TaskInfo } from './meta';

/**
 * Task order by declared prerequisites. A task's prerequisites are the tasks its `:depends[…]` names by their `{#id}`:
 * `T1` in the same file, or `plan.smd#T1` in the file that path names from the task's own (semantic tags R19). An id
 * two tasks of a file give names neither, and ids of other blocks (a requirement, a question) order nothing.
 * Prerequisites that aren't among the rows (a done task left out of `smd tasks`, a file not listed) order nothing
 * either.
 */

type Row = TaskInfo & { file?: string };

/** For each row, the indexes of the rows it depends on, in row order. */
export function taskPrerequisites(rows: readonly Row[]): number[][] {
  const byId = new Map<string, number | null>();
  const fileKey = (file: string | undefined) => (file ? normalizePath(file) : '');
  rows.forEach((r, i) => {
    if (!r.id) return;
    const key = `${fileKey(r.file)}\0${r.id}`;
    byId.set(key, byId.has(key) ? null : i); // null: ambiguous
  });
  return rows.map((r, i) => {
    const found = (r.depends ?? []).map((written) => {
      const { path, id } = splitIdRef(written);
      if (!path) return byId.get(`${fileKey(r.file)}\0${id}`);
      return r.file ? byId.get(`${resolvePath(r.file, path)}\0${id}`) : undefined;
    });
    return [...new Set(found.filter((j): j is number => typeof j === 'number' && j !== i))].sort((a, b) => a - b);
  });
}

/**
 * The prerequisites of each row without those inside a dependency cycle, which can't all come first: what a chart
 * can draw as "after" without going round in a circle.
 */
export function acyclicPrerequisites(rows: readonly Row[]): number[][] {
  const before = taskPrerequisites(rows);
  const groupOf = new Array<number>(rows.length);
  cycles(before).forEach((g, n) => { for (const i of g) groupOf[i] = n; });
  return before.map((p, i) => p.filter((j) => groupOf[j] !== groupOf[i]));
}

/**
 * The rows with every task after the tasks it depends on, otherwise in the order given: of the tasks that are ready,
 * the one that comes first in `rows` goes next. Tasks in a dependency cycle can't all go after each other, so they
 * keep their order among themselves and move as one, after what the cycle depends on.
 */
export function orderByPrerequisites<T extends Row>(rows: readonly T[]): T[] {
  const before = taskPrerequisites(rows);
  if (before.every((p) => !p.length)) return [...rows];
  const groups = cycles(before);
  const groupOf = new Array<number>(rows.length);
  groups.forEach((g, n) => { for (const i of g) groupOf[i] = n; });
  // How many groups each group waits for, and which groups wait for it.
  const waiting = groups.map(() => new Set<number>());
  const unblocks = groups.map(() => new Set<number>());
  before.forEach((prerequisites, i) => {
    for (const j of prerequisites) {
      if (groupOf[i] === groupOf[j]) continue;
      waiting[groupOf[i]].add(groupOf[j]);
      unblocks[groupOf[j]].add(groupOf[i]);
    }
  });
  const ready = groups.map((_, n) => n).filter((n) => !waiting[n].size);
  const out: T[] = [];
  while (ready.length) {
    // The ready group whose first task comes first (groups list their tasks in row order).
    let pick = 0;
    for (let k = 1; k < ready.length; k++) if (groups[ready[k]][0] < groups[ready[pick]][0]) pick = k;
    const [n] = ready.splice(pick, 1);
    for (const i of groups[n]) out.push(rows[i]);
    for (const m of unblocks[n]) {
      waiting[m].delete(n);
      if (!waiting[m].size) ready.push(m);
    }
  }
  return out;
}

/**
 * The strongly connected components of the graph (Tarjan's algorithm, without recursion), each as row indexes in
 * row order: a task on its own, or the tasks of a dependency cycle.
 */
function cycles(before: readonly number[][]): number[][] {
  const index = new Array<number>(before.length).fill(-1);
  const low = new Array<number>(before.length).fill(0);
  const onStack = new Array<boolean>(before.length).fill(false);
  const stack: number[] = [];
  const groups: number[][] = [];
  let next = 0;
  for (let root = 0; root < before.length; root++) {
    if (index[root] >= 0) continue;
    const walk: Array<{ v: number; edge: number }> = [{ v: root, edge: 0 }];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = true;
    while (walk.length) {
      const top = walk[walk.length - 1];
      const w = before[top.v][top.edge++];
      if (w !== undefined) {
        if (index[w] < 0) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = true;
          walk.push({ v: w, edge: 0 });
        } else if (onStack[w]) {
          low[top.v] = Math.min(low[top.v], index[w]);
        }
        continue;
      }
      walk.pop();
      if (walk.length) low[walk[walk.length - 1].v] = Math.min(low[walk[walk.length - 1].v], low[top.v]);
      if (low[top.v] !== index[top.v]) continue;
      const group: number[] = [];
      let w2: number;
      do {
        w2 = stack.pop()!;
        onStack[w2] = false;
        group.push(w2);
      } while (w2 !== top.v);
      groups.push(group.sort((a, b) => a - b));
    }
  }
  return groups;
}
