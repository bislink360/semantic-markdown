# Publishing to agent registries

Maintainer notes for the listings that sit outside the tag-triggered Release workflow (which publishes the VS Code Marketplace, Open VSX, npm and the GitHub release). Users don't need this page; their side is in [INSTALL.md](INSTALL.md#claude-code-plugin).

## Claude Code plugin marketplace

Nothing to publish. The repository is the marketplace: `.claude-plugin/marketplace.json` lists one plugin, `semantic-markdown`, whose root is the repository root (`"source": "./"`), and `.claude-plugin/plugin.json` declares it:

- **Skills:** found in `skills/<name>/SKILL.md`, so both `semantic-markdown-reader` and `semantic-markdown-writer`. The loose `skills/agent-rules.md` isn't a skill folder and is ignored.
- **MCP server:** `smd`, declared inline in `plugin.json` as `node ${CLAUDE_PLUGIN_ROOT}/skills/semantic-markdown-reader/scripts/smd.cjs mcp`. There is no root `.mcp.json`, so working on this repository doesn't start the server.
- **Version:** `plugin.json`'s `version` pins what users get, so they update only when a release changes it. `bump-version.mjs` sets it with the other manifests, and `check-versions.mjs` fails a tag whose `plugin.json` doesn't match.

Users install from the default branch (`main`), which changes only when a release is merged, so a release reaches plugin users when its release branch is merged into `main`.

Check the manifests after changing them (Claude Code 2.1 or later):

```bash
claude plugin validate .                           # the marketplace and the plugin
claude --plugin-dir . plugin details semantic-markdown   # skills, MCP server, always-on token cost
```

To list the plugin in Anthropic's plugin directory as well, submit it as described in the [Claude Code plugin docs](https://code.claude.com/docs/en/plugins/publish.md).

## Official MCP Registry

`server.json` at the repository root describes the MCP server for the [MCP Registry](https://registry.modelcontextprotocol.io) as the npm package `semantic-markdown`, run as `npx semantic-markdown mcp`. The registry checks that the npm package belongs to the server by the `mcpName` in `npm/package.json` (`io.github.bislink360/semantic-markdown`), so publish to the registry only **after** that version of the package is on npm. `bump-version.mjs` keeps `server.json`'s versions in step.

Once per machine, install the publisher:

```bash
brew install mcp-publisher
# or, on macOS and Linux:
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

On Windows (PowerShell), then move `mcp-publisher.exe` to a folder on your `PATH`:

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
```

For each release, from the repository root on the tagged commit:

```bash
npm view semantic-markdown@3.0.0 mcpName     # must print io.github.bislink360/semantic-markdown
mcp-publisher login github                 # a GitHub account that is a member of the bislink360 organization
mcp-publisher publish                      # reads ./server.json
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.bislink360/semantic-markdown"
```

The `io.github.bislink360/` namespace is granted to members of the `bislink360` GitHub organization; if `publish` refuses the name, make your membership of the organization public and log in again.

**Before the first publish:** registry clients run the server as `npx semantic-markdown mcp`, which needs the package's `semantic-markdown` command (npm runs the command named like the package when there are several). Check that `npx -y semantic-markdown@3.0.0 mcp` starts the server: it waits for input on stdin; stop it with Ctrl+C.

## The 3.0 rename (one time)

Styled Markdown became Semantic Markdown in 3.0. Everything in the repository uses the new names; these steps happen outside it, in this order.

1. **Before tagging v3.0.0: rename the repository** on GitHub (Settings → General → Repository name) from `styled-markdown` to `semantic-markdown`. GitHub redirects the old URL, clones and `uses:` lines. Don't create a new repository under the old name later, or the redirect stops. Then turn GitHub Pages back on if it is off, because the site moves to `bislink360.github.io/semantic-markdown`.
2. **Tokens for the new names.** `VSCE_PAT` and `OVSX_PAT` already cover the new extension (same `bislink360` publisher). `NPM_TOKEN` must be allowed to publish `semantic-markdown` (for the first publish a token for all packages, narrowed to `semantic-markdown` and `styled-markdown` afterwards). `PYPI_TOKEN` must be account-wide for the first upload of `mkdocs-semantic-markdown`, then scoped to it and `mkdocs-styled-markdown`. `JETBRAINS_TOKEN` is unchanged: the plugin keeps its ID (35420).
3. **Tag v3.0.0** as usual. The Release workflow publishes the new names.
4. **Run Actions → Release (old names)** with the tag, first as a dry run, then with dry run unticked. It publishes `bislink360.styled-markdown` 3.0.0 (a stub that installs `bislink360.semantic-markdown`), `styled-markdown@3.0.0` on npm and `mkdocs-styled-markdown==3.0.0` on PyPI. It runs once per tag. The old names get no release after 3.0.0.
5. **Mark the old names deprecated:**
   - npm: `npm deprecate styled-markdown "Renamed to semantic-markdown: npm install semantic-markdown"`
   - VS Code Marketplace: ask the Marketplace team to list `bislink360.styled-markdown` as deprecated in favour of `bislink360.semantic-markdown`, so VS Code shows the replacement. Check their current process first: it has changed over time.
   - MCP Registry: publish `server.json` as in [Official MCP Registry](#official-mcp-registry) for `io.github.bislink360/semantic-markdown`. Then mark the old `io.github.bislink360/styled-markdown` entry deprecated, if the registry and `mcp-publisher` offer it by then.
6. **JetBrains Marketplace and Obsidian:** only the display name changes. Rename the plugin page's title on plugins.jetbrains.com if it doesn't follow the uploaded `plugin.xml`.
