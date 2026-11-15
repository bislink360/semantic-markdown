// Output snapshots of the built CLI over both corpora and the focused fixtures (improvement roadmap t-01 and t-02).
// Each corpus file goes through `smd agent`, `smd validate --format json`, `smd export --to md` and
// `smd export --to html`. The requests add reads with budgets and sections: those test/snapshots/fixtures/requests.json
// lists, and every request of the read-contract cases in test/conformance/cases. Each run's exit status, stdout and
// stderr are recorded separately, as digests, in test/snapshots/corpus.json.
//
//   node scripts/snapshots.mjs                 check the built CLI against the snapshots (exit 1 on a difference)
//   node scripts/snapshots.mjs --diff [--base origin/main]
//                                              check, then build <base> in a temporary worktree and print a
//                                              unified diff of every case that changed
//   node scripts/snapshots.mjs --update        rewrite the snapshots from the built CLI
//   --only <text>                              only the cases whose key contains <text> (with --diff or a check)
//
// Runs are deterministic: the corpus is the tracked files, run from the repository root with relative,
// /-separated paths, a fixed date (--today), a fixed locale and time zone, and no SMD_* variables. The check refuses
// a CLI older than its sources. test/snapshots/README.md describes how to approve an intended difference.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = resolve(EXTENSION, '..');
export const SNAPSHOTS = join(EXTENSION, 'test', 'snapshots', 'corpus.json');
export const FORMAT = 1;

/** The fixed date every dated view is rendered for. */
export const TODAY = '2026-01-15';

/**
 * The corpora: tracked files under each folder, by extension. A folder named `parts` holds files the corpus files
 * include, which are read through them and are not corpus files themselves.
 */
export const CORPORA = [
  { name: 'compat', dir: 'extension/test/compat/corpus', extensions: ['.smd'] },
  { name: 'research', dir: 'research/data/corpus', extensions: ['.md', '.smd'] },
  { name: 'focused', dir: 'extension/test/snapshots/fixtures', extensions: ['.smd'] },
];

/** The focused fixtures' own requests: `{ requests: [{ file, name, argv }] }`, with `{file}` and `{today}` in argv. */
export const FOCUSED_REQUESTS = 'extension/test/snapshots/fixtures/requests.json';

/** The read-contract cases (t-64): each folder's case.json lists requests over its fixture files. */
export const CONFORMANCE = 'extension/test/conformance/cases';

/** The commands each file goes through, with `{file}` for its path. */
export const COMMANDS = {
  agent: ['agent', '{file}', '--today', TODAY],
  validate: ['validate', '{file}', '--format', 'json', '--today', TODAY],
  md: ['export', '{file}', '--to', 'md'],
  html: ['export', '{file}', '--to', 'html', '--today', TODAY],
};

/** The environment of every run: a fixed locale and time zone, nothing of smd's own, nothing else from the shell. */
export function runEnv(base = process.env) {
  const env = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1' };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  return env;
}

/**
 * Run git with these arguments; its result as spawnSync gives it. The one place this script starts git.
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number }} [options]
 */
function runGit(args, options = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options }); // NOSONAR(javascript:S4036): the maintainer's or CI runner's own git, found on PATH like the release scripts
}

/** Byte-order comparison, so the order doesn't depend on the locale. */
const byCode = (a, b) => (a < b ? -1 : Number(a > b));

/** The tracked files under `dir`, sorted, as /-separated paths from the repository root. */
function tracked(dir, root = ROOT) {
  const listed = runGit(['ls-files', '-z', '--', dir], { cwd: root });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\0').filter(Boolean).sort(byCode);
}

/** The tracked corpus files, sorted, as /-separated paths from the repository root. */
export function corpusFiles(root = ROOT) {
  return CORPORA.flatMap((corpus) => tracked(corpus.dir, root)
    .filter((f) => corpus.extensions.some((e) => f.endsWith(e)) && !f.slice(corpus.dir.length).includes('/parts/')));
}

const focusedDir = () => CORPORA.find((c) => c.name === 'focused').dir;

/**
 * Every file the runs read: the corpus files, the files they include, the focused requests and the conformance
 * cases. The digest covers them all.
 */
export function inputFiles(root = ROOT) {
  const files = new Set(corpusFiles(root));
  for (const file of [...tracked(focusedDir(), root), ...tracked(CONFORMANCE, root)]) files.add(file);
  return [...files].sort(byCode);
}

