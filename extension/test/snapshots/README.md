# Output snapshots

`corpus.json` records what the built CLI writes for every file of both corpora. CI checks it on Linux and Windows,
so a change to the code that changes any output fails the build until the change is approved here. It is the safety
net of the improvement roadmap (t-01): refactors and performance work must leave every output as it was, and fixes
must change only what they mean to.

## What it covers

- **Corpora.** The 41 tracked `.smd` files in `extension/test/compat/corpus` and the 125 tracked `.md` and `.smd`
  files in `research/data/corpus`, 166 in all.
- **Commands.** Each file goes through four commands, 664 cases:
  - `smd agent <file> --today 2026-01-15`
  - `smd validate <file> --format json --today 2026-01-15`
  - `smd export <file> --to md`
  - `smd export <file> --to html --today 2026-01-15`
- **Records.** For each case, the exit status, stdout and stderr are kept apart. Each stream is stored as the first
  24 hex characters of its SHA-256 and its length in bytes. The file stays small, and `--diff` shows the text.

## Why runs repeat exactly

- The corpus is the tracked files, sorted, so an untracked file never joins it. `corpus.digest` hashes their paths
  and bytes.
- Every run starts in the repository root and names its file by a relative, `/`-separated path.
- Each run gets only `PATH` and the system variables, `LANG` and `LC_ALL` set to `C.UTF-8`, `TZ` set to `UTC` and
  `NO_COLOR` set. No `SMD_*` variable reaches it.
- Dated output uses `--today 2026-01-15`. `smd export` forwards `--today` to the HTML renderer for this, and the
  Markdown export uses no date.
- The repository root in any output becomes `<root>`, and the file's own path written with backslashes is
  written with slashes, so Windows and Linux record the same digests. `.gitattributes` checks every text file out
  with LF endings.
- The check uses `extension/dist/cli.js` and refuses one older than `src/`, `media/`, `package.json` or the
  lockfile. `source` names the commit the snapshots were written from, and whether `src/` or `media/` had
  uncommitted changes.

## Commands

Run these from `extension/`, after `npm run build`.

```bash
node scripts/snapshots.mjs
```

The check. It exits 0 when every case matches and 1 when one differs, and lists each changed, new or gone case
with the streams that differ. It exits 2 when the CLI is missing or stale. `--only <text>` limits it to the cases
whose key contains the text, such as `--only "· html"` or `--only include.smd`.

```bash
node scripts/snapshots.mjs --diff
```

The check, and then a unified diff of every case that changed. It builds `origin/main` in a temporary worktree and
runs the changed cases with both CLIs on the same corpus, so the diff shows only what the code changed.
`--base <ref>` compares with another branch or commit.

```bash
node scripts/snapshots.mjs --update
```

Rewrites `corpus.json` from the built CLI.

## Approving an intended difference

1. Make the change and run `npm run build`.
2. Run `node scripts/snapshots.mjs --diff` and read every diff. A refactor or a performance task should show
   none. A fix should change only the cases it means to change, in the way it means to.
3. If a case changed that should not have, fix the code, not the snapshots.
4. When every difference is intended, run `node scripts/snapshots.mjs --update` and commit `corpus.json` in the
   same pull request as the change.
5. Under a "Snapshot changes" heading in the pull request description, say which cases changed and why, for
   example "html of every file, the stylesheet gained a print rule" or "validate of 3 files, the new rule
   `audience/rule-in-skip`". The reviewer checks the diff against that list.

A change to the corpus itself also changes `corpus.digest`. Review it with `--diff` in the same way, since both
CLIs then run the new corpus.

The M1 fixes of the improvement roadmap (t-05 to t-14 and t-54) merged before this harness existed, so the first
snapshots already include their output. Fixes from now on follow the steps above. Their pull requests list their
intended diffs, as t-01 asks.
