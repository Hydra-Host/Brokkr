# local-lab-web — the control-center web cockpit

The Vite + React SPA for the **local-dev control center** — the cockpit that drives the local devenv stack and the simulated fleet (`apps/local-sim`): power/console the VMs, run the lifecycle tests, review results, inspect status, and trigger stack ops. It talks to the control-center API (`apps/local-lab`, the `lab` process) over a typed ts-rest client. Like the rest of `apps/local-*`, it is **local dev tooling, not shipped product** — it comes up alongside the stack under `task up` (the `lab-web` devenv process), not separately.

> This is the UI. For the API it calls see `../local-lab/README.md`; for the engine see `../local-sim/README.md`. For the full bring-up see the repo-root `README.md` / `CLAUDE.md`.

## Running it

Normally `task up` starts it as the `lab-web` devenv process. To run it standalone (against a running `lab` API):

```bash
pnpm --filter local-lab-web dev    # vite
```

- **Default port**: `5175` (override `LAB_WEB_PORT`, or `PORT`; the devenv stack sets it from `modules/ports.nix`). `strictPort` is on — it won't silently drift to the next free port.
- **Bind host**: loopback (`127.0.0.1`) by default — set `HOST=0.0.0.0` to expose. It deliberately never defaults to all-interfaces, because the proxied `/api` control surface is destructive (see below).

## Routes

Fourteen routes, grouped the way the nav rail groups them (`SECTIONS` in `src/components/app-sidebar.tsx` is the authority):

| Group           | Route              | What it does                                                            |
| --------------- | ------------------ | ----------------------------------------------------------------------- |
| **Environment** | `/`                | Overview — bring-up pipeline, init progress, stacks, fleet, recent runs |
|                 | `/stack`           | Process supervision, stack ops, seed, live logs                         |
|                 | `/datastore`       | Postgres, Redis, Thanos and BullMQ queue explorers (tab in the URL)     |
|                 | `/hub`             | Read-only hub views: lifecycle jobs, webhooks, device tokens            |
|                 | `/storage`         | Artifacts the spoke serves, with verify / resync / wipe                 |
|                 | `/fleet`           | Per-VM power, serial console, topology                                  |
| **Testing**     | `/testing`         | Pick a scenario and launch a run                                        |
|                 | `/results`         | Finished runs: step tree, timings, attachments                          |
| **Config**      | `/settings`        | Stack settings, Fleet Builder, layers, this checkout's slot             |
|                 | `/docs`            | The lab API reference                                                   |
|                 | `/audit`           | Every mutation performed and every one refused                          |
| **Wiki**        | `/getting-started` | The self-hosting guide                                                  |
|                 | `/wiki`            | The glossary index                                                      |
|                 | `/wiki/$slug`      | A single wiki entry                                                     |

The wiki is also where the two guided tours live — an orientation deck and an operations deck. Decks are defined in `src/lib/tour-steps.ts`; a step targets a `data-tour` anchor, and a step that names a tab carries it in `search`.

## How it talks to the API

Vite proxies `/api` (including the `/api/fleet/shell` WebSocket for interactive VM consoles) to the lab API:

- Target defaults to `http://127.0.0.1:${LAB_PORT:-3002}` (override via `LOCAL_BROKKR_API_PROXY_TARGET`).
- It uses `127.0.0.1`, not `localhost`: the lab API binds IPv4 loopback by default, so a `localhost` target that resolved to `::1` first would miss it and drop all `/api` + WS traffic.

## Environment

| Env var                         | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `LAB_WEB_PORT` / `PORT`         | Dev-server port (default `5175`; `LAB_WEB_PORT` wins).       |
| `HOST`                          | Bind address (default `127.0.0.1`; set `0.0.0.0` to expose). |
| `LAB_PORT`                      | Proxy target port for `/api` (default `3002`).               |
| `LOCAL_BROKKR_API_PROXY_TARGET` | Full `/api` proxy target override.                           |

## Security posture

The cockpit is loopback-bound by default for a reason: every `/api` call it proxies hits the lab API's **destructive, privileged surfaces** (stack nuke, raw SQL, root SSH-exec, root fleet ops). The lab API trusts loopback connections without a token (see `../local-lab/README.md`), so exposing this dev server off-loopback effectively exposes that control surface. Keep both on **loopback / a trusted network**.
