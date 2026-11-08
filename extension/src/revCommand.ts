import * as fs from 'node:fs';
import { blockRevision } from './core/revision';

/**
 * `smd rev <file> <id>…`: the current revision of blocks, to record in `rev=` on a comment, a suggestion or an
 * evidence record (`rev=R1@3f2a9c1b0d4e`). A revision identifies the block's text, never who wrote it.
 */
export function runRev(file: string | undefined, ids: readonly string[], json: boolean): { stdout: string; stderr: string; code: number } {
  if (!file || !ids.length) return { stdout: '', stderr: 'Usage: smd rev <file.smd> <id>… [--json]\n', code: 2 };
  if (!fs.existsSync(file)) return { stdout: '', stderr: `Not found: ${file}\n`, code: 2 };
  const text = fs.readFileSync(file, 'utf8');
  const found: Array<{ id: string; revision: string; line: number }> = [];
  const problems: string[] = [];
  for (const id of ids) {
    const r = blockRevision(text, id);
    if (r.status === 'resolved') found.push({ id, revision: r.revision, line: r.line + 1 });
    else if (r.status === 'ambiguous') problems.push(`${id}: given by ${r.lines.length} blocks (lines ${r.lines.map((l) => l + 1).join(', ')}), so it names none of them`);
    else problems.push(`${id}: no block has this id`);
  }
  const stdout = json
    ? `${JSON.stringify(found, null, 2)}\n`
    : found.map((f) => `${f.id}@${f.revision}  [L${f.line}]`).join('\n') + (found.length ? '\n' : '');
  return { stdout, stderr: problems.map((p) => `${p}\n`).join(''), code: problems.length ? 1 : 0 };
}
