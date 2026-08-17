# Brokkr CLI — Architecture

High-level map of how the CLI works: where it runs, how it talks to the API, how it authenticates, and how it plugs into AI tools via MCP.

## TL;DR

One codebase, three runtimes:

1. **Local Node** — you type `brokkr` in your terminal.
2. **Browser** — the same CLI, bundled as ESM, running in the web app's JS context and driven by an embedded CheerpX Linux terminal.
3. **MCP server** — same tools, exposed to AI assistants (Claude, Cursor) over stdio.

All three share the **same commands, same ts-rest contract, same auth rules**. Only the transport and the entry point change.

---

## 1. Top-level shape

```
 ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
 │  Local CLI   │          │  Browser CLI │          │  MCP Server  │
 │  (Node.js)   │          │ (ESM bundle  │          │  (stdio)     │
 │ index.ts     │          │  in browser) │          │ mcp/index.ts │
 │              │          │ browser-     │          │              │
 │              │          │  entry.ts    │          │              │
 └──────┬───────┘          └──────┬───────┘          └──────┬───────┘
        │                         │                         │
        │       ┌─────────────────┴─────────────┐           │
        └──────►│  commands/  •  tui/  •  mcp/  │◄──────────┘
                │   (presentation layer)        │
                └──────────────┬────────────────┘
                               │ calls domain fn(client, params)
                               ▼
                ┌──────────────────────────────┐
                │  core/<domain>/*.ts          │   pure async functions
                │  (pure fetchers, no state)   │   that take a CliApiClient
                └──────────────┬───────────────┘
                               │ uses
                               ▼
                ┌──────────────────────────────┐
                │  core/client.ts              │   getAuthenticatedClient()
                │  (ts-rest client factory +   │   resolves auth, picks
                │   auth resolution)           │   transport, returns client
                └──────────────┬───────────────┘
                               │
                ┌──────────────┴───────────────┐
                │                              │
                ▼                              ▼
       HTTP transport                  Bridge transport
       (tsRestFetchApi)                (core/bridge-transport*.ts)
                │                              │
                │ fetch()                      │ stdin/stdout markers
                │                              │  OR browser fetch()
                ▼                              ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │                       Brokkr API  (apps/api, NestJS)                      │
 │                      ts-rest contract @ /api/v1/*                         │
 └───────────────────────────────────────────────────────────────────────────┘
```

The three entry points differ only in **what renders the output** (Commander + chalk, Ink/React, or MCP JSON). Below that line, everything is shared: presentation calls `core/<domain>` fetchers, which call the ts-rest client, which is built by the auth+transport layer.

---

## 2. Entry points and modes

| Mode            | File                              | Renderer                    | When                             |
| --------------- | --------------------------------- | --------------------------- | -------------------------------- |
| Interactive TUI | `src/index.ts` → `tui/launch.tsx` | Ink `render()` (persistent) | `brokkr` with no args            |
| One-shot CLI    | `src/index.ts` → `program.ts`     | `renderOnce()` (static)     | `brokkr <command> [flags]`       |
| Browser         | `src/browser-entry.ts`            | Same as above, with shims   | Web app embedded terminal        |
| MCP server      | `src/mcp/index.ts`                | None (returns JSON)         | Claude / Cursor / any MCP client |

