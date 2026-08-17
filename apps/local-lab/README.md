# local-lab — the control-center API

The NestJS API behind the **local-dev control center** (the web cockpit is `apps/local-lab-web`). It drives the local devenv stack and the simulated fleet (`apps/local-sim`) over the process-compose REST API and direct sim-engine calls — fleet power/console, lifecycle test runs, status, builds, and stack ops (reconcile, nuke, raw SQL, root SSH-exec). It is **local dev tooling, not shipped product**: it comes up alongside the rest of the stack under `task up` and is not part of the customer-facing hub (`apps/api`).

> This is the API. For the engine it drives see `../local-sim/README.md`; for the cockpit UI see `../local-lab-web/README.md`. For the full bring-up DAG and devenv layout see the repo-root `README.md` / `CLAUDE.md`.

## Running it

Normally you don't start it by hand — `task up` brings it up as the `lab` devenv process. To run it standalone (against an already-running stack):

```bash
pnpm --filter local-lab dev    # nest start --watch
```

- **Default port**: `3002` (override `LAB_PORT`; the devenv stack sets it from `modules/ports.nix`).
- **Bind host**: loopback (`127.0.0.1`) by default — set `LAB_BIND_HOST=0.0.0.0` to expose (see security posture).
- **Docs** (when running): Swagger `…/api/swagger`, ReDoc `…/api/redoc`, OpenAPI JSON `…/api/swagger-json`.
- Interactive terminals (VM consoles, live test-run PTYs) ride WebSockets on the same server (`/api/fleet/shell`, `/api/tests/term`) — loopback-only, see security posture.

## Environment

The devenv stack injects most of these from `modules/ports.nix` and the hub/spoke wiring; the defaults below apply when running standalone. The ones that matter most:

