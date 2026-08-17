# Brokkr CLI

Command-line interface for managing Brokkr infrastructure. Ships as an npm package with two binaries — `brokkr` (the CLI) and `brokkr-mcp` (an MCP server for AI agents) — and also builds to an ES module that runs inside the web app's embedded browser terminal.

This README is for contributors working in the monorepo. End-user documentation lives in [`README.npm.md`](./README.npm.md) and is published to npmjs.com.

## Ways of working

| Mode                    | How you invoke it                                                              | What it's for                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **One-shot CLI**        | `brokkr <cmd> [flags]`, typically with `--json`                                | The primary, scripting-friendly mode. Used by humans, CI, and agents.                                                                  |
| **Interactive prompts** | Any input command with missing values (`brokkr login`, `brokkr org invite`, …) | `@clack/prompts`-backed TTY prompts fill in missing arguments. The same commands run headlessly when you pass all values as flags.     |
| **Interactive TUI**     | `brokkr` with no arguments                                                     | Ink/React read-only navigation of deployments, devices, zones, etc. Data visualization only — all writes go through one-shot commands. |
| **MCP server**          | `brokkr-mcp` over stdio                                                        | Exposes Brokkr operations as tools for Claude Code and other MCP clients.                                                              |
| **Browser / WebVM**     | `dist/brokkr-browser.mjs`, via `@repo/cli/browser`                             | ESM bundle the web app loads into an in-browser terminal. Runs in bridge mode using the user's Brokkr session cookie.                  |

The [`LLM_CLI_REFERENCE.md`](./LLM_CLI_REFERENCE.md) in this directory is the authoritative command reference with every flag and JSON schema. `brokkr docs` prints it from any installed build.

## Prerequisites

- Node.js >= 18
- pnpm
- The monorepo dependencies installed (`pnpm install` from the repo root)
- A running API server (local or remote) to authenticate against

## Local development

From the monorepo root:

```bash
# Run the CLI in dev mode
pnpm --filter @repo/cli dev -- <command> [args] [flags]

# Launch the interactive TUI
pnpm --filter @repo/cli dev

# Run the MCP server in dev mode (stdio transport)
pnpm --filter @repo/cli dev:mcp

# Type-check without emitting
pnpm --filter @repo/cli typecheck

# Examples
pnpm --filter @repo/cli dev -- login
pnpm --filter @repo/cli dev -- whoami
pnpm --filter @repo/cli dev -- deployments --json
```

## Building

```bash
# TypeScript compile (dist/) + browser bundle
pnpm --filter @repo/cli build

# Browser bundle only — outputs dist/brokkr-browser.mjs
pnpm --filter @repo/cli build:browser

# Full npm release build — outputs npm-package/ with both binaries and a generated package.json
pnpm --filter @repo/cli build:npm
```

After `build`, run directly:

```bash
node apps/cli/dist/index.js <command>
node apps/cli/dist/mcp/index.js    # MCP server
```

### Installing a local build as if it were from npm

When you want to test the exact path end users hit on `npm install -g`:

```bash
# Wipe any prior install and local config
npm uninstall -g @hydrahost/brokkr-cli
rm -rf ~/.config/brokkr

# Build, pack, and install globally from the tarball
cd apps/cli
pnpm build:npm
cd npm-package
npm pack
npm install -g ./hydrahost-brokkr-cli-0.0.1.tgz
```

This flow mirrors a real npm install — it runs `postinstall.mjs`, drops both `brokkr` and `brokkr-mcp` on your PATH, and sets `BROKKR_DEFAULT_ENV=brokkr` (baked in by `build-node.mjs`), so the default environment points at production. Shell tab-completion is installed automatically unless you set `BROKKR_SKIP_POSTINSTALL=1`.

### Publishing

```bash
pnpm --filter @repo/cli publish:npm:dry   # dry run
pnpm --filter @repo/cli publish:npm       # publish to npmjs.com
```

Both scripts re-run `build:npm` before publishing. Versioning is done manually in `package.json` (source) — `publish-prepare.mjs` copies it into the generated `npm-package/package.json`.

