# Brokkr CLI

Command-line interface and MCP server for managing [Hydrahost](https://brokkr.hydrahost.com) infrastructure — baremetal devices, deployments, bridges, reservations, organizations, and more.

## Install

```bash
npm install -g @hydrahost/brokkr-cli
```

This puts two executables on your PATH:

- `brokkr` — the CLI (interactive TUI and one-shot commands)
- `brokkr-mcp` — an [MCP](https://modelcontextprotocol.io) server for Claude Code and other AI assistants

The installer also auto-registers shell tab-completion for bash / zsh / fish. To opt out, install with `BROKKR_SKIP_POSTINSTALL=1 npm install -g @hydrahost/brokkr-cli` or run `brokkr completion uninstall` afterwards.

Requires Node.js >= 18. By default the CLI talks to the production Brokkr API at `https://brokkr.hydrahost.com`.

### Clean uninstall / reinstall

```bash
npm uninstall -g @hydrahost/brokkr-cli
rm -rf ~/.config/brokkr
```

## Quick start

```bash
# Log in (interactive — email, password, 2FA if enabled)
brokkr login

# Or authenticate via API key (headless / scripting)
export BROKKR_API_KEY=brk_...

# Launch the interactive TUI
brokkr

# One-shot commands
brokkr dcim devices --json
brokkr deployments --json --page 1 --page-size 50
brokkr dcim devices --sort hourlyPrice:desc --page-size 1  # most expensive device
brokkr --help
```

Switch environments with `brokkr env use <name>`. See the full command reference with `brokkr docs`.

## Ways of working

Brokkr supports four ways of working — use whichever fits the task.

- **One-shot commands with `--json` output** — the primary, scripting-friendly path. Most humans, CI jobs, and AI agents should use this. Every list command accepts `--json`, `--page`, `--page-size`, `--sort`, `--search`, and command-specific `--filter` flags.
- **Interactive prompts** — when you run a command like `brokkr login` or `brokkr org create-api-key` without all the required values, it prompts for the missing pieces. Pass every value as a flag and the same command runs headlessly with zero prompts.
- **Interactive TUI** — run `brokkr` with no arguments to browse deployments, devices, zones, members, and more in a keyboard-navigable terminal UI. The TUI is read-only — all writes go through one-shot commands.
- **MCP server** — `brokkr-mcp` speaks the Model Context Protocol over stdio, exposing Brokkr operations as tools for Claude Code and other agents. See [MCP server](#mcp-server-for-claude-code) below.

## Scripting

Every list and detail command supports `--json` for machine-readable output. Pipe into `jq`, `yq`, or any other tool:

```bash
brokkr dcim devices --json | jq '.data[] | select(.status == "Active")'
```

For the complete command reference including JSON output schemas, run `brokkr docs` — the full LLM-oriented reference is bundled with the binary.

## Tab completion

Completion is installed automatically when you `npm install -g @hydrahost/brokkr-cli`. To manage it manually:

```bash
brokkr completion install          # auto-detects your shell from $SHELL
brokkr completion install zsh      # or pick one explicitly (bash, zsh, fish)
brokkr completion uninstall
brokkr completion script zsh       # print the raw script for manual install
```

Restart your shell (or `source ~/.zshrc` / `source ~/.bashrc`) after installing.

## MCP server for Claude Code

Installing the CLI also installs the MCP server — they ship in the same package. Register `brokkr-mcp` to expose Brokkr operations as tools Claude can call directly.

**Global (all projects):**

```bash
claude mcp add --scope user brokkr -- brokkr-mcp
```

**Project-scoped:**

```bash
claude mcp add --scope project brokkr -- brokkr-mcp
```

Verify registration:

```bash
claude mcp list
```

The MCP server shares auth state with the CLI. Either run `brokkr login` first, or set `BROKKR_API_KEY` in your shell (or in the MCP client config) before starting Claude. API-key auth is recommended for MCP — it requires no login flow and survives restarts.

## Browser / in-app terminal

You can also use Brokkr directly from a terminal embedded in `brokkr.hydrahost.com` — no local install required. The browser terminal authenticates using your existing Brokkr login session; no `BROKKR_API_KEY` or config files needed.

The in-app terminal is gated by a per-org feature flag in production. If you don't see it, ask a workspace admin to enable it for your organization.

## Configuration

CLI state lives in `~/.config/brokkr/`:

- `config.json` — active environment and per-environment profiles
- `session-<env>.json` — auth session (cookie or API key) for each environment
- `org-<env>.json` — selected organization for each environment

Use `brokkr env list` to see available environments and `brokkr env use <name>` to switch. Default environments are `brokkr` (production) and `local` (your own API server on `http://localhost:3000`).

### Environment variables

| Variable                  | Effect                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `BROKKR_API_KEY`          | Use this API key for all requests; bypasses session and config files. Ideal for CI and MCP clients. |
| `BROKKR_SKIP_POSTINSTALL` | Set to `1` to skip the automatic tab-completion install during `npm install -g`.                    |

## License

[Apache-2.0](./LICENSE)