| Env var                  | Purpose                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAB_PORT`               | API/WS listen port (default `3002`).                                                                                                                                          |
| `LAB_BIND_HOST`          | Bind address (default `127.0.0.1`; set `0.0.0.0` to expose).                                                                                                                  |
| `LAB_API_TOKEN`          | Bearer/`x-lab-token` required for non-loopback requests. Unset ⇒ fail-closed (off-loopback denied).                                                                           |
| `LAB_ALLOW_REMOTE_SHARP` | Set to exactly `1` to let non-loopback callers reach `loopback-only` routes and the WS terminals. Any other value denies.                                                     |
| `LAB_CORS_ORIGINS`       | Comma-separated CORS allowlist (defaults to the lab-web dev origins).                                                                                                         |
| `LAB_WEB_PORT` / `PORT`  | Used to derive the default CORS allowlist origin and the lab-web port mutations may originate from.                                                                           |
| `LAB_TRUST_PROXY`        | `1` ⇒ trust the lab-web proxy's `x-forwarded-for` (the devenv sets it).                                                                                                       |
| `LOCAL_BROKKR_ROOT`      | Sim engine root (defaults to `../sim`).                                                                                                                                       |
| `VRRP_SIM_STATE_DIR`     | Where the VRRP sim's `ip` shim writes per-bridge binding state (defaults to `$DEVENV_STATE/vrrp-sim`). Absent ⇒ VIP bind state is reported as unobservable, never as unbound. |
| `DEVENV_ROOT`            | Devenv root (defaults relative to the sim root).                                                                                                                              |
| `HUB_REPO_PATH`          | Hub checkout — required for build ops; surfaced in the env-override view.                                                                                                     |
| `LOCAL_STATE`            | State dir holding the run ledger (`lab/test-tracking.db`), per-run logs (`lab/runs/`) and `lab/lab.pid`.                                                                      |
| `LOCAL_BROKKR_ALLURE`    | Results root for the per-run captured log slices (`<runId>-results/`).                                                                                                        |

(Many more — `HUB_DATABASE_URL`, `BRIDGE_REDIS_URL`, `PC_API_TOKEN`/`PC_SOCKET_PATH`, port-map vars, etc. — are read for specific ops; see `src/ports.ts` and `src/services/`.)

### Run-history retention

The run ledger sweeps itself every 6h, and once at boot. Every knob below is optional; the defaults are what the lab runs with unless the stack overrides them.

| Env var                     | Default      | Purpose                                                                                        |
| --------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `LAB_RUNS_RETENTION`        | on           | Set to `off` to keep run history forever — nothing is swept, so the state dir grows unbounded. |
| `LAB_RUNS_KEEP_PER_SECTION` | `500`        | Terminal runs kept per section (stack/fleet/build/storage/test/queues), oldest evicted first.  |
| `LAB_RUNS_TTL_DAYS`         | `30`         | Age past which a terminal run is evicted even when the per-section cap is not reached.         |
| `LAB_RUNS_LOG_BUDGET_BYTES` | `2147483648` | Total run-log bytes allowed; the oldest terminal runs are evicted until the ledger fits.       |
| `LAB_RUN_LOG_MAX_BYTES`     | `8388608`    | Per-run log cap; output past it is dropped and the file carries a truncation marker.           |
| `LAB_AUDIT_KEEP`            | `5000`       | Non-denied audit events kept, newest first.                                                    |
| `LAB_AUDIT_DENIED_KEEP`     | `1000`       | Denied audit events kept, newest first — capped independently of `LAB_AUDIT_KEEP`.             |
| `LAB_AUDIT_TTL_DAYS`        | `90`         | Age past which an audit event is evicted.                                                      |

An eviction takes the run's row, its events, its `.log` file and (for a test run) its results dir. A **running** run is never evicted, whatever its age.

At boot the lab also reconciles runs the previous process left `running` — marking them failed and SIGTERMing the process group of any `test`/`fleet` orphan. Because that signals pids, it runs only behind an advisory `lab/lab.pid` lock on the state dir: `LAB_PORT` is per-instance but `LOCAL_STATE` is not, so a second lab sharing one state dir would otherwise kill the first one's live children. A lab that finds the lock held by a live pid logs an error and skips the reconcile (retention still runs — it signals nothing and only deletes terminal rows); a lock left by a dead pid is taken over. The lock is released on shutdown.

## Security posture (read this)

The lab API exposes **destructive, privileged surfaces** — stack nuke, raw SQL against the hub DB, root SSH-exec, loopback-only queue mutations against the live hub/spoke BullMQ queues (retry/remove/drain/clean, each minting a run), and fleet ops that need root (it installs/uses a scoped passwordless `sudo` NOPASSWD drop-in). Access control is **per-connection, independent of the bind host** (`src/common/lab-auth.ts`):

- **Loopback connections are trusted** (the operator on the box, incl. the lab-web Vite `/api` proxy).
- **Every other connection must present `LAB_API_TOKEN`**, compared in constant time — and is **denied when the token is unset (fail-closed)**, so binding off-loopback without a configured token exposes nothing. The same check guards the raw WebSocket upgrade (which bypasses Nest guards) — but passing it is not enough to reach a terminal, see below. The guard is wired as a global `APP_GUARD`.
- **Exposure is per-route, and a valid token is not sufficient for the root-equivalent ones.** A handler annotated `@LabRoute({ exposure: 'loopback-only' })` (`src/common/lab-route.ts`) is additionally checked by `assertExposure` (`src/common/lab-exposure.ts`) after the token gate grants: the socket peer **and every `x-forwarded-for` hop** must be loopback, or the request is `403`. That hop check does not consult `LAB_TRUST_PROXY` — a proxy-laundered LAN caller would otherwise pass whenever that flag is unset. Set `LAB_ALLOW_REMOTE_SHARP=1` to opt out; anything else denies. Un-annotated routes default to `token-ok`, so annotating only ever tightens.
- **Both WebSocket terminals are `loopback-only` unconditionally** — the serial console (`/api/fleet/shell`) and the test-run PTY (`/api/tests/term`) are interactive root-equivalent shells, so the upgrade handler runs the same `exposureAllowed` check after the token gate and destroys the socket on a remote attach. There is no per-terminal annotation; only `LAB_ALLOW_REMOTE_SHARP=1` opens them.
- **CORS is an explicit allowlist** (`LAB_CORS_ORIGINS` or the lab-web dev origins) — arbitrary `Origin`s are never reflected.
- **Mutating requests are content-type and origin gated** (`src/common/require-json-mutation.middleware.ts`, ahead of the body parser): `POST`/`PUT`/`PATCH`/`DELETE` that declare a non-JSON content type get `415`, and a foreign `Origin` gets `403` — loopback needs no token and CORS only hides the response, so this is what stops a drive-by page. Accepted origins: the `LAB_CORS_ORIGINS` allowlist, a loopback name (`localhost`/`127.0.0.1`/`::1`) on a lab port, and an origin naming the address the connection actually arrived on (LAN mode) — the request's `Host` header is caller-supplied and never consulted, so a LAN hostname origin needs the allowlist. An absent content type or `Origin` is left alone for curl/the CLI.

Keep it on **loopback / a trusted network**. Even with the token gate, treat exposing this API as exposing root on the dev box.

### Audit trail

Every mutating request is written to the `audit_events` table (`src/common/audit.interceptor.ts`), redacted, with the origin it came from. Three surfaces the interceptor structurally cannot see are covered separately:

- **Guard denials.** `LabAuthGuard` writes its own `denied` row before throwing, because guards run before interceptors — otherwise "someone tried to nuke the stack from a LAN address" would leave no trace at all. Safe-method (`GET`/`HEAD`/`OPTIONS`) denials are deliberately not recorded, so a probe cannot fill the table.
- **Middleware refusals.** The mutation guard (`src/common/require-json-mutation.middleware.ts`) answers 415/403 ahead of the router entirely, so it writes its own `denied` row under handler `requireJsonMutation`.
- **WebSocket upgrades.** Both terminals are audited on attach _and_ on rejection, under method `WS` (never an HTTP verb) — an upgrade never enters Nest, so its origin is read off the raw socket rather than the request context.

A failed audit write is logged and swallowed: it never turns a denial into a `500` or costs a request the response it earned. Denials carry their own retention cap (`LAB_AUDIT_DENIED_KEEP`) so an unauthenticated flood cannot evict the `ok`/`error` history.
