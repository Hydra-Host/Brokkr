# @hydrahost/plugin-webvm-terminal

A browser Linux terminal for BOSS, powered by [WebVM](https://webvm.io) / [CheerpX](https://cheerpx.io). Adds a **Linux Terminal** entry to the app sidebar that boots a full Debian VM entirely in the browser, in a popup window. The VM ships with a `brokkr` shell command that runs the Brokkr CLI in the browser and bridges its API calls to the host, using the session of the logged-in user.

## Why a popup window

CheerpX needs `SharedArrayBuffer`, which browsers only expose to **cross-origin-isolated** documents (served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy`). Applying those headers app-wide breaks third-party payment iframes (e.g. Stripe Elements), so the host serves a dedicated `/webvm-terminal` document — the _only_ path carrying COOP/COEP — and the sidebar entry opens it in a popup window (its own top-level browsing context group, so isolation there never affects the main app). Clicking the sidebar entry again focuses the already-running window instead of reloading it, which would destroy the booted VM.

## What the plugin contains

- `frontend/index.ts` — the sidebar-nav contribution (`popup: true`).
- `frontend/terminal.ts` — the `TerminalWindow` component the host's `/webvm-terminal` document renders. Kept on a separate subpath so the main app bundle never pulls the terminal engine.
- `frontend/use-linux-vm.ts` — the CheerpX bootstrap: loads the CheerpX runtime from `cxrtnc.leaningtech.com`, streams a Debian disk image from `disks.webvm.io` (persisted locally in IndexedDB as an overlay), wires an xterm.js terminal, and installs the `brokkr` command bridge.
- `plugin.ts` — frontend-only backend manifest (no NestJS module, no contract, no database schema); exists so the plugin participates in the enabled-plugins registry.

## Host requirements

The host must serve a cross-origin-isolated document at the path the sidebar entry points to (`/webvm-terminal`) that renders `TerminalWindow`, and its CSP must allow `https://cxrtnc.leaningtech.com` (script/connect), `wss://disks.webvm.io` (connect), `'wasm-unsafe-eval'`, and `worker-src blob:`. See `apps/web/webvm-terminal.html`, the `webvmTerminalHeaders` Vite plugin, and the matching middleware in `apps/api/src/main.ts`.

## Configuration

| Env var                  | Required | Description                                                                                                            |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `WEBVM_TERMINAL_ENABLED` | no       | Set to `false` to disable the plugin (hides the sidebar entry). Any other value — including unset — leaves it enabled. |

The plugin takes no other settings and needs no secrets — it is frontend-only.

Manual testing steps live in [`TESTING.md`](./TESTING.md).

## Privacy / network

The terminal document loads the CheerpX runtime from Leaning Technologies' CDN and streams the disk image from `disks.webvm.io` at boot. Nothing else leaves the browser; `brokkr` CLI API calls go to the host's own API with the user's session.
