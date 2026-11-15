# Output snapshots

`corpus.json` records what the built CLI writes for every file of both corpora and the focused fixtures. CI checks
it on Linux and Windows, so a change to the code that changes any output fails the build until the change is
approved here. It is the safety net of the improvement roadmap (t-01 and t-02): refactors and performance work must
leave every output as it was, and fixes must change only what they mean to.

## What it covers

- **Corpora.** The 41 tracked `.smd` files in `extension/test/compat/corpus`, the 125 tracked `.md` and `.smd`
  files in `research/data/corpus` and the 8 focused fixtures in `extension/test/snapshots/fixtures`, 174 in all.
  Files under a `parts/` folder are only included by the fixtures, so they are read through them.
- **Commands.** Each file goes through four commands, 696 cases:
  - `smd agent <file> --today 2026-01-15`
  - `smd validate <file> --format json --today 2026-01-15`
  - `smd export <file> --to md`
  - `smd export <file> --to html --today 2026-01-15`
- **Requests.** 96 more cases read the fixtures in other ways, 792 cases in all:
  - The 26 requests in `fixtures/requests.json`: budgets, sections, outlines and a review list.
  - Every request of the read-contract cases in `extension/test/conformance/cases`, 70 in all, run with the
    arguments the conformance oracle gives the CLI. The oracle checks which rules and omissions a view has. The
    snapshot keeps its exact text.
- **Records.** For each case, the exit status, stdout and stderr are kept apart. Each stream is stored as the first
  24 hex characters of its SHA-256 and its length in bytes. The file stays small, and `--diff` shows the text.

## The focused fixtures

They hold the behavior the M2 and M4 refactors could change without meaning to (t-02). Each is small and says in its
summary what it pins.

| Fixture | What it pins |
| ------- | ------------ |
| `nested-includes.smd` | Three levels of includes from three folders, with headings moved down at each level, and links, images, ids and tasks in the included text |
| `include-ids.smd` | Explicit ids and slugs in included text, an included id equal to one of the document's own, and the same file included twice |
| `duplicate-slugs.smd` | Repeated headings, an explicit id equal to a slug, text that slugs to a numbered slug, and slugs from an included file |
| `included-figures.smd` | Figures in included text numbered with the document's own, references from both sides, and the same figure id on both sides |
| `review-includes.smd` | Comments and suggestions on own and included blocks, open, resolved and rejected, and a comment in the included file |
| `spec-v1-includes.smd`, `spec-v2-includes.smd` | Twins that include the same `smd: 1` file, so they differ only where the including document's spec version reads it differently |
| `token-budget.smd` | Budgets set exactly at the size of each view the budget can choose, and one token under it |

`test/focusedFixtures.test.ts` checks what a digest can't say. Each "fits exactly" budget in `requests.json` must be
the size of the view it returns, and every place the view changes must be read on both sides. With a tokenizer whose
count changes when pieces are joined, every budget must get the exact count of its view. So when a change moves a
budget boundary, that test names the new one. Approve the snapshot diff as below, then move the two budgets in
`requests.json` to the new boundary.

Some fixtures pin behavior that looks inconsistent today, such as a review comment on an included block reported as
naming nothing. The snapshots record it as it is. A fix changes those cases and lists them like any other.

## Why runs repeat exactly

- The corpus is the tracked files, sorted, so an untracked file never joins it. `corpus.digest` hashes the paths
  and bytes of every file the runs read, the included parts, `requests.json` and the conformance cases too.
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