/**
 * How many files each corpus has, how many requests each source adds, and a digest of the paths and bytes of every
 * file the runs read.
 * @returns {{ compat: number, research: number, focused: number, requests: { focused: number, conformance: number }, digest: string }}
 */
export function corpusSummary(files, root = ROOT) {
  const hash = createHash('sha256');
  /** @type {Record<string, number>} */
  const counts = {};
  for (const corpus of CORPORA) counts[corpus.name] = files.filter((f) => f.startsWith(`${corpus.dir}/`)).length;
  const requests = { focused: 0, conformance: 0 };
  for (const c of requestCases(root)) requests[c.source]++;
  for (const file of inputFiles(root)) hash.update(file).update('\0').update(fs.readFileSync(join(root, file))).update('\0');
  return /** @type {{ compat: number, research: number, focused: number, requests: { focused: number, conformance: number }, digest: string }} */ (
    { ...counts, requests, digest: hash.digest('hex').slice(0, 24) });
}

/**
 * Every case: one file through one command.
 * @param {string[]} files
 * @returns {Array<{ key: string, file: string, command: string, argv: string[] }>}
 */
export function cases(files) {
  return files.flatMap((file) => Object.entries(COMMANDS).map(([command, argv]) => ({
    key: `${file} · ${command}`, file, command, argv: argv.map((a) => (a === '{file}' ? file : a)),
  })));
}

/** `{file}` and `{today}` in a request's argv. */
function fill(argv, file) {
  return argv.map((a) => {
    if (a === '{file}') return file;
    return a === '{today}' ? TODAY : a;
  });
}

/**
 * The argv of a read-contract request, as the oracle's CLI driver builds it (test/conformance/oracle.ts runCli),
 * without the manifest: the snapshot records the view the agent reads.
 */
export function conformanceArgv(file, route) {
  const argv = route.query === undefined
    ? ['agent', file, ...(route.sections ?? []).flatMap((s) => ['--section', s])]
    : ['query', route.query, file, '--contract'];
  if (route.brief) argv.push('--brief');
  if (route.maxTokens !== undefined) argv.push('--max-tokens', String(route.maxTokens));
  if (route.includedInstructions) argv.push('--included-instructions', route.includedInstructions);
  argv.push('--today', TODAY);
  return argv;
}

/**
 * Every request case: the focused fixtures' requests, then each request of each read-contract case, in folder order.
 * @returns {Array<{ key: string, file: string, command: string, argv: string[], source: 'focused' | 'conformance' }>}
 */
export function requestCases(root = ROOT) {
  /** @type {Array<{ key: string, file: string, command: string, argv: string[], source: 'focused' | 'conformance' }>} */
  const list = [];
  const listed = JSON.parse(fs.readFileSync(join(root, FOCUSED_REQUESTS), 'utf8'));
  for (const r of listed.requests) {
    const file = `${focusedDir()}/${r.file}`;
    list.push({ key: `${file} · request: ${r.name}`, file, command: 'request', argv: fill(r.argv, file), source: 'focused' });
  }
  for (const caseFile of tracked(CONFORMANCE, root).filter((f) => f.endsWith('/case.json'))) {
    const dir = caseFile.slice(0, -'/case.json'.length);
    for (const r of JSON.parse(fs.readFileSync(join(root, caseFile), 'utf8')).requests) {
      const file = `${dir}/${r.doc ?? 'doc.smd'}`;
      list.push({ key: `${file} · conformance: ${r.name}`, file, command: 'conformance', argv: conformanceArgv(file, r.route ?? {}), source: 'conformance' });
    }
  }
  const seen = new Set();
  for (const c of list) {
    if (seen.has(c.key)) throw new Error(`two requests have the key "${c.key}": give them different names`);
    seen.add(c.key);
  }
  return list;
}

/** Every case: each corpus file through each command, then the requests. */
export const allCases = (files, root = ROOT) => [...cases(files), ...requestCases(root)];

/**
 * The output as the snapshot sees it: the repository root (as a path, with either separator, or a file: URL) is
 * `<root>`, and the file's own path written with backslashes is written with slashes, so Windows and Linux agree.
 */
export function normalize(text, file, root = ROOT) {
  let out = text;
  const forms = new Set([root, root.split(sep).join('/'), root.split('/').join('\\'), pathToFileURL(root).href]);
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join('<root>');
  const back = file.split('/').join('\\');
  if (back !== file) out = out.split(back).join(file);
  return out;
}

/** A stream's digest as the snapshot stores it: 24 hex characters of its SHA-256, a colon and its length in bytes. */
export function streamDigest(text) {
  const bytes = Buffer.from(text, 'utf8');
  return `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}:${bytes.length}`;
}

