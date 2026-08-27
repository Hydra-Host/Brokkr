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
| `LAB_API_TOKEN`          | Bearer/`x-lab-token` required for non-loopback requests. Unset ⇒ fail-closed (off-loopback denied). Under `lan.expose` the devenv mints one and exports it — see below.       |
| `LAB_ALLOW_REMOTE_SHARP` | Set to exactly `1` to let non-loopback callers reach `loopback-only` routes and the WS terminals. Any other value denies.                                                     |
| `LAB_CORS_ORIGINS`       | Comma-separated CORS allowlist (defaults to the lab-web dev origins).                                                                                                         |
| `LAB_WEB_PORT` / `PORT`  | Used to derive the default CORS allowlist origin and the lab-web port mutations may originate from.                                                                           |
| `LAB_TRUST_PROXY`        | `1` ⇒ trust the lab-web proxy's `x-forwarded-for` (the devenv sets it).                                                                                                       |
| `LOCAL_BROKKR_ROOT`      | Sim engine root (defaults to `../local-sim`).                                                                                                                                 |
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
- **Mutating requests are content-type and origin gated** (`src/common/require-json-mutation.middleware.ts`, ahead of the body parser): `POST`/`PUT`/`PATCH`/`DELETE` that declare a non-JSON content type get `415`, and a foreign `Origin` gets `403` — loopback needs no token and CORS only hides the response, so this is what stops a drive-by page. Accepted origins: the `LAB_CORS_ORIGINS` allowlist, a loopback name (`localhost`/`127.0.0.1`/`::1`) on a lab port, and an origin naming the address the connection actually arrived on. The request's `Host` header is caller-supplied and never consulted; neither is `os.hostname()` — a LAN client reaches us by whatever name **its** resolver knows (router-assigned, Tailscale MagicDNS), which this host may never see, so matching our own name would deny the common case anyway. Instead, **a token-authenticated caller skips the origin gate**: the token is itself an anti-CSRF proof, since a foreign page can neither read it (origin-scoped `localStorage`; the Vite dev server does not serve the bundle cross-origin) nor send the header without tripping a preflight the CORS allowlist rejects. So a LAN browser mutates by any hostname, while an untokened loopback caller stays gated exactly as before. An absent content type or `Origin` is left alone for curl/the CLI.

Keep it on **loopback / a trusted network**. Even with the token gate, treat exposing this API as exposing root on the dev box.

### What `lan.expose` does to all of the above

The devenv's LAN toggle (`stack.local.nix`, written by the control center's Stack knobs page) does not just change the bind host — on its own that would leave the API reachable but **unusable**, since an unset token denies every remote caller. So under `lan.expose` `devenv.nix` also:

- mints a persistent token into `$DEVENV_STATE/lab/api-token` (`0600`, the `lab:token` task) and exports it as `LAB_API_TOKEN`,
- hands the **same** token to the lab-web Vite server as `VITE_LAB_API_TOKEN`, which the SPA then uses (`apps/local-lab-web/src/lib/lab-token.ts`) so a LAN browser authenticates with no manual paste. The injected token **wins over one stored in the browser**: this bundle is served by the stack it talks to, so the stack's own token is authoritative, and a token typed while debugging a 401 must not outlive the problem it was typed for. The Config summary says so instead of offering a field that would be ignored; the stored token is the fallback for a hand-run lab-web, which gets no injection,
- sets `LAB_ALLOW_REMOTE_SHARP=1`, because the `loopback-only` routes and the WS terminals are most of what the UI does and would otherwise `403` from the LAN.

That injected token is also what carries a LAN browser through the mutation origin gate (above), so no `LAB_CORS_ORIGINS` entry is needed per hostname you happen to browse by.

The consequence is deliberate and worth stating plainly: **anything that can load the control center over the LAN can read the token out of the served bundle and drive the whole sim, root-equivalent routes included.** In LAN mode the network is the trust boundary — the same bet the toggle already makes by exposing auth-less Postgres/Redis. Rotate by deleting the token file and restarting `lab` + `lab-web`; leave the toggle off on any network you don't trust.

### Audit trail

Every mutating request is written to the `audit_events` table (`src/common/audit.interceptor.ts`), redacted, with the origin it came from. Three surfaces the interceptor structurally cannot see are covered separately:

- **Guard denials.** `LabAuthGuard` writes its own `denied` row before throwing, because guards run before interceptors — otherwise "someone tried to nuke the stack from a LAN address" would leave no trace at all. Safe-method (`GET`/`HEAD`/`OPTIONS`) denials are deliberately not recorded, so a probe cannot fill the table.
- **Middleware refusals.** The mutation guard (`src/common/require-json-mutation.middleware.ts`) answers 415/403 ahead of the router entirely, so it writes its own `denied` row under handler `requireJsonMutation`.
- **WebSocket upgrades.** Both terminals are audited on attach _and_ on rejection, under method `WS` (never an HTTP verb) — an upgrade never enters Nest, so its origin is read off the raw socket rather than the request context.

A failed audit write is logged and swallowed: it never turns a denial into a `500` or costs a request the response it earned. Denials carry their own retention cap (`LAB_AUDIT_DENIED_KEEP`) so an unauthenticated flood cannot evict the `ok`/`error` history.