## Authentication

Switch environments first if needed:

```bash
brokkr env use local       # local dev (http://localhost:3000)
brokkr env use brokkr      # production (https://brokkr.hydrahost.com)
```

Then authenticate with one of:

```bash
# Email/password (interactive prompts, with 2FA if enabled)
brokkr login
brokkr org select          # pick org (skipped if only one)

# API key (one-shot)
brokkr login --api-key brk_...

# API key (prompt for the key)
brokkr login -k

# API key (environment variable, no login needed)
BROKKR_API_KEY=brk_... brokkr deployments --json
```

Verify with `brokkr whoami`.

### Auth resolution order

When making API requests, the CLI resolves credentials in this order:

1. `BROKKR_API_KEY` environment variable
2. Session file API key (`session-{env}.json`)
3. Session file cookie (`session-{env}.json`)
4. Config file API key (`config.json` environment entry)

## Environments

| Name     | API URL                             | Notes                                                                                                                                                                                               |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`  | `http://localhost:3000`             | Default when running the CLI from the monorepo.                                                                                                                                                     |
| `brokkr` | `https://brokkr.hydrahost.com`      | Default when installed from npm (`BROKKR_DEFAULT_ENV=brokkr`).                                                                                                                                      |
| `vm`     | _(bridge mode — no direct API URL)_ | Auto-selected inside the browser bundle. Auth flows through the browser's Brokkr session cookie rather than disk files. Toggled by `BROKKR_BRIDGE=1`, which `build-browser.mjs` sets at build time. |

## Configuration files

All config lives in `~/.config/brokkr/` (directory `0700`, files `0600`):

| File                 | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `config.json`        | Environments, active env, persistent API keys       |
| `session-{env}.json` | Auth session (cookie or API key) for an environment |
| `org-{env}.json`     | Active organization for an environment              |

Session and org files are scoped per-environment and cleared by `brokkr logout`.

### `config.json`

```json
{
  "activeEnv": "brokkr",
  "environments": {
    "local": { "apiUrl": "http://localhost:3000" },
    "brokkr": {
      "apiUrl": "https://brokkr.hydrahost.com",
      "apiKey": "brk_yourKeyHere"
    }
  }
}
```

| Field       | Type   | Description                                                               |
| ----------- | ------ | ------------------------------------------------------------------------- |
| `activeEnv` | string | Currently selected environment name                                       |
| `apiUrl`    | string | Base URL for the API server                                               |
| `apiKey`    | string | (Optional) API key for this environment. Persists across `brokkr logout`. |

`brokkr login --api-key` saves to the session file only (cleared by logout). To persist an API key across logouts, add it to `config.json` manually.

### Relevant environment variables

| Variable                  | Effect                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `BROKKR_API_KEY`          | Use this key for all requests; bypasses session and config files.                      |
| `BROKKR_DEFAULT_ENV`      | Sets the default active environment on first run (baked to `brokkr` for npm installs). |
| `BROKKR_BRIDGE`           | `1` puts the CLI in bridge mode (browser bundle).                                      |
| `BROKKR_SKIP_POSTINSTALL` | `1` disables the npm-install auto-completion step.                                     |

## MCP server

`brokkr-mcp` is a Model Context Protocol server exposing deployments, DC management, organization, inventory, and account operations as tools. It ships in the same package as `brokkr` — installing the CLI installs the MCP server too.

Local dev:

```bash
pnpm --filter @repo/cli dev:mcp
```

Register with Claude Code (works once `brokkr-mcp` is on PATH — either via `npm install -g` or the local tarball flow above):

```bash
# Global — available in every project
claude mcp add --scope user brokkr -- brokkr-mcp

# Project-scoped
claude mcp add --scope project brokkr -- brokkr-mcp

claude mcp list
```

The MCP server shares auth state with the CLI. Either run `brokkr login` first, or set `BROKKR_API_KEY` in the shell or MCP client config. API-key auth is recommended — it needs no login flow and survives restarts.

Tool registrations live in `src/mcp/tools/` (`deployments.ts`, `dcim.ts`, `org.ts`, `inventory.ts`, `account.ts`) and are wired up in `src/mcp/index.ts`.