/** Run one case with `cli`; its status and both streams, normalized. */
export function runCase(cli, c, root = ROOT) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...c.argv], { cwd: root, env: runEnv(), windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (status, signal) => done({
      status: signal ? `signal ${signal}` : status,
      stdout: normalize(Buffer.concat(out).toString('utf8'), c.file, root),
      stderr: normalize(Buffer.concat(err).toString('utf8'), c.file, root),
    }));
  });
}

/** Run every case, a few at a time; the outputs by key. */
export async function runCases(cli, list, root = ROOT, concurrency = Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length))) {
  const results = new Map();
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const c = list[next++];
      results.set(c.key, await runCase(cli, c, root));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** A run as the snapshot stores it. */
export const recorded = (run) => ({ status: run.status, stdout: streamDigest(run.stdout), stderr: streamDigest(run.stderr) });

/** The keys whose recording differs, and the keys only one side has. */
export function compare(expected, actual) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [key, value] of Object.entries(actual)) {
    if (!(key in expected)) added.push(key);
    else if (JSON.stringify(expected[key]) !== JSON.stringify(value)) changed.push(key);
  }
  for (const key of Object.keys(expected)) if (!(key in actual)) removed.push(key);
  return { changed, added, removed };
}

/** Which streams of a case differ: `status`, `stdout`, `stderr`. */
export const differingParts = (a, b) => ['status', 'stdout', 'stderr'].filter((part) => a?.[part] !== b?.[part]);

/** The newest modification time under these paths, in ms. */
function newest(paths) {
  let max = 0;
  const visit = (p) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(p)) visit(join(p, entry));
    else max = Math.max(max, stat.mtimeMs);
  };
  for (const p of paths) if (fs.existsSync(p)) visit(p);
  return max;
}

/** Why the built CLI can't be used, or undefined: it must exist and be newer than its sources. */
export function staleCli(extension = EXTENSION) {
  const cli = join(extension, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) return `${relative(process.cwd(), cli)} is missing: run npm run build first.`;
  const sources = newest(['src', 'media', 'package.json', 'package-lock.json'].map((p) => join(extension, p)));
  if (fs.statSync(cli).mtimeMs < sources) return `${relative(process.cwd(), cli)} is older than its sources: run npm run build first.`;
  return undefined;
}

const git = (args, cwd = ROOT) => runGit(args, { cwd }).stdout.trim();

function cliVersion(cli) {
  const run = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env: runEnv() });
  return run.stdout.trim();
}

/** The snapshot file's content for these runs. */
export function snapshotDocument(runs, { files, cli, root = ROOT }) {
  const caseRecords = {};
  for (const key of [...runs.keys()].sort(byCode)) caseRecords[key] = recorded(runs.get(key));
  return {
    format: FORMAT,
    generator: 'extension/scripts/snapshots.mjs',
    source: { commit: git(['rev-parse', 'HEAD'], root), dirty: git(['status', '--porcelain', '--', 'extension/src', 'extension/media'], root) !== '', cli: cliVersion(cli) },
    options: { today: TODAY, locale: 'C.UTF-8', timeZone: 'UTC', cwd: '<root>', paths: 'relative to the repository root, /-separated', env: 'no SMD_* variables' },
    corpus: corpusSummary(files, root),
    commands: COMMANDS,
    requests: { focused: FOCUSED_REQUESTS, conformance: `${CONFORMANCE}/*/case.json` },
    cases: caseRecords,
  };
}

/** Build `ref` in a temporary worktree and return its CLI and a function that removes the worktree. */
function buildBase(ref) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-snapshot-base-'));
  const tree = join(dir, 'tree');
  const add = runGit(['worktree', 'add', '--detach', tree, ref]);
  if (add.status !== 0) throw new Error(`git worktree add ${ref} failed: ${add.stderr}`);
  const modules = join(tree, 'extension', 'node_modules');
  fs.symlinkSync(join(EXTENSION, 'node_modules'), modules, 'junction');
  const cleanup = () => {
    // Remove the link itself, never what it points at.
    try { if (process.platform === 'win32') fs.rmdirSync(modules); else fs.unlinkSync(modules); } catch { /* already gone */ }
    runGit(['worktree', 'remove', '--force', tree]);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: join(tree, 'extension'), encoding: 'utf8' });
  if (build.status !== 0) {
    cleanup();
    throw new Error(`building ${ref} failed: ${build.stderr || build.stdout}`);
  }
  return { cli: join(tree, 'extension', 'dist', 'cli.js'), cleanup };
}

