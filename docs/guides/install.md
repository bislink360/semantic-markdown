# Installing Semantic Markdown

This guide covers the **VS Code extension**, the **`smd` command-line tool** and npm library, the **MkDocs plugin**, the **web playground**, the **Obsidian plugin** and building from source. Other setups have their own guides: [AI agents](agent-setup.md) (the Claude Code plugin, `smd init --agent`, the MCP server and the skills), [CI and pre-commit hooks](github-and-ci.md), [other editors and JetBrains IDEs](editors.md) and [upgrading](upgrading.md).

## Contents

- [Requirements](#requirements)
- [Set up an AI agent](#set-up-an-ai-agent)
- [Install the VS Code extension](#install-the-vs-code-extension)
- [Verify the installation](#verify-the-installation)
- [Recommended settings](#recommended-settings)
- [Install the `smd` CLI](#install-the-smd-cli)
- [CI and pre-commit hooks](#ci-and-pre-commit-hooks)
- [MkDocs plugin](#mkdocs-plugin)
- [Web playground](#web-playground)
- [Obsidian plugin](#obsidian-plugin)
- [JetBrains IDEs](#jetbrains-ides)
- [Update or uninstall](#update-or-uninstall)
- [Upgrading](#upgrading)
- [Build from source](#build-from-source)
- [Troubleshooting](#troubleshooting)

## Requirements

| Component | Needs |
|---|---|
| VS Code extension | VS Code **1.97 or newer**, or a VS Code-compatible editor that installs `.vsix` files (Cursor, VSCodium, Windsurf) |
| CLI and agent skills | **Node.js 22 or newer** |
| MkDocs plugin | Python 3.9+, MkDocs 1.6+ and **Node.js 22 or newer** on `PATH` |
| Obsidian plugin | Obsidian **1.4 or newer**, desktop or mobile |
| JetBrains plugin | A JetBrains IDE with the LSP API: **2025.3 or newer**: IntelliJ IDEA (any edition of the unified IDE), PyCharm, WebStorm, GoLand, RustRover and the others; not Android Studio. **Node.js 22 or newer** for the language server |
| Building from source | Node.js 22+, npm, Git |
| Word export | Nothing (built in). Optionally [Pandoc](https://pandoc.org/installing.html) **3.0 or newer**, for Word equations in `smd export --to docx` and **Export to Word (.docx)** |
| PDF export | Google Chrome, Microsoft Edge (comes with Windows), Chromium or Brave, for `smd export --to pdf` and **Export to PDF** in VS Code and JetBrains IDEs; or Playwright or Puppeteer |

## Set up an AI agent

The Claude Code plugin, `smd init --agent`, the MCP server and the agent skills for every agent: [Set up an AI agent](agent-setup.md).

## Install the VS Code extension

**From the Visual Studio Marketplace (VS Code):** search for **Semantic Markdown** in the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`), or run:

```bash
code --install-extension bislink360.semantic-markdown
```

VS Code then keeps it up to date. The [Marketplace page](https://marketplace.visualstudio.com/items?itemName=bislink360.semantic-markdown) lists the versions.

> **Open VSX:** coming once published. [Open VSX](https://open-vsx.org) is the extension registry of VSCodium, Cursor, Windsurf and Gitpod. Until the listing is live, those editors install the `.vsix` from the GitHub release (Option A).

### Option A — from the release file

1. Open the [latest release](https://github.com/bislink360/semantic-markdown/releases/latest) and download **`semantic-markdown-3.0.0.vsix`**.
2. Install it with **one** of these methods.

   **From the terminal:**

   ```bash
   code --install-extension semantic-markdown-3.0.0.vsix
   ```

   **From VS Code:**
   1. Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
   2. Click the **⋯** menu at the top of the view.
   3. Choose **Install from VSIX…** and select the downloaded file.

   **Drag and drop:** drag the `.vsix` file onto the Extensions view.
3. If VS Code was already open, run **Developer: Reload Window** from the Command Palette.

> Cursor, VSCodium and Windsurf use the same steps (`cursor --install-extension …`, `codium --install-extension …`). Once the Open VSX listing is live, they can also install **Semantic Markdown** from their Extensions view.

### Option B — build and install from source

```bash
git clone https://github.com/bislink360/semantic-markdown.git
cd semantic-markdown/extension
npm install
npm run package
code --install-extension semantic-markdown-3.0.0.vsix
```

## Verify the installation

1. Open or create any file ending in `.smd`.
2. The language mode in the status bar shows **Semantic Markdown**, and the file has the Semantic Markdown icon in the Explorer.
3. Press **`Ctrl+K V`** (`Cmd+K V` on macOS). A live preview opens beside the editor with callouts, diagrams and math rendered.
4. Type `:::warnign` on a new line. A squiggle appears; press `Ctrl+.` and choose **Change to ":::warning"**.
5. Click the **🤖** button in the editor title bar. The agent view opens, showing what an AI agent reads. The status bar shows the estimated token count.

## Recommended settings

Open **Settings** and search for `smd`:

| Setting | Default | Description |
|---|---|---|
| `smd.preview.theme` | `auto` | `auto` follows VS Code; `light` or `dark` forces a theme |
| `smd.preview.showAgentBlocks` | `collapsed` | How `:::agent` blocks appear in the preview: `collapsed`, `expanded` or `hidden` |
| `smd.preview.allowHtml` | `true` | Render raw HTML in documents (scripts never run) |
| `smd.markdownPreview.enabled` | `opt-in` | Which `.md` files get `.smd` syntax in VS Code's built-in Markdown preview: `opt-in` (those with an `smd:` front matter key), `always` or `never` |
| `smd.validation.enabled` | `true` | Show problems as you type |
| `smd.validation.checkLinks` | `true` | Warn about relative links, images and `related:` entries that point to missing files or headings |

Keyboard shortcuts:

| Action | Windows / Linux | macOS |
|---|---|---|
| Preview to the side | `Ctrl+K V` | `Cmd+K V` |
| Preview in the current tab | `Ctrl+Shift+V` | `Cmd+Shift+V` |
| Quick fix | `Ctrl+.` | `Cmd+.` |
| Trigger suggestions | `Ctrl+Space` | `Ctrl+Space` |

All commands are in the Command Palette under **Semantic Markdown:**. They cover opening the preview, opening the Block Editor (and **Reopen in Text Editor**), showing the (brief) agent view, copying the agent view or selected sections, exporting to HTML, Markdown, Confluence (storage format), Notion (JSON) or Word (.docx), converting a Markdown file to `.smd`, validating the whole workspace, **Migrate to Spec v2** and **Preview Migration to Spec v2**, **Set Document Status…**, setting up spell checking, and grouping, showing or hiding tasks in the SMD Tasks view.

## Install the `smd` CLI

The CLI is a **single self-contained file** with no dependencies. Pick one method.

**From the release's npm package (recommended):** npm installs straight from the tarball attached to the release. The npm registry listing is coming soon.

```bash
npm install -g https://github.com/bislink360/semantic-markdown/releases/download/v3.0.0/semantic-markdown-3.0.0.tgz
smd --version       # smd 3.0.0 (Semantic Markdown spec v2)
```

The same package is also a library (`npm install https://github.com/bislink360/semantic-markdown/releases/download/v3.0.0/semantic-markdown-3.0.0.tgz`); see [Use the npm library](#use-the-npm-library) and [npm/README.md](../../npm/README.md).

**Download the single file (no install):**

```bash
curl -sLo smd.cjs https://raw.githubusercontent.com/bislink360/semantic-markdown/v3.0.0/skills/semantic-markdown-reader/scripts/smd.cjs
node smd.cjs --version
```

**Use the copy bundled with the skills (no build needed):**

```bash
git clone https://github.com/bislink360/semantic-markdown.git
node semantic-markdown/skills/semantic-markdown-reader/scripts/smd.cjs --version
```

**Put `smd` on your PATH:**

```bash
cd semantic-markdown/extension
npm install && npm run build
npm link            # now `smd` works everywhere
smd --version       # smd 3.0.0 (Semantic Markdown spec v2)
```

**Without linking:** `node extension/dist/cli.js <command>`.

**First document:** `smd init docs/plan.smd --template prd` writes a new document from a template (`smd templates` lists the 16). New documents, from `smd init`, `smd from-md` and the other writers, say `smd: 2` since 2.0; existing documents keep their rules until you run `smd migrate <files> --to 2` ([spec §10.1](../reference/spec.md#101-migrating-to-spec-v2)).

### Use the npm library

The package renders, validates and converts documents in your own code, with zero dependencies:

```ts
import { renderSmd, validateSmd, agentView } from 'semantic-markdown';
```

Already render Markdown with markdown-it (a docs site, a static site generator, a chat UI)? Add the syntax to your own instance with the plugin, and style it with `semantic-markdown/smd.css`:

```ts
import smd from 'semantic-markdown/markdown-it';
md.use(smd);
```

**Static sites (Astro, Docusaurus, Next.js):** `semantic-markdown/remark` and `semantic-markdown/rehype` are unified plugins that render documents exactly as `smd export --to html` does, inside remark/rehype pipelines:

```js
// astro.config.mjs
import { remarkSmd } from 'semantic-markdown/remark';
export default { markdown: { remarkPlugins: [remarkSmd] } };
```

They work with `.md` files (MDX parses `.smd` attribute lists as JSX, so `.mdx` files are not supported). The API, the plugins' options and limits, and the setup for Astro, Docusaurus and Next.js: [npm/README.md](../../npm/README.md) ([markdown-it plugin](../../npm/README.md#markdown-it-plugin), [remark and rehype plugins](../../npm/README.md#remark-and-rehype-plugins-astro-docusaurus-nextjs)).

**Other editors:** `smd-language-server`, installed with the package (1.5.0 or later), brings validation, quick fixes, the outline, hover, completion and formatting to Neovim, Helix, Zed and other LSP editors: [guides/editors.md](editors.md).

### Optional: Pandoc for Word export

`smd export --to docx` and **Export to Word (.docx)** in VS Code and the JetBrains plugin write Word documents with nothing to install (since 2.4.0). When [Pandoc](https://pandoc.org/installing.html) is installed they hand the document to it instead, which gives Word's own equations and highlighted code. smd does not bundle Pandoc (the CLI and the npm package keep zero dependencies); install Pandoc 3.0 or newer if you want those:

```bash
winget install JohnMacFarlane.Pandoc   # Windows (or the installer or zip from pandoc.org)
brew install pandoc                    # macOS
sudo apt install pandoc                # Debian/Ubuntu (check pandoc --version: 3.0 or newer)
pandoc --version
```

smd finds Pandoc at `--pandoc <path>`, then the `SMD_PANDOC` environment variable, then on the `PATH`; the extension reads the `smd.export.pandocPath` setting first (a user setting, so a workspace can't point it at another program). Without Pandoc, the built-in writer is used; `--engine builtin|pandoc` (VS Code: `smd.export.docxEngine`; JetBrains: **Export to Word → Engine**) picks one, and `--engine pandoc` without Pandoc exits with code 2 and says how to install it (the extension offers an **Install Pandoc** button). `smd export <file.smd> --to docx --html-only -o page.html` writes the HTML smd would give Pandoc, to convert yourself: `pandoc page.html -f html -t docx -o page.docx`.


## CI and pre-commit hooks

The GitHub Action, `smd validate` in any CI and the pre-commit hooks: [GitHub and CI](github-and-ci.md).

## MkDocs plugin

`mkdocs-semantic-markdown` makes the `.smd` files in an [MkDocs](https://www.mkdocs.org) site's `docs_dir` pages, rendered by the same engine as `smd export --to html`, inside the site's theme. It is a Python package that ships the engine as a Node.js script, so the machine that builds the site needs Node.js 22+ on `PATH` (no npm install).

Until it is on PyPI, install the wheel from the GitHub release (each release attaches `mkdocs_semantic_markdown-X.Y.Z-py3-none-any.whl` and the `.tar.gz` source):

```bash
pip install https://github.com/bislink360/semantic-markdown/releases/download/v3.0.0/mkdocs_semantic_markdown-3.0.0-py3-none-any.whl
```

Then add it to `mkdocs.yml`:

```yaml
plugins:
  - search
  - semantic-markdown:
      validate: true      # smd errors become MkDocs warnings (mkdocs build --strict fails on them)
      md_syntax: false    # true: .md pages may use .smd syntax too
```

Options, links, the table of contents, dark mode and includes: [plugin README](../../integrations/mkdocs/README.md).

## Web playground

The playground needs no installation: it is a static page that runs the engine in the browser (see [reference/features.md §19](../reference/features.md#19-web-playground)).

- **From a release:** download `semantic-markdown-playground.zip`, unzip it and open `index.html` in a browser.
- **From source:** `cd extension && npm ci && npm run build:playground`, then open `extension/dist/playground/index.html`.

It works from `file://` and from any static web server. It needs a current browser (Chrome or Edge 103+, Firefox 113+, Safari 16.4+) for the compressed share links. The latest release's playground is also hosted at [bislink360.github.io/semantic-markdown/playground/](https://bislink360.github.io/semantic-markdown/playground/), published from `main` by the Pages workflow.

## Obsidian plugin

The Semantic Markdown plugin for [Obsidian](https://obsidian.md) renders `.smd` syntax in your notes' reading view: `:::` containers, inline directives such as `:badge[…]` and `:status[…]`, and `[text]{color=…}` spans, styled to follow your theme in light and dark mode. ```` ```smd ```` code blocks render in Live Preview too, and `.smd` files open as notes. The engine is bundled into the plugin, so nothing else needs installing.

Until it is in Obsidian's community plugin list, install it from the GitHub release:

1. Download `semantic-markdown-obsidian-X.Y.Z.zip` from the [latest release](https://github.com/bislink360/semantic-markdown/releases/latest).
2. Unzip it into your vault's `.obsidian/plugins/` folder, which gives `.obsidian/plugins/styled-markdown/` with `main.js`, `manifest.json` and `styles.css`.
3. In Obsidian, **Settings → Community plugins**: turn off Restricted mode if it is on, reload the list of installed plugins and turn on **Semantic Markdown**.

To update, replace the three files and reload the plugin. Settings, what renders where, and the limitations (Live Preview, wikilinks and embeds inside containers, `.smd` files and Obsidian's index): [plugin README](../../integrations/obsidian/README.md).

## JetBrains IDEs

The JetBrains plugin runs the language server itself: [Semantic Markdown in other editors](editors.md#jetbrains-ides).

## Update or uninstall

- **Update:** install the newer `.vsix` the same way. VS Code replaces the old version (add `--force` on the command line to reinstall the same version).
- **Uninstall:** Extensions view → Semantic Markdown → **Uninstall**, or `code --uninstall-extension bislink360.semantic-markdown`.
- **Check the installed version:** `code --list-extensions --show-versions | grep semantic`.

## Upgrading

Moving from Styled Markdown and upgrading from 1.x to 2.0: [Upgrading](upgrading.md).

## Build from source

```bash
cd extension
npm install
npm run build          # esbuild bundles dist/extension.js and dist/cli.js, copies Mermaid/KaTeX into media/vendor,
                       # and refreshes skills/*/scripts/smd.cjs and the MkDocs plugin's bridge.cjs
npm test               # unit tests
npm run test:vscode    # integration tests in a real VS Code (uses your installed VS Code, isolated profile)
npm run package        # semantic-markdown-3.0.0.vsix
```

Press **F5** with the `extension/` folder open to start an Extension Development Host with the test samples (`extension/test/samples/`) loaded.

The Obsidian plugin builds with the same toolchain: after `npm install` in `extension/`, run `npm ci`, `npm run typecheck` and `npm run build` in `integrations/obsidian/` (see its [README](../../integrations/obsidian/README.md#building-from-source)).

## Troubleshooting

| Problem | Fix |
|---|---|
| `.smd` opens as plain text | Reload the window. Check that the language mode (bottom right) is *Semantic Markdown*; if not, click it and choose **Configure File Association for '.smd'** → Semantic Markdown. |
| Preview shows diagram source instead of a diagram | The diagram has a syntax error, shown under the diagram, or its type isn't a Mermaid type (the Problems panel reports this). |
| Exported HTML has no diagrams or math offline | The HTML export loads Mermaid and KaTeX from a CDN, so open it with internet access. The in-editor preview works offline. |
| Embedded code shows "Cannot read …" | The path is relative to the `.smd` file and must stay inside the workspace (or the document's folder). |
| `code` command not found | In VS Code, run **Shell Command: Install 'code' command in PATH** (macOS), or reinstall VS Code with *Add to PATH* (Windows). |
| `smd` prints `node: not found` | Install Node.js 22+ from [nodejs.org](https://nodejs.org). |