**TUI = navigation + visualization only.** All writes (create, update, delete, login) happen in CLI commands. This split is enforced by convention (see `apps/cli/CLAUDE.md` rules #3, #10).

---

## 3. Directory layout

```
apps/cli/src/
├── index.ts              Entry — dispatches to TUI or CLI
├── program.ts            Commander setup, registers all commands
├── browser-entry.ts      Browser bundle entry (runBrokkrCommand)
│
├── commands/             One-shot commands (auth, env, org, dcim, deployments, …)
├── tui/                  Ink/React screens for the interactive UI
├── ui/                   Output helpers (tables, spinners, JSON, chalk)
│
├── core/                 Business logic shared by CLI, TUI, and MCP
│   ├── client.ts         ts-rest client factory + auth resolution
│   ├── auth.ts           Login/session via raw fetch (pre-client)
│   ├── bridge-transport.ts     Node → browser bridge (stdout/stdin markers)
│   ├── bridge-transport.browser.ts  Browser-side counterpart
│   ├── fetch.ts          Low-level fetch wrapper
│   └── <domain>/         Pure data fetchers (take CliApiClient)
│
├── config/               Local state
│   ├── env.ts            ~/.config/brokkr/config.json (environments, active env)
│   └── store.ts          ~/.config/brokkr/session-{env}.json, org-{env}.json
│
├── mcp/                  MCP server
│   ├── index.ts          Stdio transport, registers tool groups
│   └── tools/            One file per domain, wraps core/* fetchers
│
└── shims/                Browser replacements for Node builtins (fs, os, tty, …)
```

**Key rule:** domain fetchers (`core/<domain>/*.ts`) never touch config or session state directly — they only accept a `CliApiClient` and return typed data. Config/session lookup lives in one place: `core/client.ts` (and `core/fetch.ts` for pre-client auth). This is what lets the MCP server, the browser bundle, and the Node CLI all reuse the same domain fetchers.

---

## 4. API client & auth resolution

All API calls go through a single **ts-rest** client built from the shared `@repo/api-client` contract. The same contract powers `apps/web`, `apps/web-admin`, and the CLI — one source of truth, full end-to-end types.

### The intermediation pipeline

This is where **auth** and **bridge transport** plug in. Commands/TUI/MCP never touch config, session files, or fetch directly — they call `getAuthenticatedClient()`, get back a ready-to-use ts-rest client, and hand it to a core fetcher.

```
  commands/<cmd>.ts        tui/screens/<screen>.tsx       mcp/tools/<tool>.ts
         │                          │                             │
         │ getAuthenticatedClient() │                             │ getAuthenticatedMcpClient()
         └──────────┬───────────────┘                             │  (cache-invalidates first,
                    │                                             │   throws instead of exit)
                    ▼                                             ▼
          ┌────────────────────────────────────────────────────────────────┐
          │               core/client.ts  —  auth resolution               │
          │                                                                │
          │   if getConnectionMode() === 'bridge'                          │
          │     → createBridgeClient()      (no auth headers; browser has  │
          │                                  the cookies)                  │
          │                                                                │
          │   else (HTTP mode), resolve auth in order:                     │
          │     1. process.env.BROKKR_API_KEY         → x-api-key header   │
          │     2. session-{env}.json .apiKey         → x-api-key header   │
          │     3. session-{env}.json .cookie         → cookie header      │
          │        (requireActiveOrg() — cookies need an active org)       │
          │     4. config.json env.apiKey             → x-api-key header   │
          │     else: throw "Not logged in. Run: brokkr login"             │
          │                                                                │
          │   → createCliClient(baseUrl, auth)                             │
          └──────────────────────────┬─────────────────────────────────────┘
                                     │ returns initClient(contract, { ..., api })
                                     ▼
                    ┌────────────────────────────────┐
                    │        CliApiClient            │
                    │   (ts-rest, fully typed)       │
                    └────────────────┬───────────────┘
                                     │ passed into every core fetcher
                                     ▼
         core/deployments/deployments.ts      core/dcim/devices.ts
         core/org/members.ts                  core/account/profile.ts   …
         (pure async fns: (client, params) => typed response)
                                     │
                                     │ client.<route>({ query, body, params })
                                     ▼
          ┌────────────────────────────────────────────────────────────────┐
          │           Transport layer  (the `api` function in ts-rest)     │
          │                                                                │
          │  HTTP mode:   tsRestFetchApi  →  fetch(baseUrl + path, {...})  │
          │                                                                │
          │  Bridge mode: bridgeApiFetcher (two implementations)           │
          │     Browser bundle (the primary path): calls fetch(path,       │
          │       {credentials:'include'}) — esbuild swaps in              │
          │       bridge-transport.browser.ts; browser already has the     │
          │       session cookie, so nothing else is needed.               │
          │     Node marker protocol: write '\x00BROKKR_REQ:{...}\x00' to  │
          │       stdout, read '\x00BROKKR_RES:{...}\x00' from stdin; a    │
          │       host process (the web app) does the real fetch. Used by  │
          │       the `brokkr-api` bash helper inside the VM.              │
          │                                                                │
          │  On 401:                                                       │
          │     CLI client  → fail() → process.exit(1)                     │
          │     MCP  client → throw Error (don't kill the MCP server)      │
          └──────────────────────────┬─────────────────────────────────────┘
                                     ▼
                               Brokkr API
```

### Two auth paths, clearly separated

1. **Login (pre-client).** `core/auth.ts` — `login`, `verifyTotp`, `getSession`, `verifyApiKey`. These use **raw `fetch()`** because they must run _before_ an authenticated client can exist (you're obtaining the cookie/key the client would need). They hit `/api/v1/auth/*` and `/api/v1/organizations/active` directly, then hand the resulting session to `config/store.ts` for persistence.

2. **Everything else (post-client).** Every non-auth API call goes through the ts-rest client produced by `getAuthenticatedClient()`. Domain fetchers in `core/<domain>/*.ts` only know about the client — they have no idea whether the underlying transport is HTTP or the browser bridge, and they don't need to.

### Three clients, same shape

| Factory              | Transport               | Used by                      |
| -------------------- | ----------------------- | ---------------------------- |
| `createCliClient`    | `tsRestFetchApi` (HTTP) | Local Node CLI, local TUI    |
| `createMcpClient`    | `tsRestFetchApi` (HTTP) | MCP server (throws on 401)   |
| `createBridgeClient` | `bridgeApiFetcher`      | Browser bundle (bridge mode) |

All three produce a `CliApiClient` with the **same type and method surface**. Swapping transports is invisible to every caller above `core/client.ts`.

### Bridge transport has two source files

Both implement the same `bridgeApiFetcher(args)` signature. The Node source file is the one committed in `core/`; the browser build swaps it for the browser source file via an esbuild resolver plugin (`bridgeSwapPlugin` in `build-browser.mjs`).

- **`core/bridge-transport.browser.ts`** — primary path for the browser bundle. Calls `fetch(args.path, { credentials: 'include' })`. The browser already has the Better Auth session cookie from the web app, so the request just works.

- **`core/bridge-transport.ts`** — Node stdin/stdout marker protocol. Writes `\x00BROKKR_REQ:{...}\x00` to stdout and parses `\x00BROKKR_RES:{...}\x00` frames from stdin. Used by a host process (e.g. the web app's Linux VM integration) that reads CLI stdout, makes the real HTTP call on the CLI's behalf, and feeds the response back in. This is also the protocol behind the bash `brokkr-api` helper inside the CheerpX VM.

### Mode switching

`getConnectionMode()` picks the transport:

1. **`BROKKR_BRIDGE=1` environment variable wins** — set by `shims/globals.ts` in the browser bundle and by `.bashrc` inside the CheerpX VM, so bridge mode is auto-selected there regardless of config.
2. Otherwise, read `config.json → environments[activeEnv].connectionMode`. The default `vm` environment has `connectionMode: 'bridge'`; `local` and `brokkr` default to HTTP.

Switch with `brokkr env use <name>` — every subsequent `getAuthenticatedClient()` call picks up the new transport automatically.

---

## 5. Browser runtime (CheerpX terminal)

Important: the CLI **does not run inside the CheerpX Linux VM**. The VM is only the terminal UI. The CLI itself runs in the browser's JS context as an ESM bundle.

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Browser  (apps/web / web-admin)                                      │
 │                                                                      │
 │  ┌─────────────────────────────┐        ┌─────────────────────────┐  │
 │  │ CheerpX Linux VM            │        │ Web app JS context      │  │
 │  │ (xterm.js terminal UI)      │        │                         │  │
 │  │                             │        │  dist/brokkr-browser.mjs│  │
 │  │ $ brokkr deployments        │        │  (@repo/cli/browser)    │  │
 │  │     │                       │        │        ▲                │  │
 │  │     │ bash wrapper prints:  │        │        │ runBrokkrCommand│  │
 │  │     │ \x00BROKKR_CMD:       │   ①    │        │   (args, write) │  │
 │  │     │   {"args":[...]}\x00  ├────────┼────────┘                │  │
 │  │     ▼ (stdout marker)       │        │        │                │  │
 │  └──────────────┬──────────────┘        │        │ write(chunk)   │  │
 │                 │                       │        ▼                │  │
 │                 │  (keystrokes) ②       │   output streamed back  │  │
 │                 └───────────────────────┼──── to VM terminal ─────┤  │
 │                                         │                         │  │
 │                                         │ CLI calls fetch(path,   │  │
 │                                         │  {credentials:'include'})  │
 │                                         └───────────┬─────────────┘  │
 └─────────────────────────────────────────────────────┼────────────────┘
                                                       │ ③
                                                       ▼
                                        Brokkr API (same origin)
```

Flow:

1. **VM → browser (BROKKR_CMD).** The VM has a bash wrapper at `/brokkr/brokkr` that, when invoked, prints a null-delimited `BROKKR_CMD` marker containing the argv. `useLinuxVM` in `packages/ui/src/components/bottom-bar/` intercepts it and calls `runBrokkrCommand(args, write, opts)` — which executes the ESM-bundled CLI directly in the web app's JS context.
2. **Browser → VM (output).** Everything the CLI writes goes back to the VM terminal via the `write` callback.
3. **CLI → API.** Because `BROKKR_BRIDGE=1` is baked into the bundle, `getConnectionMode()` returns `'bridge'`, and `createBridgeClient()` is used. The esbuild swap resolves `bridgeApiFetcher` to `bridge-transport.browser.ts`, which calls `fetch()` with `credentials: 'include'` — the browser's existing Better Auth session cookie authenticates the request.

### The browser bundle

`build-browser.mjs` runs esbuild over `src/browser-entry.ts`:

- `platform: 'browser'`, ESM output → `dist/brokkr-browser.mjs`
- Node builtins (`fs`, `os`, `tty`, `readline`, `child_process`, …) aliased to shims in `src/shims/`
- `bridgeSwapPlugin` rewrites imports of `bridge-transport.js` to `bridge-transport.browser.ts`
- `process.env.BROKKR_BRIDGE = '1'` and `BROWSER_DOCS_CONTENT` (inlined markdown for `brokkr docs`) defined at build time
- `src/shims/globals.ts` injected to stub `globalThis.process`, `setImmediate`, `console.Console`, etc.

Output is exported as `@repo/cli/browser` (`package.json` exports map → `dist/brokkr-browser.mjs`).

### `runBrokkrCommand`

```ts
runBrokkrCommand(args: string[], write: (str: string) => void, opts?: { cols?: number; rows?: number })
  → { done: Promise<void>; sendInput: (data: string) => void; kill: () => void }
```

The web terminal feeds keystrokes through `sendInput`, consumes output via `write`, and can kill long-running commands (TUI or otherwise). Internally the bundle monkey-patches `process.stdout/stderr/stdin` and intercepts `process.exit` so errors don't kill the host page.

### The other bridge protocol (BROKKR_REQ)

In addition to `BROKKR_CMD` (run the whole CLI), the VM→browser protocol also supports `BROKKR_REQ` — a single request/response round-trip used by the `brokkr-api` bash helper inside the VM. This is the protocol the Node-side `core/bridge-transport.ts` implements. It is not used by the primary browser CLI flow (the browser bundle uses `bridge-transport.browser.ts`'s direct `fetch()` instead).

---

## 6. MCP server

```
 Claude / Cursor / Any MCP client
         │
         │  stdio (JSON-RPC)
         ▼
 ┌─────────────────────────────────────┐
 │  Brokkr MCP server                  │
 │  (apps/cli/src/mcp/index.ts)        │
 │                                     │
 │  Tools (one per domain):            │
 │   - deployments                     │
 │   - dcim                            │
 │   - org                             │
 │   - inventory                       │
 │   - account                         │
 │                                     │
 │  Each tool:                         │
 │    1. getAuthenticatedMcpClient()   │
 │    2. call core/<domain>/... fn     │
 │    3. return JSON                   │
 └──────────────┬──────────────────────┘
                │
                │ HTTP fetch
                ▼
         Brokkr API (/api/v1/*)
```

The MCP server uses `getAuthenticatedMcpClient()` — same resolution order as the CLI, but:

- Invalidates config/session caches on every call (external `brokkr login` / `org select` changes get picked up without restarting the MCP process).
- Throws instead of calling `process.exit` on 401 (killing the MCP server on auth failure would be bad).

MCP tools are **thin wrappers over `core/<domain>/*.ts` fetchers** — the same functions the CLI commands and TUI screens use. No duplicated logic.

---

## 7. Local config files

All state lives in `~/.config/brokkr/` (`0700` dir, `0600` files):

| File                 | Scope           | Contents                                             |
| -------------------- | --------------- | ---------------------------------------------------- |
| `config.json`        | global          | environments, active env, persistent API keys        |
| `session-{env}.json` | per environment | auth session (cookie or API key) — cleared by logout |
| `org-{env}.json`     | per environment | active organization for that environment             |

Per-environment scoping means you can be logged into `local` and `brokkr` at the same time without them stepping on each other.

---

## 8. What shares with what

| Piece                         | Shared with                                     |
| ----------------------------- | ----------------------------------------------- |
| ts-rest contract              | `apps/web`, `apps/web-admin`, `apps/api`, MCP   |
| Zod schemas                   | Same — types flow end-to-end                    |
| `core/<domain>/*.ts` fetchers | CLI commands, TUI screens, MCP tools            |
| Column/field definitions      | `core/dcim/columns.ts` — TUI + CLI output share |
| Auth resolution               | HTTP CLI and MCP (browser uses bridge)          |

If you wire an endpoint into the ts-rest contract, adding it to the CLI, TUI, and MCP is a matter of one fetcher function plus three thin wrappers.

---

## 9. For the manager

- **One CLI, three places it runs**: your laptop, the browser, and an AI assistant. Same code.
- **Full type safety**: the CLI talks to the API using the exact same contract the web apps use. If the API changes shape, the CLI fails to compile.
- **No duplication**: logic for "list deployments", "get device", etc. is written once and reused by the terminal UI, the scripted CLI commands, the in-browser terminal, and the AI-assistant integration.
- **No separate CLI backend**: the CLI is a client; the Brokkr API is the single source of truth. Everything you can do in the CLI you can do in the web app and vice versa.
- **AI integration is free**: because the CLI already exposes every operation as a typed function, wrapping them as MCP tools for Claude/Cursor is a one-file-per-domain exercise.
