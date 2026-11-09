/**
 * Document paths as the graph and the views compare them: `/` between folders, `.` and `..` resolved. Kept apart from
 * graph.ts, which re-exports them, so that modules the graph itself imports can use them too.
 */

/** `a/./b/../c` → `a/c` and backslashes → `/`. Leading `..` and a drive or `/` root stay. */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  const out: string[] = [];
  for (const seg of slashed.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..' && !/^[a-z]:$/i.test(out[out.length - 1])) out.pop();
    else out.push(seg);
  }
  return (slashed.startsWith('/') ? '/' : '') + out.join('/');
}

const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const isAbsolute = (p: string) => /^(?:[a-z]:)?[\\/]/i.test(p);

/** A link or include path written in document `from`, as a normalized path. */
export function resolvePath(from: string, target: string): string {
  if (isAbsolute(target)) return normalizePath(target);
  const dir = folderOf(normalizePath(from));
  return normalizePath(dir ? `${dir}/${target}` : target);
}
