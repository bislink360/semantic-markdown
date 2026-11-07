# Semantic Markdown on GitHub and in CI

Check `.smd` files on every pull request and before every commit, and make them readable for people who browse the repository on github.com.

## Contents

- [Validate in CI](#validate-in-ci)
- [Pre-commit hooks](#pre-commit-hooks)
- [Reading `.smd` files on GitHub](#reading-smd-files-on-github)
  - [Which path to choose](#which-path-to-choose)
  - [A. Semantic Markdown syntax in `.md` files](#a-semantic-markdown-syntax-in-md-files)
  - [B. Generate `.md` copies in CI](#b-generate-md-copies-in-ci)
  - [C. Post the changes on pull requests](#c-post-the-changes-on-pull-requests)
  - [`.gitattributes`: what it does and doesn't do](#gitattributes-what-it-does-and-doesnt-do)

## Validate in CI

### GitHub Actions

The `validate` action in this repository checks your `.smd` files, shows each problem as an inline annotation on the pull request's changed lines and writes a job summary (counts and the first 50 problems, linked to the file and line):

```yaml
# .github/workflows/docs.yml
name: docs
on: [pull_request]
jobs:
  smd:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bislink360/semantic-markdown/validate@v3.0.0
        with:
          paths: |
            docs
            specs/product plan.smd
          fail-on: warning
```

It runs the `smd` CLI bundled in the repository with the runner's Node.js (22 or later since 2.0; add `actions/setup-node` with `node-version: 22` before it when the runner's is older). Nothing is installed or downloaded.

| Input | Default | Meaning |
|---|---|---|
| `paths` | `.` | Files or folders to check, one per line (spaces are fine), relative to the repository root |
| `fail-on` | `error` | Fail the step on `error`s, on `warning`s too (like `--strict`), or `never` (report only) |
| `strict` | `false` | `true` is the same as `fail-on: warning` |
| `config` | | A rule config file for every document (default: the nearest `smd.config.json` / `.smdrc`) |
| `mermaid` | `true` | `false` skips Mermaid syntax checks |
| `stale-after` | | Days before a document's `updated` date counts as stale (`0`: off; default 180) |
| `summary` | `true` | Write the job summary |
| `cli` | | Run another `smd` CLI, e.g. `node_modules/semantic-markdown/dist/cli.js` |

Errors become `::error`, warnings `::warning` and info diagnostics `::notice` annotations; hints are left out. The bundled CLI has no Mermaid parser, so diagram syntax is only checked when `cli` points at the npm package's CLI (installed with `npm ci` in an earlier step).

### Any CI

```bash
curl -sSLo smd.cjs https://raw.githubusercontent.com/bislink360/semantic-markdown/v3.0.0/skills/semantic-markdown-reader/scripts/smd.cjs
node smd.cjs validate docs/ --strict
```

`validate` exits with code **1** on errors (and on warnings with `--strict`). Use `--json` for machine-readable output, or `--format github` for GitHub workflow commands; `--summary <file>` also appends a Markdown summary to a file (e.g. `"$GITHUB_STEP_SUMMARY"`).

Once your documents are on spec v2, `node smd.cjs migrate docs/ --to 2 --check` keeps them there: it writes nothing, lists each document that still needs migrating (a new one written with `smd: 1`, say) and then exits with code **1**.

## Pre-commit hooks

Check `.smd` files before they are committed. `smd validate` and `smd fmt` take any number of files, so a hook passes them only the staged ones. Pick the setup your project already uses.

### With the pre-commit framework

[pre-commit](https://pre-commit.com) works in any repository, whatever its language. Add to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/bislink360/semantic-markdown
    rev: v2.4.0
    hooks:
      - id: smd-fmt
      - id: smd-validate
        args: [--strict]   # optional: fail on warnings too
```

Then run `pre-commit install` once. The hooks (from v1.5.0):

| Hook id | Runs | Fails the commit when |
|---|---|---|
| `smd-validate` | `smd validate <staged .smd files>` | a file has errors (or warnings, with `args: [--strict]`) |
| `smd-fmt` | `smd fmt <staged .smd files>` | it reformatted a file. pre-commit lists the changed files: review them, `git add` and commit again |
| `smd-fmt-check` | `smd fmt --check <staged .smd files>` | a file is not formatted (nothing is changed; for CI or if you'd rather format yourself) |

Other `args` are passed to the command, e.g. `[--config, docs/smd.config.json]` or `[--stale-after, '0']` for `smd-validate`.

The hooks use `language: node`: pre-commit installs this repository's root `package.json`, whose only file is the bundled single-file CLI (`skills/semantic-markdown-reader/scripts/smd.cjs`), so there are no dependencies and nothing comes from the npm registry. On macOS and Linux pre-commit uses the `node` (22 or newer) and `npm` on your PATH; without them, and always on Windows, it downloads a private Node.js once. The single-file CLI doesn't include the Mermaid parser, so the hooks don't report `mermaid/syntax`; run `smd validate` from the npm package in CI for that.

### With lint-staged and husky

For JavaScript projects. The `semantic-markdown` package isn't on the npm registry yet, so install it from the release's `.tgz`, which also gives you the Mermaid parser:

```bash
npm install --save-dev https://github.com/bislink360/semantic-markdown/releases/download/v3.0.0/semantic-markdown-3.0.0.tgz
npm install --save-dev lint-staged husky
npx husky init
echo "npx lint-staged" > .husky/pre-commit
```

and in `package.json`:

```json
{
  "lint-staged": {
    "*.smd": ["smd fmt", "smd validate"]
  }
}
```

lint-staged appends the staged files to each command, runs them in order and stages the formatting changes. Add `--strict` to `smd validate` to fail on warnings. To use the single-file CLI instead of the package, download it into the repository (`curl -sSLo tools/smd.cjs https://raw.githubusercontent.com/bislink360/semantic-markdown/v3.0.0/skills/semantic-markdown-reader/scripts/smd.cjs`) and use `"node tools/smd.cjs fmt"` and `"node tools/smd.cjs validate"`.

### With a plain Git hook

Without either tool, save this as `.git/hooks/pre-commit` and make it executable (`chmod +x .git/hooks/pre-commit`). It needs `smd` on your PATH; otherwise replace `smd` with `node path/to/smd.cjs`. Git for Windows runs it too.

```sh
#!/bin/sh
# Check the staged .smd files: formatting first, then validation.
staged() { git diff --cached --name-only -z --diff-filter=ACMR -- '*.smd'; }
git diff --cached --quiet --diff-filter=ACMR -- '*.smd' && exit 0   # no .smd files staged
staged | xargs -0 smd fmt --check -- || { echo "Run: smd fmt <files>, then git add them."; exit 1; }
staged | xargs -0 smd validate --
```

It checks the files as they are in the working tree and doesn't change them; `--` keeps a file name that starts with `-` from being read as an option. The hook lives only in your clone: to share it, commit it (e.g. as `.githooks/pre-commit`) and run `git config core.hooksPath .githooks`.

## Reading `.smd` files on GitHub

GitHub renders `.md` files as pages, but shows a `.smd` file as its source text. People who browse your repository on github.com see `:::warning` fences and `{color=red}` attributes instead of a callout. This guide covers the ways around that, from the simplest to the most complete, and says what each one costs.

## Which path to choose

| Path | GitHub shows | You keep | Cost |
|---|---|---|---|
| **A.** `.smd` syntax in `.md` files | GitHub's own rendering: alerts, tables, task lists, Mermaid and math render; `:::` fences and `:directives[…]` show as plain text | One file per document. The CLI, VS Code, MkDocs and the static-site plugins read it as Semantic Markdown | Write the parts GitHub must show well in its subset. Folder scans and the MCP server look only at `.smd` files |
| **B.** `.md` copies made in CI | A rendered page for every `.smd` file: callouts become alerts, decisions and agent blocks become notes, tasks keep owners and dates | The full syntax in `.smd`; GitHub readers open the `.md` copy | A second file per document, written by a bot commit or checked on pull requests |
| **C.** A pull request comment | What changed, as an agent reads it, on each pull request | Everything as it is | Review aid only: browsing the repository still shows source |

Start with **A** if most of your documents are READMEs and guides that people read on GitHub. Use **B** when you want the full syntax (decisions, risks, tasks, layout) and still want readable pages on GitHub. Add **C** to either for reviews.

## A. Semantic Markdown syntax in `.md` files

Every `.md` file is already a valid Semantic Markdown document. Add `smd: 2` to its front matter and the tools read it with the spec v2 rules:

```markdown
---
smd: 2
title: Payments runbook
---

> [!WARNING]
> Rotate the keys before you deploy.

- [ ] Move the cron job to the new cluster :priority[P1] @ops :due[2026-12-01]
```

### What GitHub shows

GitHub renders the parts of Semantic Markdown that are also GitHub Markdown, and shows the rest as text:

| Syntax | On GitHub | Use in a `.md` file read on GitHub |
|---|---|---|
| GitHub alerts (`> [!NOTE]`, `> [!WARNING]`…) | Rendered alerts | **Yes.** Semantic Markdown reads them as callouts (`<warning>` in the agent view) |
| Tables, task lists, footnotes, `<details>` | Rendered | **Yes** |
| ```` ```mermaid ```` diagrams, `$math$` and `$$` math | Rendered | **Yes** |
| Front matter | A table at the top of the page | Yes |
| `:::warning`, `:::decision`, `:::risk`, `:::agent` and other containers | The fence lines show as text; the content renders as normal Markdown | Readable, but not styled. Prefer alerts for callouts |
| `:priority[P1]`, `:due[…]`, `:badge[…]` and other inline directives | Shown as written | Readable: `:priority[P1]` still says P1 |
| `[text]{color=red}`, `## Heading {agent=skip}` | The attribute list shows as text | Avoid in documents read on GitHub |

### What the tools do with `.md` files

| Tool | `.md` files |
|---|---|
| `smd validate`, `fmt`, `agent`, `outline`, `tasks`, `query`, `index`, `diff`, `meta`, `export` | Read a `.md` file you **name**, as Semantic Markdown: `smd agent docs/runbook.md`, `smd validate README.md docs/*.md` |
| The same commands given a **folder** | Look only at `.smd` files in it (`smd validate docs/` with only `.md` files says "No .smd files found" and exits 2). Name the files, or let your shell expand `docs/*.md` |
| `smd build docs --md` | Publishes `.md` files as pages too |
| GitHub Action (`validate/`) | Checks `.md` files listed in `paths` one by one; folders give their `.smd` files only |
| MCP server (`smd mcp`) | Reads `.smd` files only |
| VS Code | The built-in Markdown preview renders the syntax in `.md` files that have an `smd:` key (the `smd.markdownPreview.enabled` setting). Validation, completion and the Semantic Markdown preview are for `.smd` files |
| MkDocs plugin, remark and rehype plugins, markdown-it plugin, Obsidian | Render it in `.md` files (MkDocs: `md_syntax: true`) |

A `.md` file without an `smd:` key is read with the spec v1 rules, as every `.md` file was in 1.x. That is fine for most text; `smd: 2` keeps quotes and dashes as typed and links only full URLs, as GitHub does.

## B. Generate `.md` copies in CI

`smd export <file.smd> --to md` writes plain GitHub Markdown: callouts become alerts, a decision becomes a note titled "Decision (accepted · @maya): …", tasks keep their priority, owner and date, `:::agent` blocks become a "For agents" note, code embeds are inlined, and layout containers are flattened. Nothing is lost; styling that GitHub can't show is dropped.

The workflow below writes `docs/plan.md` next to every `docs/plan.smd`. On a push to `main` it commits the copies; on a pull request it fails when a copy is out of date and says which command to run. Links between documents (`[setup](../setup.smd#install)`) are rewritten to the copies (`setup.md#install`); links with a scheme (`https://…`) are left alone.

```yaml
# .github/workflows/markdown-copies.yml
name: Markdown copies
on:
  push:
    branches: [main]
    paths: ['**.smd']
  pull_request:
    paths: ['**.smd']
  workflow_dispatch:

permissions:
  contents: write   # to commit the copies on main; pull requests only read

env:
  DOCS: docs                # the folder with your .smd files
  SMD_VERSION: v2.5.0       # the Semantic Markdown release whose CLI to use

jobs:
  copies:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Download the smd CLI (one file, no dependencies)
        run: curl -sSfLo "$RUNNER_TEMP/smd.cjs" "https://raw.githubusercontent.com/bislink360/semantic-markdown/$SMD_VERSION/skills/semantic-markdown-reader/scripts/smd.cjs"
      - name: Write a .md copy next to every .smd file
        run: |
          set -euo pipefail
          git ls-files -z -- "$DOCS/*.smd" | while IFS= read -r -d '' file; do
            copy="${file%.smd}.md"
            node "$RUNNER_TEMP/smd.cjs" export "$file" --to md -o "$copy"
            # Links to other .smd documents point at their copies.
            sed -i -E 's/\]\(([^):#]*)\.smd([)#])/](\1.md\2/g' "$copy"
          done
      - name: Commit the copies
        if: github.event_name != 'pull_request'
        run: |
          git add -A -- "$DOCS"
          if git diff --cached --quiet; then echo "The copies are up to date."; exit 0; fi
          git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
            commit -m "docs: update the Markdown copies of .smd files"
          git push
      - name: Check the copies are up to date
        if: github.event_name == 'pull_request'
        run: |
          if [ -n "$(git status --porcelain -- "$DOCS")" ]; then
            git status --short -- "$DOCS"
            echo "::error::The .md copies are out of date. Run: smd export <file.smd> --to md -o <file.md> for each changed file, or let the push to main update them."
            exit 1
          fi
```

Notes:

- **Protected `main`:** if pushes to `main` need a pull request, drop the commit step and keep the check: contributors update the copies before merging (a [pre-commit hook](github-and-ci.md#pre-commit-hooks) can run the same export).
- **No loop:** a commit pushed with the workflow's own `GITHUB_TOKEN` doesn't start another workflow run.
- **Deleted documents:** the workflow doesn't delete the copy of a `.smd` file you removed; delete it in the same commit.
- **Mark the copies as generated** so GitHub collapses them in diffs and leaves them out of language statistics. In `.gitattributes`, with your folder: `docs/**/*.md linguist-generated`. Add a line to the folder's README saying the `.smd` files are the source, so nobody edits a copy.
- **Agents:** tell them to read the `.smd` files (the [skills and rules](agent-setup.md) already do), not the copies.

## C. Post the changes on pull requests

`smd diff <files> --since <git-ref>` prints only the sections that changed, in the agent view: compact, without styling, with line numbers. Posted as a pull request comment, it lets reviewers (and review agents) read what a document change means without opening the source.

```yaml
# .github/workflows/smd-pr-comment.yml
name: Document changes
on:
  pull_request:
    paths: ['**.smd']

permissions:
  contents: read
  pull-requests: write   # to comment

env:
  SMD_VERSION: v2.5.0

jobs:
  comment:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # smd diff --since needs the base branch's history
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Download the smd CLI
        run: curl -sSfLo "$RUNNER_TEMP/smd.cjs" "https://raw.githubusercontent.com/bislink360/semantic-markdown/$SMD_VERSION/skills/semantic-markdown-reader/scripts/smd.cjs"
      - name: Changed sections, in the agent view
        env:
          BASE: origin/${{ github.base_ref }}
        run: |
          set -euo pipefail
          mapfile -t files < <(git diff --name-only --diff-filter=AM "$BASE"...HEAD -- '*.smd')
          if [ "${#files[@]}" -eq 0 ]; then
            echo "No .smd file was added or changed (only removed)." > diff.txt
          else
            node "$RUNNER_TEMP/smd.cjs" diff "${files[@]}" --since "$BASE" --brief > diff.txt
          fi
          {
            echo "### Document changes"
            echo
            echo "What changed in each \`.smd\` file, as an agent reads it (\`smd diff --since ${{ github.base_ref }}\`)."
            echo
            echo '```text'
            head -c 60000 diff.txt   # a comment holds at most 65,536 characters
            echo '```'
          } > comment.md
          cat comment.md >> "$GITHUB_STEP_SUMMARY"
      - name: Comment on the pull request
        # A pull request from a fork gets a read-only token: it has the job summary instead.
        if: github.event.pull_request.head.repo.full_name == github.repository
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh pr comment "${{ github.event.pull_request.number }}" --body-file comment.md --edit-last --create-if-none
```

- `--edit-last --create-if-none` keeps one comment per pull request and updates it on every push (GitHub CLI 2.58 or later, which hosted runners have).
- Without a base to compare with, use the whole agent view instead: `node smd.cjs agent <file> --brief` for each file.
- For a rendered page instead of the agent view, `smd export <file> --to html -o page.html` and upload it with `actions/upload-artifact`: reviewers download it from the run page. The [`validate` action](github-and-ci.md#github-actions) adds the problems as annotations on the changed lines.

## `.gitattributes`: what it does and doesn't do

```gitattributes
*.smd linguist-language=Markdown
```

This line tells [Linguist](https://github.com/github-linguist/linguist), GitHub's language detector, to treat `.smd` files as Markdown. It changes two things: the repository's language statistics count `.smd` files as Markdown, and GitHub's source view and diffs highlight them as Markdown (headings, emphasis, code fences) instead of plain text.

It does **not** make GitHub render a `.smd` file as a page: GitHub picks the files it renders by their extension, so the file view still shows source (now highlighted). For pages on GitHub, use path A or B.
