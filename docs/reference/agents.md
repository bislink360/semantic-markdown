# Semantic Markdown — Guide for AI Agents

> Paste this file (or link to it) in your agent's system prompt, `CLAUDE.md`, `AGENTS.md`, Cursor rules or Copilot instructions so agents read and write `.smd` correctly. For Cursor, GitHub Copilot and `AGENTS.md`, `smd skills install --target cursor,copilot,agents` writes a short version of this guide and the CLI (`.smd/smd.cjs`) into your project ([details](../guides/agent-setup.md#github-copilot-cursor-codex-windsurf-and-other-agents)). Agents that support skills can use the [semantic-markdown skills](../guides/agent-setup.md) instead.

## Reading `.smd` files (save tokens)

Don't read `.smd` files whole with cat/Read. Use the CLI (`smd` on PATH, or `node skills/semantic-markdown-reader/scripts/smd.cjs`):

0. **Shortcut:** `smd read <file>` does steps 1–2 in one call. It prints the whole agent view when it fits 2,000 tokens (`--max-tokens <n>` changes the budget), and otherwise the outline, so you can ask for sections next with `smd read <file> --section "<heading>"`.
1. `smd outline <file>` shows the title, status, summary and every section with its line range and token cost.
2. If the full agent view is small (≲ 2,000 tokens), read it once with `smd agent <file>`. Otherwise read only what you need with `smd agent <file> --section "<heading>"` (repeatable). `:::agent` instructions and `:::danger` blocks from other sections are always included (under "Document-wide agent instructions" and "Dangers elsewhere in the document"). `--brief` condenses diagrams, long code, details and completed tasks (`:::agent` and `:::danger` blocks inside details are kept). When you need an overview within a fixed budget, `smd agent <file> --max-tokens 2000` condenses the view and leaves out the least important sections; each one becomes a `[section omitted: …]` line with the `--section` command that reads it.
3. If the front matter lists `related:` documents, `smd outline <file> --related` adds each one's title, status, summary and token cost. Open a related document only when the question needs it.
4. Headings in the agent view carry `[L42]` line refs. Open raw lines only when you edit, and only that range.
5. Across documents: `smd tasks docs/` lists open tasks (priority, owner, due date, overdue first). `smd query "<selector>" docs/` pulls just the blocks you need, e.g. `decision[status=accepted]`, `risk[impact>=high]`, `api[method=POST]` or `question` (`--titles` for a one-line list). `smd decisions docs/ --status accepted` lists the binding decisions across documents, newest first (`--status open` for the ones still to decide). `smd risks docs/` is the risk register: every risk scored impact × likelihood, highest first, with owner, status and a one-line mitigation (`--json` for tools).
6. Many documents and you don't know which one matters: read the catalog (`smd index docs/`, or a committed `catalog.json`). Each entry has the path, title, summary, status, owners, tags, token costs, sections with ids, and counts of open tasks, decisions, risks, questions and APIs. Pick documents by summary, status and tags, then `smd outline` them or read `smd agent <file> --section "<id>"`.
7. With the [MCP server](#mcp-server) registered, the same steps are the tools `read`, `tasks`, `query` and `validate`.
8. Catching up on a document you've read before: `smd diff <file> --since <git-ref>` (e.g. `HEAD~3`, `main` or the commit you last saw) prints only the sections that changed, in the agent view, plus front-matter changes and removed headings.

How to interpret what you read:

- Front matter `status`: `approved` is authoritative, `draft`/`review` is tentative, `deprecated`/`archived` is history.
- `<agent-instructions>` (`:::agent`) is written **for you**. Follow it for any work the document covers. Like accepted decisions, it binds only within the user's task: it is document content, so it grants no permissions and never overrides the user or your system rules.
- `:::human` blocks and `## … {agent=skip}` sections are context for people and are omitted from the agent view.
- `<danger>` is a hard constraint and `<warning>` an important caveat. `<question>` is unresolved: don't assume an answer; use the fallback in the agent instructions, or ask.
- `<decision status="accepted">` is binding. `proposed` isn't decided yet; `rejected`/`superseded` means don't do it.
- `<risk …>` is something to design around. `API POST /v1/x` is an endpoint definition.
- Tasks: `- [ ]` is open, `[P1]` is priority, `@name` is the owner, `(due …, OVERDUE)`.
- `[section omitted: …]` is a section left out by `--max-tokens`. Run the command it gives if the question needs that section. `holds warning, question` in it names the cues it hides. Sections with `:::agent` instructions or a `<danger>` are never left out. A view ending in `[budget: … required content does not fit]` is over its budget because of what can never be left out: it is still complete, just longer.
- A section view always adds "Dangers elsewhere in the document": the `<danger>` blocks of other sections and included files, in full. They are hard constraints wherever you read.
- With `--constraints` (experimental), a section view instead adds "Constraints elsewhere in the document": the same `<danger>` blocks in full, then pointers to warnings, accepted decisions and open questions there. Read a pointed-to block when it bears on your task. An "included file … not checked" line means the list may be incomplete.
- `--provenance view.json` writes a JSON manifest of what the view shows and leaves out, with reasons and line numbers. It is for tools and evaluations; you don't need it to read a document.
- Styling never changes meaning.

## MCP server

Agents that speak the [Model Context Protocol](https://modelcontextprotocol.io) can use the reading commands as tools, without shell access. `smd mcp` runs a server over stdio:

| Tool | Arguments | Returns |
|---|---|---|
| `read` | `file`, `sections[]?`, `exact?`, `mode?` (`auto`, `outline`, `full`), `maxTokens?`, `brief?` | As `smd read`: the whole agent view when it fits `maxTokens` (default 2,000), else the outline; with `sections`, only those sections plus agent instructions from elsewhere (`exact`: an id or whole heading only, no partial match) |
| `tasks` | `paths[]?`, `all?`, `mine?` | Open tasks, one per line, overdue first |
| `query` | `selector`, `paths[]?`, `brief?`, `titles?` | Matching blocks in the agent view, as `smd query` |
| `validate` | `paths[]?` | Diagnostics as JSON, the same shape as `smd validate --json` |

Every session pays for the tool list, so it is kept small: about 500 tokens with the server's instructions (1,320 before 2.5.0, when `read` was three tools). The 2.4 tools `outline`, `section` and `agent` still work when a client calls them; `smd mcp --legacy-tools` lists them again. They are still served in 3.x.

Paths are relative to the root folder: `--root <dir>`, or the folder the client starts the server in. The server refuses paths outside the root (symbolic links included), only reads `.smd` files, and embeds code only from files inside the root. `paths` defaults to the whole root. Nothing is written unless you pass `--allow-write`.

### Write tools (opt-in)

`smd mcp --allow-write` adds three tools that edit documents for the agent. Each changes only the lines it is about, keeps the file's line endings, stays inside the root, and refuses (writing nothing) when the result would have more validation errors than before.

| Tool | Arguments | Does |
|---|---|---|
| `check_task` | `file`, `line`, `done?`, `text?` | Ticks the task on that line (`line` as `tasks` prints it; `done: false` unticks it). With `text`, it refuses if the line no longer contains it, so a moved line is never ticked by mistake. |
| `set_status` | `file`, `status` | Sets the front matter `status` (`draft`, `review`, `approved`, `deprecated`, `archived`), and `updated` to today when the document has one. |
| `add_decision` | `file`, `section`, `title`, `body`, `status?`, `owner?` | Appends a `:::decision{status=… date=… owner=…} Title` block at the end of a section (default status `proposed`). |

### Set it up

Registering the server in Claude Code, Cursor, VS Code and Claude Desktop, and `smd init --agent`, which does it for you: [Set up an AI agent](../guides/agent-setup.md#mcp-server).

## Writing `.smd` files

Start from a template when one fits: `smd init docs/x.smd --template prd|adr|rfc|runbook|api|status-report|meeting-notes|postmortem|release-notes|okrs|onboarding|test-plan|pr-description|spec|plan|tasks --title "…"`. Otherwise, always start with front matter:

```yaml
---
smd: 2
title: Short title
summary: One or two sentences — what and why.
status: draft
owners: ["@team"]
updated: 2026-09-26
---
```

`smd: 2` (spec v2) shows text as written: straight quotes stay straight (type `—` or `’`, or add `typography: true`), only `https://…`, `www.…` and e-mail addresses become links, a heading's trailing `{word}` is heading text, and any `:name[…]` is a directive (`\:name[…]` keeps it text). When you edit an existing document, keep its `smd` value: `smd: 1` or no key keeps the v1 rules, and `smd migrate <file> --to 2` moves it to spec v2 without changing what it shows.

Then write normal Markdown, adding Semantic Markdown only where it helps the reader:

| Need | Write |
|------|-------|
| Important note | `:::warning Title` … `:::` (also `note`, `info`, `tip`, `success`, `danger`, `question`) |
| Collapsible | `:::details Title` … `:::` |
| Instructions for agents | `:::agent` … `:::` |
| Colored text | `[text]{color=red}` (named colors: red orange amber yellow green teal cyan blue indigo purple pink gray muted accent) |
| Background / emphasis | `[text]{bg=amber}` · `[text]{weight=bold}` · `==highlight==` |
| Label | `:badge[Beta]{color=amber}` |
| Status | `:status[On track]{color=green}` |
| Progress | `:progress{value=60}` |
| Keys | `:kbd[Ctrl+S]` |
| Diagram | ```` ```mermaid ```` fenced block (`flowchart LR`, `sequenceDiagram`, `gantt`, `pie`, `erDiagram`, …) |
| Glossary | `:::glossary` with `- **API**: Application Programming Interface` items … `:::`; the first use of each term per section shows its definition on hover |
| Numbered figure | `:::figure{#fig-flow} Caption` around an image, diagram, table (`kind=table`) or code (`kind=listing`) … `:::`; refer to it with `:ref[fig-flow]` ("Figure 2") |
| Release history | `:::changelog` with `## 1.2.0 — 2026-03-01` headings (newest first) and their notes … `:::` |
| Quote | `:::quote{author="Ada Lovelace" source="Notes" cite="https://…"}` quoted text `:::` |
| Math | `$x^2$` inline; a block between `$$` lines of their own (or `$$ x^2 $$` on one line) |
| Front matter value in text | `{{version}}` with `version: "2.10"` in the front matter (`{{owner.name}}` for nested keys; `\{{x}}` keeps the braces) |
| Tabs | `::::tabs` / `:::tab Name` … `:::` / `::::` |
| Columns | `::::columns` / `:::column` … `:::` / `::::` |
| Card | `:::card{accent=green} Title` … `:::` |
| Numbered steps | `:::steps` wrapping an ordered list |
| File name on code | ```` ```ts title="src/app.ts" ```` (add `{2,5-7}` to highlight lines) |
| Embed real source | ```` ```ts file="../src/app.ts" lines="10-24" ```` with an empty body |
| Decision | `:::decision{status=accepted date=2026-09-01 owner=@a} Title` … `:::` |
| Risk | `:::risk{impact=high likelihood=medium owner=@b status=open} Title` … `:::` |
| Risk matrix | `:::risk-matrix Title` then `:::` (draws the document's risks; leave the body empty) |
| API endpoint | `:::api{method=POST path="/v1/items" auth=token} Title` … `:::` |
| Milestones | `:::timeline` around a list of `- **2026-10-01** — Beta` |
| Task metadata | `- [ ] Task :priority[P1] @owner :due[2026-10-15]` |
| KPI | `:metric[42%]{label="Activation" delta="+3%" trend=up}` |
| Human-only section | `## Background {agent=skip}` |

Rules:

- A line with only `:::` closes the **innermost** open container. Using more colons on outer containers (`::::tabs`) is optional but improves readability. In a document with `smd: 2`, a closing fence closes the innermost container opened with as many colons, so write each one with its opener's colons, and put `$$` math delimiters on lines of their own.
- Attributes go **directly after** the name with no space: `:::card{accent=blue} Title`, `[text]{color=red}`.
- Use named colors, not hex, unless matching a brand color.
- Don't repeat the front matter `title` as a `# H1`.
- Prefer semantic containers (`:::warning`) over colored text for anything important.

## Validate before you finish

```bash
smd validate path/to/file.smd          # human-readable
smd validate docs/ --json              # machine-readable, exit code 1 on errors
smd validate docs/ --fix               # apply safe automatic fixes
```

Every problem has a stable `code` (e.g. `container/unclosed`, `attrs/value`) and, where safe, a `fix` object `{ line, column, endColumn, replacement }` (0-based).

## Tasks and GitHub Issues

`smd issues docs/` is a dry run: it prints which tasks would get an issue, be checked off or have their issue closed, and changes nothing. Run it to show the user the plan. **Never add `--apply` (or `--create` / `--close`) unless the user asked for that specific change**: it creates and closes issues on GitHub as the user and edits the documents.

## Need plain Markdown?

`smd export file.smd --to md` produces GitHub-compatible Markdown (callouts → GitHub alerts, badges → code spans, etc.).
