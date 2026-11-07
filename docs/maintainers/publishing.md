# Publishing to agent registries

Maintainer notes for the listings that sit outside the tag-triggered Release workflow (which publishes the VS Code Marketplace, Open VSX, npm and the GitHub release). Users don't need this page; their side is in [guides/install.md](../guides/agent-setup.md#claude-code-plugin).

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

For each release, from the repository root on the tagged commit (`X.Y.Z` is the version being released):

```bash
npm view semantic-markdown@X.Y.Z mcpName     # must print io.github.bislink360/semantic-markdown
mcp-publisher login github                 # a GitHub account that is a member of the bislink360 organization
mcp-publisher publish                      # reads ./server.json
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.bislink360/semantic-markdown"
```

The `io.github.bislink360/` namespace is granted to members of the `bislink360` GitHub organization; if `publish` refuses the name, make your membership of the organization public and log in again.

**Before the first publish:** registry clients run the server as `npx semantic-markdown mcp`, which needs the package's `semantic-markdown` command (npm runs the command named like the package when there are several). Check that `npx -y semantic-markdown@X.Y.Z mcp` starts the server: it waits for input on stdin; stop it with Ctrl+C.
