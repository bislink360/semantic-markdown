<p align="center">
  <img src="docs/images/icon.png" width="112" alt="Semantic Markdown icon">
</p>

<h1 align="center">Semantic Markdown (<code>.smd</code>)</h1>

<p align="center">
  <b>Semantic Markdown is Markdown for the specs, plans and docs that AI coding agents and people both read.</b><br>
  Decisions, risks, tasks and agent instructions that tools understand, validated in CI, and read by agents a section at a time.
</p>

<p align="center"><sub>Formerly <b>Styled Markdown</b>. Same format, new name: see <a href="docs/guides/upgrading.md#moving-from-styled-markdown">moving from Styled Markdown</a>.</sub></p>

<p align="center">
  <a href="https://github.com/bislink360/semantic-markdown/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/bislink360/semantic-markdown?label=release&color=4f46e5"></a>
  <a href="docs/reference/compatibility.md"><img alt="Spec: smd v2, stable" src="https://img.shields.io/badge/spec-smd%20v2%20stable-7c3aed"></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-22c55e"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#for-ai-agents">For agents</a> ·
  <a href="https://bislink360.github.io/semantic-markdown/playground/">Playground</a> ·
  <a href="docs/reference/features.md">Feature guide</a> ·
  <a href="docs/reference/spec.md">Specification</a>
</p>

<p align="center">
  <a href="https://bislink360.github.io/semantic-markdown/playground/"><img src="docs/images/playground.gif" width="800" alt="Writing a short .smd document in the playground: the preview shows a decision, a risk and tasks as they are typed; the agent view gives an agent the same document in about half the tokens, without the people-only notes; Diagnostics catches a misspelled status."></a>
</p>

---

## Install

**Claude Code:** the plugin brings the reading and writing skills and the `smd` MCP server.

```text
/plugin marketplace add bislink360/semantic-markdown
/plugin install semantic-markdown@semantic-markdown
```

**Any agent, one project:** run this in your repository and commit the result. It installs the skills (Claude Code) or a rules file (Cursor, Copilot, `AGENTS.md`), the CLI at `.smd/smd.cjs`, the MCP server config and the `AGENTS.md` snippet.

```bash
npx semantic-markdown init --agent claude      # or cursor, copilot, agents
```