/** A unified diff of two texts, from git. */
function unifiedDiff(before, after, label) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'smd-snapshot-diff-'));
  try {
    fs.writeFileSync(join(dir, 'before'), before);
    fs.writeFileSync(join(dir, 'after'), after);
    const diff = runGit(['diff', '--no-index', '--no-color', '--text', '-U2', 'before', 'after'], { cwd: dir, maxBuffer: 256 * 1024 * 1024 });
    return diff.stdout.replace(/^diff --git .*\n(index .*\n)?--- a\/before\n\+\+\+ b\/after\n/, `--- ${label} (base)\n+++ ${label} (this build)\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args) {
  const update = args.includes('--update');
  const showDiff = args.includes('--diff');
  const only = option(args, '--only');
  const stale = staleCli();
  if (stale) {
    console.error(`[snapshots] ${stale}`);
    return 2;
  }
  const cli = join(EXTENSION, 'dist', 'cli.js');
  const files = corpusFiles();
  const all = allCases(files);
  const selected = only && !update ? all.filter((c) => c.key.includes(only)) : all;
  const started = Date.now();
  const runs = await runCases(cli, selected);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (update) {
    fs.mkdirSync(dirname(SNAPSHOTS), { recursive: true });
    fs.writeFileSync(SNAPSHOTS, JSON.stringify(snapshotDocument(runs, { files, cli }), null, 1) + '\n');
    console.log(`[snapshots] wrote ${runs.size} cases over ${files.length} files and their requests to ${relative(process.cwd(), SNAPSHOTS)} (${seconds} s).`);
    return 0;
  }

  if (!fs.existsSync(SNAPSHOTS)) {
    console.error('[snapshots] test/snapshots/corpus.json is missing: run node scripts/snapshots.mjs --update.');
    return 2;
  }
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOTS, 'utf8'));
  if (snapshot.format !== FORMAT) {
    console.error(`[snapshots] corpus.json has format ${snapshot.format}, this script writes ${FORMAT}: run --update.`);
    return 2;
  }
  const expected = only ? Object.fromEntries(Object.entries(snapshot.cases).filter(([key]) => key.includes(only))) : snapshot.cases;
  const actual = Object.fromEntries([...runs].map(([key, run]) => [key, recorded(run)]));
  const { changed, added, removed } = compare(expected, actual);
  const corpus = corpusSummary(files);
  if (corpus.digest !== snapshot.corpus.digest) console.error(`[snapshots] the corpus changed since the snapshots were written (${snapshot.corpus.digest} → ${corpus.digest}).`);
  if (!changed.length && !added.length && !removed.length) {
    console.log(`[snapshots] ${runs.size} cases over ${files.length} files and their requests match (${seconds} s; written from ${snapshot.source.commit.slice(0, 12)}${snapshot.source.dirty ? ' with uncommitted changes' : ''}).`);
    return 0;
  }
  for (const key of changed) console.error(`changed  ${key}  (${differingParts(expected[key], actual[key]).join(', ')})`);
  for (const key of added) console.error(`new      ${key}`);
  for (const key of removed) console.error(`gone     ${key}`);
  console.error(`\n[snapshots] ${changed.length} changed, ${added.length} new, ${removed.length} gone, of ${runs.size} cases.`);

  if (showDiff && (changed.length || added.length)) {
    const ref = option(args, '--base') ?? 'origin/main';
    console.error(`[snapshots] building ${ref} to show the differences…`);
    const base = buildBase(ref);
    try {
      const keys = new Set([...changed, ...added]);
      const before = await runCases(base.cli, selected.filter((c) => keys.has(c.key)));
      for (const key of keys) {
        const a = before.get(key);
        const b = runs.get(key);
        if (a.status !== b.status) console.log(`=== ${key}: exit status ${a.status} → ${b.status}`);
        for (const stream of ['stdout', 'stderr']) {
          if (a[stream] !== b[stream]) console.log(unifiedDiff(a[stream], b[stream], `${key} ${stream}`));
        }
        if (a.status === b.status && a.stdout === b.stdout && a.stderr === b.stderr) {
          console.log(`=== ${key}: same output as ${ref}; the snapshots are older than ${ref}`);
        }
      }
    } finally {
      base.cleanup();
    }
  } else {
    console.error('[snapshots] --diff shows each difference against origin/main. If they are all intended, run --update and commit test/snapshots/corpus.json (test/snapshots/README.md).');
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[snapshots] ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 2;
  });
}
