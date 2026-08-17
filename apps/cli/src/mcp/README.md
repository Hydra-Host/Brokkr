# Brokkr MCP Server

Exposes the Brokkr API as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server, making all infrastructure operations available to AI assistants such as Claude.

## Prerequisites

- Node.js >= 18
- pnpm
- Monorepo dependencies installed (`pnpm install` from repo root)
- A Brokkr API key or an active CLI session (see [Authentication](#authentication))

## Quick Start

### 1. Authenticate

The MCP server shares auth state with the CLI. The simplest approach for MCP use is an API key:

```bash
# Option A: environment variable (no config needed)
export BROKKR_API_KEY=brk_...

# Option B: log in via CLI (session persists on disk)
pnpm --filter @repo/cli dev -- login
pnpm --filter @repo/cli dev -- org select   # if you belong to multiple orgs
```

### 2. Set the environment (if not production)

```bash
pnpm --filter @repo/cli dev -- env use brokkr   # production
pnpm --filter @repo/cli dev -- env use local     # local dev (http://localhost:3000)
```

### 3. Start the server

```bash
# Dev mode (tsx, no build needed)
pnpm --filter @repo/cli dev:mcp

# Or after building
pnpm --filter @repo/cli build
node apps/cli/dist/mcp/index.js
```

The server communicates over **stdio** (MCP standard transport) — no port is opened.

---

## Connecting to Claude Code

Register the MCP server globally (works in all projects):

```bash
claude mcp add --scope user brokkr -- npx tsx /path/to/brokkr-app/apps/cli/src/mcp/index.ts
```

Verify it registered:

```bash
claude mcp list
```

The server uses your existing CLI auth state. To use an API key instead, set `BROKKR_API_KEY` in your shell before running Claude Code.

---

## Authentication

Credentials are resolved in this order:

| Priority | Source                   | How to set                                       |
| -------- | ------------------------ | ------------------------------------------------ |
| 1        | `BROKKR_API_KEY` env var | Set in shell or MCP client config                |
| 2        | Session file API key     | `brokkr login --api-key brk_...`                 |
| 3        | Session file cookie      | `brokkr login` (email/password)                  |
| 4        | Config file API key      | Add `"apiKey"` to `~/.config/brokkr/config.json` |

For MCP use, **`BROKKR_API_KEY` is recommended** — it requires no login flow and survives server restarts.

---

## Troubleshooting

**`Not authenticated` error**
The server cannot find credentials. Set `BROKKR_API_KEY` in the MCP client config, or run `brokkr login` in a terminal first.

**`No organization selected` error**
A cookie session requires an active org. Run `brokkr org select` in a terminal, or switch to API key auth (API keys carry org context automatically).

**Wrong environment (hitting wrong API URL)**
Run `brokkr env use <name>` to switch, or set `BROKKR_API_KEY` with an API key scoped to the correct environment.

**Server not appearing in Claude**
Verify the `command`/`args` path is absolute. Relative paths are not resolved correctly by MCP clients.
