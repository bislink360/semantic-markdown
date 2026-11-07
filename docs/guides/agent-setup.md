# Set up an AI agent

Agents read `.smd` documents through the CLI or the MCP server instead of reading the files whole, and write them from templates with the validator as a check. Pick one way in: the Claude Code plugin, one command per project, the MCP server on its own, or the agent skills. What an agent should do with the documents once it is set up is in [the agent guide](../reference/agents.md).

## Contents

- [Claude Code plugin](#claude-code-plugin)
- [One command for a project: `smd init --agent`](#one-command-for-a-project-smd-init---agent)
- [MCP server](#mcp-server)
- [The agent skills](#the-agent-skills)
- [Skills in Claude Code](#skills-in-claude-code)
- [Claude.ai and the Claude desktop app](#claudeai-and-the-claude-desktop-app)
- [Claude API and Claude Agent SDK](#claude-api-and-claude-agent-sdk)
- [GitHub Copilot, Cursor, Codex, Windsurf and other agents](#github-copilot-cursor-codex-windsurf-and-other-agents)
- [Verify the skills work](#verify-the-skills-work)
- [Writing documents that stay cheap to read](#writing-documents-that-stay-cheap-to-read)
- [Update or remove](#update-or-remove)

## Claude Code plugin

In Claude Code (2.1 or later), add this repository as a plugin marketplace and install the plugin:

```text
/plugin marketplace add bislink360/semantic-markdown
/plugin install semantic-markdown@semantic-markdown
```

From a shell, the same is `claude plugin marketplace add bislink360/semantic-markdown` and `claude plugin install semantic-markdown@semantic-markdown`. The plugin brings:

- the **`semantic-markdown-reader`** and **`semantic-markdown-writer`** skills (as `semantic-markdown:semantic-markdown-reader` and `semantic-markdown:semantic-markdown-writer`), each with the `smd` CLI bundled;
- the **`smd` MCP server**, read-only: it serves the `.smd` files under the folder it is started in, your project when you run Claude Code from its root.

It needs Node.js 22 or newer on the `PATH`. The plugin's version is the release's: after a release, `claude plugin marketplace update semantic-markdown` and `claude plugin update semantic-markdown@semantic-markdown` bring it up to date. The two skill descriptions add about 320 tokens to each session; a skill's full instructions load only when a task needs them.

## One command for a project: `smd init --agent`

From your project's root, one command installs everything an agent needs and can be committed for the whole team:

```bash
npx semantic-markdown init --agent claude     # or cursor, copilot, agents
```

| `--agent` | Writes |
|---|---|
| `claude` | The skills in `.claude/skills/`, the MCP server in `.mcp.json` |
| `cursor` | `.cursor/rules/semantic-markdown.mdc`, the MCP server in `.cursor/mcp.json` |
| `copilot` | `.github/instructions/semantic-markdown.instructions.md`, the MCP server in `.vscode/mcp.json` |
| `agents` | A Semantic Markdown section in `AGENTS.md` (Codex, Windsurf and other agents that read it) |

Every target also gets the CLI at `.smd/smd.cjs` and the `AGENTS.md` snippet. `--dir <project>` sets the project folder. Give several targets separated by commas (`--agent cursor,agents`). Running it again updates the files in place. MCP config files that already exist are merged, so your other servers stay; a file that isn't plain JSON, such as one with comments, is left alone and the entry to add is printed. `--no-mcp` skips the MCP config.

`npx semantic-markdown` works once the package is on the npm registry. Until then, use the CLI from a release: `node smd.cjs init --agent claude` with the single file from [Install the `smd` CLI](install.md#install-the-smd-cli), or `smd init --agent claude` after installing the release's `.tgz`. The older `smd skills install --target claude,cursor,copilot,agents` still works and installs the skills or rules without the MCP config ([The agent skills](#the-agent-skills)).

## MCP server

`smd mcp` serves the reading tools (`read`, `tasks`, `query`, `validate`) over stdio to any MCP client, without shell access. `smd mcp --allow-write` adds tools that change documents, each checked by the validator and kept inside the root folder: `check_task` (tick or untick a task), `set_status` (the front matter `status`) and `add_decision` (a `:::decision` at the end of a section). Every tool and its arguments: [the agent guide](../reference/agents.md#mcp-server).

`smd init --agent` registers it for you. To register it by hand, use the npm package (`npx` downloads it on first use) or the CLI bundled in the reader skill:

```bash
# Claude Code (add --scope project to share it through .mcp.json)
claude mcp add smd -- npx -y -p semantic-markdown smd mcp
claude mcp add smd -- node skills/semantic-markdown-reader/scripts/smd.cjs mcp
```

Cursor (`.cursor/mcp.json`) and Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "smd": { "command": "npx", "args": ["-y", "-p", "semantic-markdown", "smd", "mcp", "--root", "/path/to/project"] }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "smd": { "type": "stdio", "command": "npx", "args": ["-y", "-p", "semantic-markdown", "smd", "mcp", "--root", "${workspaceFolder}"] }
  }
}
```

Pass `--root` whenever the client may start the server outside your project, such as Claude Desktop. On Windows, clients that cannot run `npx` directly need `cmd /c npx …` (for Claude Code: `claude mcp add smd -- cmd /c npx -y -p semantic-markdown smd mcp`). Logs go to stderr; stdout carries only protocol messages.

## The agent skills

Semantic Markdown ships two **agent skills**: folders of instructions, references, templates and a bundled tool that an AI agent loads when a task needs them.

| Skill | The agent learns to… | Contents |
|---|---|---|
| **`semantic-markdown-writer`** | **Create and edit `.smd` that follows the rules.** It picks the right template, uses only valid blocks and values, validates and auto-fixes, and writes meaning (decisions, risks, tasks, agent rules) rather than styling, so documents stay cheap to write and to read. | `SKILL.md`, `references/syntax.md` (an index of the syntax topics), `references/syntax/*.md` (the complete syntax in 8 topic files), `references/style-guide.md` (authoring rules), `assets/templates/*.smd` (16 templates), `scripts/smd.cjs` |
| **`semantic-markdown-reader`** | **Read `.smd` with minimal tokens**, focusing only on meaningful content: small files directly, otherwise `smd read` (the agent view, or the outline of a large document), then only the relevant sections, and raw lines only when editing. | `SKILL.md`, `references/reading.md` (every marker of the agent view, commands across many documents, reading without Node.js), `scripts/smd.cjs` |

`scripts/smd.cjs` is the complete `smd` CLI in one file (Node.js 22+, no `npm install`).

The skills load in stages to keep their own cost low. Only the two descriptions (≈260 tokens together) are in context every session. The reader's `SKILL.md` (≈480 tokens) loads when a task needs a `.smd` file, and `references/reading.md` only when the agent needs more than the basics. The writer reads its syntax index and then only the topic file for the construct it is writing. How the skills, the agent view and author markup cut tokens, what they cost and the break-even document size: [the token report](../reports/tokens.md).

## Skills in Claude Code

Claude Code discovers skills in two places:

| Scope | Folder | Use when |
|---|---|---|
| **Project** | `<repo>/.claude/skills/` | Everyone who works in the repository should get the skills. Commit the folder. |
| **Personal** | `~/.claude/skills/` | You want the skills in every project on your machine. |

### Option 1 — install with the CLI (recommended)

```bash
# Get the CLI (a single file, pinned to the release)
curl -sLo smd.cjs https://raw.githubusercontent.com/bislink360/semantic-markdown/v3.0.0/skills/semantic-markdown-reader/scripts/smd.cjs

# Personal: all your projects
node smd.cjs skills install --global

# Project: run from your repository root, then commit .claude/skills/
node smd.cjs skills install
```

From a clone of this repository, use the bundled copy instead: `node skills/semantic-markdown-reader/scripts/smd.cjs skills install --global`.

Output:

```text
Installed semantic-markdown-reader  → …/.claude/skills/semantic-markdown-reader  (read .smd token-efficiently …)
Installed semantic-markdown-writer  → …/.claude/skills/semantic-markdown-writer  (create and edit .smd following the rules …)
```

Options:
- `--only reader` or `--only writer` installs a single skill.
- `--dir <path>` installs into any folder.

### Option 2 — copy the folders

Copy `skills/semantic-markdown-reader/` and `skills/semantic-markdown-writer/` from this repository into `.claude/skills/` (project) or `~/.claude/skills/` (personal). Each folder is self-contained.

### Option 3 — download from the release

Download `semantic-markdown-reader.zip` and `semantic-markdown-writer.zip` from the [latest release](https://github.com/bislink360/semantic-markdown/releases/latest) and unzip them into a skills folder.

Start a new Claude Code session after installing. Skills load automatically when a task matches their description; you don't need to mention them.

## Claude.ai and the Claude desktop app

1. Download **`semantic-markdown-writer.zip`** and **`semantic-markdown-reader.zip`** from the [latest release](https://github.com/bislink360/semantic-markdown/releases/latest). Each zip contains one skill folder.
2. In Claude, open **Settings → Capabilities** and make sure **code execution** is enabled; the skills run their bundled Node.js tool.
3. Under **Skills**, choose **Upload skill** and upload each zip.
4. Start a new chat and attach or paste a `.smd` document, or ask Claude to write one.

> If your plan or workspace doesn't show skill uploads, an administrator may need to enable skills for the organization. If code execution isn't available, the writer skill's rules and templates still guide authoring, but the reader can't produce agent views.

## Claude API and Claude Agent SDK

- **Claude Agent SDK:** place the skill folders in `.claude/skills/` of the project the agent runs in (use `smd skills install --dir <project>/.claude/skills`), and enable project settings and the Skill tool in your agent options as described in the Agent SDK documentation on skills.
- **Claude API (Skills):** upload the zips as custom skills and attach them to requests that use the code execution tool. Follow the current Anthropic documentation for the Skills API, since request fields and beta headers may change.

The skills need a sandbox with Node.js 22+ for `scripts/smd.cjs`.

## GitHub Copilot, Cursor, Codex, Windsurf and other agents

Agents without skill support follow the same workflow through their instruction files.

### Option 1 — install with the CLI (recommended)

Run this from your repository root (get `smd.cjs` as in [Skills in Claude Code](#skills-in-claude-code)), then commit the files it writes:

```bash
node smd.cjs skills install --target cursor,copilot,agents
```

| `--target` | Writes | Loaded by the agent |
|---|---|---|
| `cursor` | `.cursor/rules/semantic-markdown.mdc` | When a `.smd` file is in context (`globs: **/*.smd`) |
| `copilot` | `.github/instructions/semantic-markdown.instructions.md` | When Copilot works on a `.smd` file (`applyTo: "**/*.smd"`) |
| `agents` | A section in `AGENTS.md` between `<!-- semantic-markdown:start -->` and `<!-- semantic-markdown:end -->` | Always, by OpenAI Codex and other agents that read `AGENTS.md` |
| `claude` | The Claude Code skills (the default) | See [Skills in Claude Code](#skills-in-claude-code) |

Pick any combination: repeat `--target` or separate targets with commas. Each run also copies the CLI to `.smd/smd.cjs`, and the rules tell the agent to run `node .smd/smd.cjs read <file>` and so on, so the agent needs Node.js 22+ and nothing else. The rules are short (≈280 tokens) because `AGENTS.md` is in context in every session.

Output:

```text
Installed smd CLI → …/.smd/smd.cjs  (agents run it as: node .smd/smd.cjs)
Created …/.cursor/rules/semantic-markdown.mdc  (Cursor rule for **/*.smd)
Created …/.github/instructions/semantic-markdown.instructions.md  (Copilot instructions for **/*.smd)
Updated …/AGENTS.md  (semantic-markdown section)
```

Notes:
- `AGENTS.md` is created if it's missing. If it exists, only the semantic-markdown section is added or replaced; the rest of the file is kept, and re-running never adds a second section.
- The rule file, the instructions file and the section all have the same content, a short version of [docs/reference/agents.md](../reference/agents.md).
- `--dir <project>` writes into another project root. `--global` and `--only` apply to the Claude skills only, and `--dir` means the skills folder for `claude`, so install `claude` and the other targets in separate runs when you use `--dir`.

### Option 2 — add the guide by hand

For other agents, or to customize the text:

1. Make the CLI available in the repository, for example by committing `.smd/smd.cjs` (copied from `skills/semantic-markdown-reader/scripts/smd.cjs`) or installing it with `npm link`.
2. Add the one-page guide [docs/reference/agents.md](../reference/agents.md) to the agent's instructions, either by copying it or by referencing it:

   | Agent | Instruction file |
   |---|---|
   | GitHub Copilot | `.github/copilot-instructions.md` or `.github/instructions/*.instructions.md` |
   | Cursor | `.cursor/rules/*.mdc` |
   | OpenAI Codex, and most agents | `AGENTS.md` at the repository root |
   | Windsurf | `.windsurfrules` |
   | Gemini CLI | `GEMINI.md` |

   A minimal snippet:

   ```markdown
   ## Semantic Markdown (.smd)
   Project docs use Semantic Markdown. Follow docs/reference/agents.md.
   - Reading: run `node .smd/smd.cjs read <file>`, then `node .smd/smd.cjs agent <file> --section "<heading>"`
     if it printed the outline. Read files under ≈6 KB directly.
   - Writing: start from `node .smd/smd.cjs init <file> --template prd|adr|rfc|runbook|api|status-report|meeting-notes|postmortem|release-notes|okrs|onboarding|test-plan|pr-description|spec|plan|tasks`,
     then run `node .smd/smd.cjs validate <file> --fix` until there are 0 errors.
   ```

Agents that support the Model Context Protocol (Cursor, VS Code, Claude Desktop, Claude Code) can instead register the MCP server, `smd mcp`, which offers the same reading commands as tools. See [MCP server](#mcp-server).

## Verify the skills work

Try these prompts in a new session in a repository that contains `.smd` files (this repository's `extension/test/samples/` folder works):

| Prompt | Expected behaviour |
|---|---|
| *"What constraints apply to POST /v1/orders in extension/test/samples/checkout-redesign.smd, and which @api-team tasks are open?"* | The agent runs `smd read` (the whole agent view fits 2,000 tokens, so one call is enough). It doesn't read the raw file, and it reports the idempotency, integer-cents and 422 rules plus the two open tasks, one of them overdue. |
| *"Which decisions in the checkout spec are final and what is still open?"* | It lists the accepted and rejected decisions, the open question with its owner and deadline, and the fallback from the agent instructions. |
| *"Write an ADR for moving our cron jobs to a managed scheduler, as docs/adr-0012-scheduler.smd."* | The agent uses the `adr` template, fills every placeholder, runs `smd validate --fix`, and ends with 0 errors. |
| *"What's overdue across docs/?"* | It runs `smd tasks docs/`. |
| *"Which high-impact risks are still open, and what did we decide about payments?"* | It runs `smd query "risk[impact>=high][status!=closed], decision[title*=pay]" docs/` and reads only those blocks. |
| *"Which of our docs covers refunds, and what does it say about retries?"* | It runs `smd index docs/`, picks the document by title, summary and tags, then reads only the matching section with `smd agent … --section …`. |
| *"The spec changed since last week. What's different?"* | It runs `smd diff docs/spec.smd --since "HEAD@{1.week.ago}"` (or a commit) and reads only the changed sections. |

## Writing documents that stay cheap to read

The writer skill applies these rules automatically. Humans can follow them too:

- Write a precise one- or two-sentence `summary:` in front matter. It's the first thing every agent reads, and often the only thing it needs.
- Put background, history, research and thanks under `## … {agent=skip}` or in `:::human`.
- Put every hard rule for implementers in **one** `:::agent` block, including the fallback for open questions.
- Use `:::details` for long logs and lists, and embed code with `file="…" lines="…"` instead of pasting it.
- Name headings after their content ("Requirements", "API", "Rollout"), because agents select sections by heading.
- Agents that write should spend their tokens on meaning (decisions, risks, tasks, `:::agent`, `{agent=skip}`) and leave colors and layout to people: output tokens cost about 5× input tokens, and agents reading the document don't see the styling.

## Update or remove

- **Update:** run `smd skills install` again, with the same `--target` values (it overwrites the files and replaces the `AGENTS.md` section), or re-copy the folders or zips from the newer release.
- **Remove:** delete the `semantic-markdown-reader` and `semantic-markdown-writer` folders from your skills directory, or remove them in Claude.ai under **Settings → Capabilities → Skills**. For other agents, delete `.smd/`, `.cursor/rules/semantic-markdown.mdc`, `.github/instructions/semantic-markdown.instructions.md` and the semantic-markdown section of `AGENTS.md` (markers included).