**VS Code:** install **Semantic Markdown** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=bislink360.semantic-markdown), or `code --install-extension bislink360.semantic-markdown`. **Cursor, VSCodium, Windsurf:** download **`semantic-markdown-3.0.0.vsix`** from the [latest release](https://github.com/bislink360/semantic-markdown/releases/latest), then `cursor --install-extension semantic-markdown-3.0.0.vsix` (`codium …` for VSCodium), or **Install from VSIX…** in the Extensions view. Open a `.smd` file and press **`Ctrl+K V`** (**`Cmd+K V`** on macOS) for the live preview.

**CLI and library** (Node.js 22+):

```bash
npm install -g https://github.com/bislink360/semantic-markdown/releases/download/v3.0.0/semantic-markdown-3.0.0.tgz   # the smd command
smd validate docs/
```

> The npm registry and Open VSX listings are coming. Until the package is on npm, `npx semantic-markdown …` doesn't work yet: use the files from the [latest release](https://github.com/bislink360/semantic-markdown/releases/latest), or `node smd.cjs init --agent claude` with the [single-file CLI](docs/guides/install.md#install-the-smd-cli).

Everything else (the MCP server on its own, JetBrains, Obsidian, MkDocs, Neovim and other editors, the GitHub Action, pre-commit hooks, Astro and Docusaurus): **[docs/guides/install.md](docs/guides/install.md)**. Or try it first in the **[web playground](https://bislink360.github.io/semantic-markdown/playground/)**, nothing to install.

![A Semantic Markdown document rendered in the preview](docs/images/01-overview.png)

## For AI agents

Semantic Markdown makes the meaning of a document explicit, so an agent can tell an accepted decision from a proposal, a hard constraint from a side note, and its own instructions (`:::agent`) from content for people. The tools let it read only what a task needs:

| Command (CLI) or tool (MCP) | Gives the agent |
|---|---|
| `smd read spec.smd` · MCP `read` | The whole agent view when it fits a budget (default 2,000 tokens), else the outline with token costs; then `smd agent spec.smd --section "…"` (MCP `read` with `sections`) for just the parts it needs |
| `smd tasks docs/` · MCP `tasks` | Open tasks across documents with owner, priority and due date, overdue first: a work queue |
| `smd query "decision[status=accepted]" docs/` · MCP `query` | Just the blocks it asks for: decisions, risks, APIs, open questions |
| `smd validate docs/` · MCP `validate` | Problems with rule codes and machine-applicable fixes, as a gate before it commits |
| `smd mcp --allow-write` | Opt-in write tools: `check_task`, `set_status`, `add_decision`, each validated |

**What it saves, measured.** The agent view drops styling, layout and content marked for people only. On seven sample documents ([extension/test/samples](extension/test/samples/)), the full agent view is **4–37% smaller** than the file (median ≈17%) and `--brief` **13–43%**; reading the outline plus one section costs **about 80% less** than the file on 6k–8k-token documents. The bigger the document and the more often it is read, the more that adds up. For a small document (under ≈1,500 tokens) the skill and tool overhead costs more than it saves: just read the file, as the reader skill does. Methodology, fixed costs and a break-even table: **[docs/reports/tokens.md](docs/reports/tokens.md)**; what the agent view keeps and drops: [docs/guides/agent-setup.md](docs/reports/tokens.md#how-the-savings-arise). `smd savings docs/` reports the numbers for your own repository.

Measured on [`checkout-redesign.smd`](extension/test/samples/checkout-redesign.smd), a ≈2,500-token PRD (≈4 characters per token):

| How it's read | ≈ tokens | Saving |
|---|---:|---:|
| Raw file | 2,471 | — |
| `smd agent` (whole document) | 1,540 | 38% |
| `smd agent --brief` | 1,406 | 43% |
| `smd outline` + `smd agent --section "open questions"` | 630 | 75% |
| `smd tasks` on all 7 samples vs. reading them | 704 vs 7,328 | 90% |
| `smd query "decision, risk"` on all 7 samples vs. reading them | 827 vs 7,328 | 89% |

**Spec-driven work:** `spec`, `plan` and `tasks` templates turn a feature into three linked documents an agent works through, with `smd tasks` as its queue and `smd validate` as the gate: [docs/guides/spec-driven.md](docs/guides/spec-driven.md). Setup for each agent: [docs/guides/agent-setup.md](docs/guides/agent-setup.md) and [docs/reference/agents.md](docs/reference/agents.md).

## Why Semantic Markdown?

Markdown is the lingua franca of engineering docs, but teams keep stretching it. `**IMPORTANT:**` stands in for warnings, raw HTML for color and layout, and nobody finds a broken diagram until someone opens the file. AI agents reading those docs spend tokens on decoration and history, and can't tell a hard constraint from a side note.

- **Every `.md` file is already a valid `.smd` file.** Rename it and add structure where it helps.
- **Meaning is explicit.** `:::warning`, `:::decision`, `:::risk`, `:::api` and `:::agent` say what content *is*, not just how it looks.
- **Everything is validated,** with rule codes and automatic fixes, in VS Code and in CI.
- **Agents read only what matters,** through the agent view, the outline and queries.
- **Requirements and reviews live in the document.** `:::requirement`, `:::constraint` and `:::acceptance` blocks with ids, questions with a lifecycle, and `:::comment` and `:::suggestion` blocks that know when their target changed. `smd query --follow` brings what a block depends on, and `smd review` accepts or rejects a suggestion.
- **Safe and portable.** No scripts, allowlisted styles, and a one-command export to HTML, GitHub Markdown, PDF or Word.
- **Stable.** Spec v2 gets no breaking changes; tools releases follow a [compatibility policy](docs/reference/compatibility.md).

| | Developers | Product & project managers | AI agents |
|---|---|---|---|
| Write | API blocks, code highlights, live code embeds, diagrams, math | Decisions, risks, timelines, KPIs, task owners and due dates | A writer skill with 16 templates and a validator |
| Read | Syntax-highlighted preview, outline, folding | Status header, colored callouts, overdue tasks in red | `smd read`, then only the needed sections |
| Check | Problems panel + quick fixes, `smd validate` in CI | `smd tasks` across all docs, overdue first | `--json` diagnostics with machine-applicable fixes |

## A taste of the syntax

````markdown
---
smd: 2
title: Saved Searches
summary: Let users save a search and get notified when new results match.
status: review
owners: ["@product-search"]
---

:metric[38%]{label="Abandonment" delta="-2.1pp" trend=down good=down}

:::warning Breaking change
`GET /v1/search` requires the `filters` object from 2026-11-01.
:::

- [ ] Idempotent order creation :priority[P0] @api-team :due[2026-10-03]

:::decision{status=accepted date=2026-09-08 owner=@maya} Accordion layout on mobile
Won usability testing on completion rate.
:::

```mermaid
flowchart LR
    A[Search] --> B[Save] --> C[Notify]
```

## Background {agent=skip}
History and research. People see it; agents skip it.

:::agent
- All prices are integer cents.
:::
````

Every construct, with what it renders, what an agent reads and its plain-Markdown fallback: **[the feature guide](docs/reference/features.md)** (its [At a glance](docs/reference/features.md#at-a-glance) section lists everything the format, the VS Code extension, the CLI and the skills do).

## At a glance

<table>
<tr>
<td width="50%"><img src="docs/images/02-project-management.png" alt="KPIs, tasks with owners and due dates, decision, risk and timeline"><br><sub><b>Project management:</b> KPI tiles, tasks with priority/owner/due date, decisions, risks, timelines</sub></td>
<td width="50%"><img src="docs/images/03-developers.png" alt="API endpoint, embedded source code with highlighted lines, sequence diagram"><br><sub><b>Developers:</b> API endpoints, code embedded from the repo with line highlights, Mermaid diagrams</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/images/04-dark-layout.png" alt="Dark theme with cards, tabs, flowchart and agent block"><br><sub><b>Layout & theming:</b> cards, columns, tabs, diagrams, math. Light and dark follow VS Code.</sub></td>
<td width="50%"><img src="docs/images/05-agent-view.png" alt="smd outline and smd agent output"><br><sub><b>Agent view:</b> an outline with per-section token costs, then only the section needed</sub></td>
</tr>
</table>

## On GitHub

GitHub renders `.md` files but shows `.smd` files as source. You can write Semantic Markdown syntax in `.md` files, generate `.md` copies in CI with `smd export --to md`, or post the changed sections on pull requests: **[docs/guides/github-and-ci.md](docs/guides/github-and-ci.md)** compares them, with complete workflows. To check documents on every pull request, with each problem annotated on its line:

```yaml
- uses: bislink360/semantic-markdown/validate@v3.0.0
  with:
    paths: docs
```

## Documentation

All the documentation, grouped into guides, reference, reports, RFCs and requirements: **[docs/README.md](docs/README.md)**. The ones most people need:

| Document | For |
|---|---|
| [docs/guides/install.md](docs/guides/install.md) | Installing and updating the VS Code extension, the CLI and library, MkDocs, the playground and Obsidian |
| [docs/guides/agent-setup.md](docs/guides/agent-setup.md) | Setting up AI agents: the Claude Code plugin, `smd init --agent`, the MCP server and the agent skills |
| [docs/reference/features.md](docs/reference/features.md) | Feature guide: every construct with syntax, rendering, agent view and plain-Markdown fallback; the VS Code extension, the CLI and the Block Editor |
| [docs/reference/agents.md](docs/reference/agents.md) | One-page guide to paste into any agent's instructions, and the MCP server's tools |
| [docs/guides/github-and-ci.md](docs/guides/github-and-ci.md) | The GitHub Action, pre-commit hooks, and making `.smd` documents readable on GitHub |
| [docs/guides/editors.md](docs/guides/editors.md) | Using `.smd` in Neovim, Helix, Zed, JetBrains IDEs and other editors |
| [docs/guides/spec-driven.md](docs/guides/spec-driven.md) | Spec → plan → tasks with an agent |
| [docs/guides/upgrading.md](docs/guides/upgrading.md) | Moving from Styled Markdown and upgrading to 2.0 |
| [docs/reports/tokens.md](docs/reports/tokens.md) | What the agent view saves, measured, and when it doesn't pay |
| [docs/reference/spec.md](docs/reference/spec.md) | The formal specification (v2, with the v1 rules it keeps) and validation rules |
| [docs/reference/compatibility.md](docs/reference/compatibility.md) | The stability promise: spec v2 is stable, what each release may change, deprecations, release cadence |

## Contributing

Bug reports, ideas and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the repository layout and good first issues, and [Discussions](https://github.com/bislink360/semantic-markdown/discussions) for questions. To build and test:

```bash
cd extension
npm install
npm run build          # bundle extension + CLI; refresh the CLI bundled in skills/*/scripts
npm test               # unit tests
npm run test:vscode    # integration checks inside a real VS Code
npm run package        # → semantic-markdown-3.0.0.vsix
npm run build:npm      # → ../npm/dist (the npm package)
npm run build:playground  # → dist/playground (the web playground; open its index.html)
```

Press **F5** in `extension/` to launch an Extension Development Host with the test samples open.

## Author

**Roshan Alwis**, [bislink360](https://github.com/bislink360)

## License

Copyright 2026 bislink360. Licensed under the [Apache License, Version 2.0](LICENSE).
