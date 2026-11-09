# Documentation

Every document about Semantic Markdown, grouped by what it is for. Start with the [install guide](guides/install.md) or the [feature guide](reference/features.md).

The guides and the reference are also published as the [user guide](https://bislink360.github.io/semantic-markdown/guides/index.html) on the website, with a sidebar and search. The Pages workflow builds them from this folder on every push to `main`; a link to a file outside `guides/`, `reference/` and `images/` points at it on GitHub there.

## Guides

How to set something up or get a task done.

| Document | For |
|---|---|
| [guides/install.md](guides/install.md) | The VS Code extension, the `smd` CLI and npm library, MkDocs, the web playground, Obsidian and building from source |
| [guides/agent-setup.md](guides/agent-setup.md) | AI agents: the Claude Code plugin, `smd init --agent`, the MCP server, and the agent skills in Claude Code, Claude.ai, the API and other agents |
| [guides/editors.md](guides/editors.md) | Neovim, Helix, Zed, JetBrains IDEs and other editors, with the language server and Tree-sitter highlighting |
| [guides/github-and-ci.md](guides/github-and-ci.md) | The GitHub Action, `smd validate` in any CI, pre-commit hooks, and making `.smd` files readable on GitHub |
| [guides/spec-driven.md](guides/spec-driven.md) | Spec → plan → tasks with an agent |
| [guides/upgrading.md](guides/upgrading.md) | Moving from Styled Markdown (3.0) and upgrading to 2.0 |

## Reference

What the format and the tools are and promise.

| Document | For |
|---|---|
| [reference/features.md](reference/features.md) | Every construct with its syntax, rendering, agent view and plain-Markdown fallback; the VS Code extension, the CLI and the Block Editor |
| [reference/spec.md](reference/spec.md) | The formal specification (v2, with the v1 rules it keeps) and the validation rules |
| [reference/agents.md](reference/agents.md) | The one-page guide to paste into an agent's instructions, and the MCP server's tools |
| [reference/compatibility.md](reference/compatibility.md) | The stability promise: what each release may change, deprecations, release cadence |

## Reports

Measurements, each with its method, the machine and commit it ran on, and how to run it again.

| Document | For |
|---|---|
| [reports/tokens.md](reports/tokens.md) | What the agent view saves and costs, and when the tools pay off |
| [reports/performance.md](reports/performance.md) | Parse counts, read latency and memory on large documents |
| [reports/accessibility.md](reports/accessibility.md) | The automated and browser accessibility checks and what still needs people |

## RFCs

Design proposals and the decisions taken on them.

| Document | Status |
|---|---|
| [rfcs/spec-v2.smd](rfcs/spec-v2.smd) | Accepted 2026-10-15, shipped in 2.0 |
| [rfcs/collaboration.smd](rfcs/collaboration.smd) | Accepted 2026-10-31; phase 1 (`smd merge`) shipped in 2.6 |
| [rfcs/research-contract.smd](rfcs/research-contract.smd) | Accepted; research gate G0 |
| [rfcs/semantic-tags.smd](rfcs/semantic-tags.smd) | In review; decisions D1–D6 accepted 2026-11-07, block id groundwork built |

## Requirements

What a feature or a study must achieve, before its RFC.

| Document | For |
|---|---|
| [requirements/research-interaction.smd](requirements/research-interaction.smd) | Attention, feedback and retrieval: the research requirements and gates G0–G5 |
| [requirements/semantic-tags.smd](requirements/semantic-tags.smd) | Tags for requirements, constraints, assumptions and evidence |
| [requirements/tree-and-graph-filtering.smd](requirements/tree-and-graph-filtering.smd) | Selecting blocks by the document tree and the reference graph |

## Maintainers

| Document | For |
|---|---|
| [maintainers/publishing.md](maintainers/publishing.md) | Listings outside the Release workflow: the Claude Code plugin marketplace and the MCP Registry |

The pages in [gallery/](gallery/) are the sources of the screenshots in [images/](images/), and CI checks that they validate.

## Research workspace

The [Study 1 corpus](../research/corpus/) and [annotation guide](../research/annotation-guide.smd) are available in this checkout. The full workspace adds the research protocols, experiment runner, paper, and retained evidence. Request `semantic-markdown-research-2026-11-08-v1.zip` from the research maintainer and extract it at the root of a fresh checkout. Open `research/README.md` for the layout and restore instructions.

From the restored checkout, run `node research/experiment/run.mjs --paper` to replay the paper with its pinned tool and frozen 618-task corpus.

## Naming and placing documents

- **One folder per kind:** `guides/`, `reference/`, `reports/`, `rfcs/`, `requirements/`, `maintainers/`. The folder says what a document is, so the name doesn't repeat it: `rfcs/collaboration.smd`, not `COLLABORATION-RFC.smd`.
- **Names** are lowercase, with words joined by hyphens, and name the topic in one to three words: `agent-setup.md`, `tree-and-graph-filtering.smd`. No dates, versions or status in the name; those go in the front matter.
- **Format:** guides, reference and reports are `.md`, so GitHub renders them and the published READMEs can link to them. RFCs and requirements are `.smd`, written for people and agents, with `status`, `owners` and `related:` in the front matter.
- **One topic, one place.** Before adding a section, check whether another document covers it, and link to that instead of repeating it.
- **New documents** are added to this page. Renaming one means updating every link to it: the published READMEs, the CLI's help text and the release notes link to these paths, and GitHub doesn't redirect renamed files.
- **Images** go in `images/`, named after what they show (`01-overview.png`; a number only where the order matters).
