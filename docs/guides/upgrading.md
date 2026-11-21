# Upgrading Semantic Markdown

What changes when you move across a major release, and what to do about it. What each kind of release may change is in the [compatibility policy](../reference/compatibility.md), and every change, with its migration, is in the [CHANGELOG](../../extension/CHANGELOG.md).

## Contents

- [Upgrading to 6.0](#upgrading-to-60)
- [Upgrading to 5.0](#upgrading-to-50)
- [Moving from Styled Markdown](#moving-from-styled-markdown) (3.0)
- [Upgrading to 2.0](#upgrading-to-20)

## Upgrading to 6.0

6.0 finishes the rule that 5.0 started: content you mark for people never reaches an agent, and nothing an agent asks for brings it back. It has three breaking changes, all in what agents receive. Your documents keep their meaning for people, `smd: 2` is still the current spec version, the supported Node.js and VS Code versions are the same, and there is nothing to run through `smd migrate`.

- **No agent-facing list shows content for people.** A section marked `{agent=skip}`, its subsections and every `:::human` block now stay out of every list an agent reads, not only the agent views:
  - `smd tasks`, `smd risks`, `smd trace`, `smd decisions`, `smd meta` and the MCP `tasks` tool leave out the tasks, risks, requirements and decisions inside them, and `smd meta` gives no diagnostic that points into them;
  - `smd outline` (and the outline that `smd read` and the MCP `read` tool return) and `smd index` don't list a skipped section, and their counts leave out what it holds. A catalog entry's section no longer has `"agent": "skip"`, because such a section isn't listed;
  - `smd diff` doesn't report a change inside a skipped section, and `smd updates` doesn't report a task, question or comment that changed in content for people;
  - `--follow` on `smd read`, `smd agent` and `smd query` lists no pointer into it. A dependency on a hidden block is reported by its id, without the block's title or section, and in `--json` a `hidden` dependency's edge has no `to`;
  - a section read that names only skipped sections says `(excerpt — no section shown)` instead of their headings.

  Line numbers in every list still point at the source file. The preview, exports, `smd build`, `smd issues`, `smd report`, the editor's Tasks view and `smd validate` are unchanged, so people and authors still see and check that content. If a task, risk, requirement or decision must reach agents, move it out of the skipped section or `:::human` block (`audience/rule-in-skip` points at rules there). A script that read `"agent": "skip"` from `smd index` to skip those sections can drop that check.
- **A rule on a hidden block is not carried.** Before, a visible constraint or accepted decision whose `applies-to` named a block in a skipped section or a `:::human` block was carried into the reads that needed that block, marked `hidden-target`. You hid the block on purpose, so a read no longer brings back what binds it. The `hidden-target` label is gone, and manifests and the library's `AppliedConstraint` type no longer have `hiddenTargets`. A requirement that depends on a hidden block still lists it as `hidden` under *Not satisfied*, and the read is still reported as incomplete. Keep a block visible when agents must follow the rules that target it, or point the rule at visible content.
- **No command shows a `:::human` block to an agent.** `smd agent --include-human` (and the same option with `--view`) and the MCP `agent` tool's `includeHuman` are accepted and ignored. The CLI prints a deprecation warning on stderr, and a later major release removes them. A manifest no longer offers a command to recover a `:::human` block: its omission says no command shows it (`noRetrieve`). Drop `--include-human` from scripts, and put content an agent must read outside `:::human`. The npm library keeps its `includeHuman` option for renderers for people, such as a site search index.

One new hint can show up in `smd validate` and the editor: `alert/caution` (an info) on every `> [!CAUTION]` alert. The alert still means a danger, as before, so nothing changes for agents. The hint asks you to write the kind out, `:::danger` for a hard constraint or `:::warning` for a caveat, and VS Code offers both as quick fixes. To keep GitHub's spelling, turn it off with `{"rules": {"alert/caution": "off"}}` in `smd.config.json`.

## Upgrading to 5.0

5.0 has four breaking changes. Your documents keep their meaning, `smd: 2` is still the current spec version, the supported Node.js and VS Code versions are the same, and there is nothing to run through `smd migrate`.

- **Exported pages block the document's scripts.** Export to HTML, `smd export --to html`, `smd render` and `smd build` write pages under a content security policy. The document's scripts, event attributes and `javascript:` links do nothing, and its `iframe`, `object`, `embed`, `meta` and `base` elements are inert. Styles, images, ordinary raw HTML, diagrams and math look as before. For a document whose embeds or scripts you trust, such as a video `iframe`, turn the policy off:
  - on the command line, with `--no-content-policy` on `smd export --to html`, `smd render` or `smd build`;
  - in VS Code, by setting `smd.export.contentPolicy` to `false`;
  - in the npm package, with `contentPolicy: false` in `renderPage`, `renderStandaloneHtml` or `buildSite`.

  PDF export always prints under the policy and has no such option.
- **Links clicked in the preview and the Block Editor follow one rule.** `http`, `https` and `mailto` links open outside VS Code. A relative or `file:` link opens only when the file, with symbolic links resolved, is inside a workspace folder, or beside a document that is in none. Any other link, such as `command:` or `vscode:`, is not opened, and a message shows it. If a link stopped working, add the folder that holds the file to the workspace, use a web link, or run the command from the Command Palette or a keybinding.
- **`smd validate` exits 2 when a path you name is missing.** It still checks every file it can read. Before, the run exited 0 when the other paths were clean, so a CI step could keep naming a deleted file without anyone noticing. Correct or remove the path. With `--format json` or `--json`, the missing paths are in a new `inputErrors` array.
- **Audience marks take precedence over selection.** A section marked `{agent=skip}`, its subsections and every `:::human` block stay out of every agent view, even when a read names the section. That covers `smd agent --section`, `smd read --section`, `smd query`, `--follow`, task views and the MCP `read` and `query` tools, and it includes any `:::agent`, danger, constraint or requirement block inside them. `smd query` exits 1 when hidden blocks were its only matches, and says on stderr how many it left out. `--include-human` still keeps `:::human` blocks and never lifts `{agent=skip}`. Previews and exports for people are unchanged. Run `smd validate` to find what agents no longer receive (`container/agent-in-skip` and `audience/rule-in-skip`), move those instructions into visible content, and keep the background in the hidden part.

Two smaller changes can show up in scripts. An option a command doesn't read now prints a warning on stderr, and a later major release will make it an error, so correct misspelt options now. A file command given a folder now exits 2 with a one-line message, where it used to crash with exit code 1.

## Moving from Styled Markdown

Styled Markdown became Semantic Markdown in 3.0. The format is the same: `.smd` files, the `smd` command, `smd: 2`, the `smd.*` settings, commands and keybindings, and the diagnostic codes don't change. Only the published names do. The old names get no more updates.

| What | Before 3.0 | From 3.0 | What to do |
|---|---|---|---|
| VS Code extension | `bislink360.styled-markdown` | `bislink360.semantic-markdown` | Install **Semantic Markdown** (`code --install-extension bislink360.semantic-markdown`), then uninstall the old entry. |
| npm package | `styled-markdown` | `semantic-markdown` | `npm install semantic-markdown`, and change imports to `semantic-markdown/…` |
| MkDocs plugin | `mkdocs-styled-markdown` | `mkdocs-semantic-markdown` | `pip install mkdocs-semantic-markdown`. `plugins: [styled-markdown]` in `mkdocs.yml` keeps working. |
| Agent skills | `styled-markdown-reader`, `-writer` | `semantic-markdown-reader`, `-writer` | Re-run `smd skills install`. It removes the old copies it installed. |
| Cursor, Copilot and `AGENTS.md` rules | `styled-markdown.mdc`, `styled-markdown.instructions.md`, `<!-- styled-markdown:start -->` | the same with `semantic-markdown` | Re-run `smd skills install --target …`. It replaces the old files and section. |
| MCP server | `styled-markdown` | `semantic-markdown` | Re-run `smd init --agent …`, and rename `mcp__styled-markdown__…` in permission rules |
| Claude Code plugin | `styled-markdown@styled-markdown` | `semantic-markdown@semantic-markdown` | `/plugin marketplace add bislink360/semantic-markdown`, then `/plugin install semantic-markdown@semantic-markdown` |
| Repository and website | `bislink360/styled-markdown`, `bislink360.github.io/styled-markdown` | `bislink360/semantic-markdown`, `bislink360.github.io/semantic-markdown` | GitHub redirects the repository (clones and `uses:` lines included). The old website address doesn't redirect. |
| JetBrains and Obsidian plugins | — | — | Nothing: they keep their IDs and update in place. |

## Upgrading to 2.0

2.0 brings spec v2. Your documents keep working; this is what changes when you update from 1.x.

- **Platform:** Node.js 22 or newer for the CLI, the npm package, the GitHub Action, the pre-commit hooks and the MkDocs plugin, and VS Code 1.97 or newer (or Cursor, VSCodium, Windsurf based on it) for the extension. Older editors keep the 1.x extension.
- **Your documents keep their meaning.** A document without `smd: 2`, and every `.md` file, is read with the spec v1 rules, as in 1.x.
- **Stricter checks, in every document.** Duplicate attributes (`[x]{color=red color=blue}`), a container titled both by `title=` and by text (`:::note{title="A"} B`), a Mermaid syntax error and an invalid figure `kind` are now errors, so `smd validate` fails on them. Front matter that can't be read is shown in a red "Front matter could not be read" block instead of hiding the text above it. `smd validate --fix` repairs the duplicates, the title conflicts and a misspelt `kind`; fix a Mermaid error, and front matter that can't be read (often a missing closing `---`), by hand.
- **VS Code's `.md` preview is opt-in.** VS Code's built-in Markdown preview shows `.smd` syntax only in `.md` files whose front matter has an `smd:` key (`smd: 1` keeps the v1 rules). Set `smd.markdownPreview.enabled` to `always` for the 1.x behaviour, or `never`. `.smd` files and the Semantic Markdown preview are unaffected.
- **New documents are `smd: 2`:** `smd init`, `smd from-md`, **Convert Markdown File to .smd** and the other writers write it. Spec v2 differs from v1 in:
  - text shown as written: straight quotes, `--`, `...` and `(c)` stay as typed unless the front matter says `typography: true`;
  - links: only GFM autolinks (`https://…`, `www.…`, e-mail addresses); a bare `example.com` is text;
  - `$$` display math opens and closes only on a line of its own (or `$$ x $$` on one line);
  - a closing fence closes the container opened with as many colons (`::::` closes `::::tabs`);
  - a heading's trailing `{}` or `{word}` is heading text (`## Returns {ok}`);
  - `\\` in a quoted attribute value is one backslash;
  - any `:name[…]` is a directive, its name in any case; write `\:name[…]` to keep the text;
  - `:::include` `section=` matches a heading's id or its whole text, not a part of it;
  - front matter values keep their YAML spelling (`version: 2.10` shows `2.10`).

  The rules, side by side with v1: [reference/spec.md §10](../reference/spec.md#10-versioning).
- **Moving a document to spec v2:** `smd migrate docs --to 2 --dry-run` shows the plan, then `smd migrate docs --to 2` writes it (only `.smd` files, each checked after writing); in VS Code, **Migrate to Spec v2** (or **Preview Migration to Spec v2**). `--keep-typography` keeps curly quotes and dashes, and `--link-domains` keeps bare domains linked. In CI, `smd migrate docs --to 2 --check` fails while a document still needs migrating. The steps: [reference/spec.md §10.1](../reference/spec.md#101-migrating-to-spec-v2).
- **Command names:** `smd export <file> --to html|md|pdf|docx|confluence|notion` replaces `smd render`, `smd to-md`, `smd pdf` and `smd docx`, which still work with the same options and output.
- **npm package:** `inlineText(line, options)` takes its options as one object; the vocabulary tables (`CONTAINERS`, `NAMED_COLORS`, …) are read-only, so copy one to extend it; and the markdown-it plugin's `preset: 'smd'` renders as `renderSmd` does. See [npm/README.md](../../npm/README.md).