## Browser / WebVM bundle

`build:browser` produces `dist/brokkr-browser.mjs`, a single ESM bundle with every Node.js builtin replaced by browser shims (`src/shims/`). The web app loads it via the `@repo/cli/browser` subpath export and drives it through `runBrokkrCommand` in `src/browser-entry.ts`, which proxies stdout/stderr/stdin to an xterm terminal.

The browser bundle hard-sets `BROKKR_BRIDGE=1`, so it always runs in bridge mode: auth comes from the browser's Better Auth session cookie, and the bridge transport forwards API calls as `fetch()` requests instead of going through the Node-only child-process bridge.

The in-browser terminal is gated in production by a per-org feature flag — end users need the flag enabled on their org before the web terminal surfaces in the UI.

## Commands

The full reference with every flag and JSON schema lives in [`LLM_CLI_REFERENCE.md`](./LLM_CLI_REFERENCE.md) (also available at runtime via `brokkr docs`). Summary of the top-level groups:

| Group                        | Key commands                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth                         | `login`, `logout`, `whoami`                                                                                                                                                                                                                      |
| Environments                 | `env list`, `env use <name>`                                                                                                                                                                                                                     |
| Organizations                | `org select`, `org current`, `org members`, `org invitations`, `org api-keys`, `org webhooks`, `org billing`, `org settings`, plus `org invite`, `org create-api-key`, `org create-webhook`, `org update-settings`, `org set-default-payment`, … |
| Account                      | `account profile`, `account ssh-keys` (and their mutation subcommands)                                                                                                                                                                           |
| Deployments                  | `deployments` (list/detail), `deployments:power`, `deployments:rescue`, `deployments:lock`, `deployments:rename`, `deployments:deprovision`, `deployments:reprovision`, `deployments:create-project`, `deployments:delete-project`               |
| DC management (`dcim` group) | `dcim datacenters`, `dcim devices`, `dcim decommissioned-devices`, `dcim bridges`, `dcim bridge-requests`, plus device mutations `dcim devices:provision`, `dcim devices:decommission`, `dcim devices:settings`, `dcim devices:listing`          |
| Inventory                    | `inventory`, `inventory:rent`                                                                                                                                                                                                                    |
| Docs                         | `docs` (prints the full LLM reference)                                                                                                                                                                                                           |
| Completion                   | `completion install`, `completion uninstall`, `completion script`                                                                                                                                                                                |

Every list command accepts `--json`, `--page`, `--page-size`, `--sort`, `--search`, plus any command-specific `--filter-*` flags. Every detail command accepts `--json`.

## Project structure

```
src/
  index.ts              Entry point — routes to TUI when no args, otherwise CLI
  program.ts            Commander program; help text adapts to bridge vs. local mode
  browser-entry.ts      Browser bundle entry point (exports runBrokkrCommand)
  commands/             One-shot CLI commands (auth, env, dcim, deployments, org, account, inventory, docs, completion)
  completion/           Shell completion scripts (bash/zsh/fish) + install logic + walk-tree candidate generator
  config/               Environment and session config (env.ts, store.ts)
  core/                 API client, data fetchers, shared logic
  mcp/                  MCP server entry + tool registrations
  tui/                  Interactive TUI (Ink/React) — screens, components (including error-view.tsx), router, hooks
  ui/                   CLI output helpers (tables, spinners, formatters)
  shims/                Browser shims for Node.js builtins (consumed by build-browser.mjs)

build-browser.mjs       esbuild config for the browser bundle
build-node.mjs          esbuild config for the two Node binaries
publish-prepare.mjs     Generates npm-package/package.json for publication
postinstall.mjs         npm postinstall — auto-installs tab completion
```

## Further reading

- [`LLM_CLI_REFERENCE.md`](./LLM_CLI_REFERENCE.md) — full command reference and JSON output schemas.
- [`CLAUDE.md`](./CLAUDE.md) — coding rules and conventions for this package.
- [`README.npm.md`](./README.npm.md) — the end-user README published with the npm package.
