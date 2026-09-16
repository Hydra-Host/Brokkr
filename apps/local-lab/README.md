# local-lab — the control-center API

The NestJS API behind the **local-dev control center** (the web cockpit is `apps/local-lab-web`). It drives the local devenv stack and the simulated fleet (`apps/local-sim`) over the process-compose REST API and direct sim-engine calls — fleet power/console, lifecycle test runs, status, builds, and stack ops (reconcile, nuke, raw SQL, root SSH-exec). It is **local dev tooling, not shipped product**: it comes up alongside the rest of the stack under `task up` and is not part of the customer-facing hub (`apps/api`).

> This is the API. For the engine it drives see `../local-sim/README.md`; for the cockpit UI see `../local-lab-web/README.md`. For the full bring-up DAG and devenv layout see the repo-root `README.md` / `CLAUDE.md`.

## Running it

Normally you don't start it by hand — `task up` brings it up as the `lab` devenv process. To run it standalone (against an already-running stack):

```bash
pnpm --filter local-lab dev    # nest start --watch
```

- **Default port**: `3002` (override `LAB_PORT`; the devenv stack sets it from `modules/ports.nix`).
- **Bind host**: loopback (`127.0.0.1`) by default — set `LAB_BIND_HOST=0.0.0.0` to bind the network. Under the devenv stack `lan.mode` sets this, and the mode decides the trust rules too (see security posture).
- **Docs** (when running): Swagger `…/api/swagger`, ReDoc `…/api/redoc`, OpenAPI JSON `…/api/swagger-json`.
- **Health**: `GET /api/health` returns `{ status: 'ok' }` and needs no token. It is the one unauthenticated route (see security posture).
- Interactive terminals (VM consoles, live test-run PTYs) ride WebSockets on the same server (`/api/fleet/shell`, `/api/tests/term`) — both need the `host-exec` capability, see security posture.

## Environment

The devenv stack injects most of these from `modules/ports.nix` and the hub/spoke wiring; the defaults below apply when running standalone. The ones that matter most:

| Env var                 | Purpose                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAB_PORT`              | API/WS listen port (default `3002`).                                                                                                                                          |
| `LAB_BIND_HOST`         | Bind address (default `127.0.0.1`; set `0.0.0.0` to expose).                                                                                                                  |
| `LAB_MODE`              | `loopback`, `direct` or `fronted` — the network posture the capability model reads. Unset reads as `loopback`. An unrecognized value reads as `fronted` (fail-closed).        |
| `LAB_API_TOKEN`         | Bearer/`x-lab-token` reaching the `admin` capability. The devenv mints it and injects it into the SPA. Unset ⇒ fail-closed (a caller needing a token is denied).              |
| `LAB_HOST_TOKEN`        | The second token, reaching `host-exec`. Never injected into any bundle. Must differ from `LAB_API_TOKEN`, or every token is refused — see below.                              |
| `LAB_API_TOKEN_FILE`    | Path the api token is read from when `LAB_API_TOKEN` is unset or empty. The devenv exports it so the `brokkr-lab` MCP client resolves a token with no manual paste.           |
| `LAB_CORS_ORIGINS`      | Comma-separated CORS allowlist (defaults to the lab-web dev origins).                                                                                                         |
| `LAB_WEB_PORT` / `PORT` | Used to derive the default CORS allowlist origin and the lab-web port mutations may originate from.                                                                           |
| `LAB_TRUST_PROXY`       | `1` ⇒ trust the lab-web proxy's `x-forwarded-for` (the devenv sets it).                                                                                                       |
| `LOCAL_BROKKR_ROOT`     | Sim engine root (defaults to `../local-sim`).                                                                                                                                 |
| `VRRP_SIM_STATE_DIR`    | Where the VRRP sim's `ip` shim writes per-bridge binding state (defaults to `$DEVENV_STATE/vrrp-sim`). Absent ⇒ VIP bind state is reported as unobservable, never as unbound. |
| `DEVENV_ROOT`           | Devenv root (defaults relative to the sim root).                                                                                                                              |
| `HUB_REPO_PATH`         | Hub checkout — required for build ops; surfaced in the env-override view.                                                                                                     |
| `LOCAL_STATE`           | State dir holding the run ledger (`lab/test-tracking.db`), per-run logs (`lab/runs/`) and `lab/lab.pid`.                                                                      |
| `LOCAL_BROKKR_ALLURE`   | Results root for the per-run captured log slices (`<runId>-results/`).                                                                                                        |

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

The lab API exposes **destructive, privileged surfaces** — stack nuke, raw SQL against the hub DB, root SSH-exec, queue mutations against the live hub/spoke BullMQ queues (retry/remove/drain/clean, each minting a run), and fleet ops that need root (it installs/uses a scoped passwordless `sudo` NOPASSWD drop-in). Access control is a **capability model**, decided per connection and independent of the bind host (`src/common/lab-capability.ts`, `src/common/lab-auth.ts`).

### The four capabilities

Every route declares the capability it needs. The four are ordered, and a caller that reaches one reaches everything below it:

| Capability  | What it reaches                                                                           |
| ----------- | ----------------------------------------------------------------------------------------- |
| `read`      | Status, logs, run history, the audit log, the config model. The default for a bare route. |
| `operate`   | Fleet power and console log, test runs, builds, service start/stop/reload.                |
| `admin`     | Stack ops, config writes, queue mutations, storage wipes, branch checkout.                |
| `host-exec` | The five root-equivalent surfaces below, and nothing less than a dedicated token.         |

A handler declares one with `@LabRoute({ capability: '<name>' })` (`src/common/lab-route.ts`). An un-annotated handler requires `read`, so annotating a route only ever tightens it. A route marked `per-run` carries `read` at the guard and defers to `RunCapabilityGuard`, which reads the requirement off the run's own ledger row. `src/__test__/route-exposure.spec.ts` sweeps every route and pins its capability, so a new handler cannot land unclassified.

**The five `host-exec` surfaces** are the ones an `admin` token cannot reach:

| Surface                               | Site                                                   |
| ------------------------------------- | ------------------------------------------------------ |
| `runPgQuery`                          | Raw SQL against the hub DB (`datastore.controller.ts`) |
| `execMachine`                         | Root command on a fleet VM (`fleet.controller.ts`)     |
| `cacheSudo`                           | Caches the host sudo password (`sudo.controller.ts`)   |
| `getProcessEnv` with `reveal=true`    | Plaintext process env (`services.controller.ts`)       |
| `/api/fleet/shell`, `/api/tests/term` | Both WebSocket terminals (`fleet/shell-server.ts`)     |

The env reveal is gated at the field, not the route: the read itself is ordinary, and only the plaintext values need `host-exec`. The two terminals are interactive root-equivalent shells, so the raw upgrade handler runs the same capability check and destroys the socket when it fails. An upgrade never enters Nest, so it carries no route annotation — the check is written into the handler.

### The two tokens

The stack mints two tokens under `$DEVENV_STATE/lab/` (`0600`, in a `0700` directory), and they reach different ceilings:

| File                           | Variable         | Ceiling     | Injected into the SPA |
| ------------------------------ | ---------------- | ----------- | --------------------- |
| `$DEVENV_STATE/lab/api-token`  | `LAB_API_TOKEN`  | `admin`     | Yes                   |
| `$DEVENV_STATE/lab/host-token` | `LAB_HOST_TOKEN` | `host-exec` | **Never**             |

The split is the whole point. A `VITE_` variable is a literal string in the served bundle, so anything that can load the control center can read the api token out of it. That token must therefore stop below host execution. The host token is exported to the `lab` process only, and the three root-equivalent UI surfaces (the SQL console and both terminals) prompt the operator for it once and keep it in browser storage.

Both tokens are compared in constant time. If the two hold the same value, `resolvePrincipal` refuses **every** token and logs an error, rather than silently resolving the stronger one. Tokens persist across `task down && task up`. To rotate one, delete its file and restart `lab` and `lab-web`.

A rejected token counts against a **per-address backoff**: five consecutive rejections put that address in a 30-second cooldown, and every further rejection re-arms it. The backoff is per address rather than process-global, so one caller guessing tokens cannot lock everybody else out. A caller that presents no token is not guessing one, so it never counts as an attempt.

`GET /api/health` returns `{ status: 'ok' }` and is the single route exempt from the guard. It exists because the process-compose readiness probe can send no token, and `/api/host` (hostname, LAN address, git build stamp) must not become the public route. It lives in its own controller with a constant body, so no state leaks through it and the exemption cannot spread by proximity.

### Browser-facing gates

- **CORS is an explicit allowlist** (`LAB_CORS_ORIGINS` or the lab-web dev origins) — arbitrary `Origin`s are never reflected.
- **Mutating requests are content-type and origin gated** (`src/common/require-json-mutation.middleware.ts`, ahead of the body parser): `POST`/`PUT`/`PATCH`/`DELETE` that declare a non-JSON content type get `415`, and a foreign `Origin` gets `403` — loopback needs no token and CORS only hides the response, so this is what stops a drive-by page. Accepted origins: the `LAB_CORS_ORIGINS` allowlist, a loopback name (`localhost`/`127.0.0.1`/`::1`) on a lab port, and an origin naming the address the connection actually arrived on. The request's `Host` header is caller-supplied and never consulted; neither is `os.hostname()` — a LAN client reaches us by whatever name **its** resolver knows (router-assigned, Tailscale MagicDNS), which this host may never see, so matching our own name would deny the common case anyway. Instead, **a token-authenticated caller skips the origin gate**: the token is itself an anti-CSRF proof, since a foreign page can neither read it (origin-scoped `localStorage`; the Vite dev server does not serve the bundle cross-origin) nor send the header without tripping a preflight the CORS allowlist rejects. So a LAN browser mutates by any hostname, while an untokened loopback caller stays gated exactly as before. An absent content type or `Origin` is left alone for curl/the CLI.

### The three network modes

`lan.mode` (declared in `devenv/modules/overrides.nix`, written by the control center's **Stack knobs** page) decides two things at once: where every listener binds, and whether a loopback caller is trusted. `devenv.nix` passes it to this API as `LAB_MODE`.

| `lan.mode`           | Listeners bind                  | Loopback trusted | Who presents a token         |
| -------------------- | ------------------------------- | ---------------- | ---------------------------- |
| `loopback` (default) | `127.0.0.1`                     | Yes              | Nobody. Today's behavior.    |
| `direct`             | `0.0.0.0`, or `lan.bindAddress` | Yes              | Off-loopback callers         |
| `fronted`            | `127.0.0.1`                     | **No**           | Everybody, loopback included |

`lan.expose` survives as a **deprecated alias**: `lan.expose = true` implies `lan.mode = "direct"`. It is kept rather than removed because a removed Nix option is a hard evaluation error in every checkout whose generated `stack.local.nix` still sets it. An explicit `lan.mode` wins over the alias. Set `lan.mode` instead — the boolean cannot express `fronted`.

`lan.bindAddress` decides what listens. Under `direct` it is the single address the listeners bind, instead of every interface. Under `fronted` and `loopback` nothing binds outward at all. It takes an IPv4 or IPv6 literal only, because it reaches a socket: a name resolves to several addresses, one of which the loopback entry beside it then binds twice, and redis crash-loops.

`lan.publicHost` names the host a browser reaches this stack at. It never reaches a socket, so it takes a name — the one your front door serves under `fronted`, or the one a LAN client types under `direct`. It shapes the browser-facing URLs and the `Host` allowlist below. Empty falls back to `lan.bindAddress`, then to `localhost`.

**Upgrading a checkout that sets a name in `lan.bindAddress`:** move it to `lan.publicHost`. The evaluation refuses the name until you do, and the error names the knob to move it to. That refusal is deliberate — the same configuration used to crash-loop redis and take every downstream process with it.

Under `direct` and `fronted` the devenv hands the api token to the lab-web Vite server as `VITE_LAB_API_TOKEN`, so a browser authenticates with no manual paste. Under `loopback` it is not injected, because the address alone still carries the caller. The injected token **wins over one stored in the browser**: this bundle is served by the stack it talks to, so the stack's own token is authoritative, and a token typed while debugging a 401 must not outlive the problem. That injected token is also what carries a browser through the mutation origin gate above, so no `LAB_CORS_ORIGINS` entry is needed per hostname you browse by.

The same two modes also hand that Vite server an `ALLOWED_HOSTS` list — `lan.publicHost`, plus `localhost` and `127.0.0.1`. The hub SPAs receive the same list, built from one expression, so a name reaches both or neither. The dev server adds `.localhost` and `::1` of its own, and folds in the address it bound. That list is the dev server's own `Host` header check, and it is a different gate from the CORS allowlist above. The CORS allowlist needs no entry per hostname, and this gate does. An address always passes it, as do `localhost` and any `*.localhost` subdomain. Any other name passes only if the list holds it. So a browser that reaches the cockpit by a name needs `lan.publicHost` set to that name.

State the consequence of `direct` plainly: **anything that can load the control center over the network can read the api token out of the served bundle, and drive the whole sim with it.** It cannot reach the five `host-exec` surfaces, which is exactly what the second token buys. Leave the mode at `loopback` on any network you do not trust.

### Transport: there is none

**This stack has no TLS. It mints no certificate, and it terminates none.**

Under `direct` every credential crosses the network in cleartext — the lab token, the hub session cookie, and the datastore passwords below. Use `direct` only on a network you trust, and prefer `fronted` whenever the traffic leaves the box.

**Never expose this stack to the public internet.** Treat reaching this API as reaching root on the dev box.

### Why `fronted` turns loopback trust off

This is the paragraph that decides the whole design.

A terminator — `tailscale serve`, `ssh -L`, Caddy, ngrok — dials `127.0.0.1`. Every caller it serves therefore arrives here as a **loopback peer**. At that moment address-based trust stops meaning anything: it would hand every route to whoever the terminator serves, the root-equivalent ones included. The hazard does not depend on the bind host, because the operator fronted a loopback listener. Fronting is the hazard, not exposure.

A forwarded header cannot rescue this. This repo owns neither the terminator nor its configuration, so whether a given terminator sets `X-Forwarded-For` is not the point. **A security boundary must not depend on the header behavior of a proxy the repo does not control.**

So `fronted` drops the address branch of the capability check entirely, and every caller presents a token. `LAB_MODE` reads any unrecognized value as `fronted`, so a typo fails closed.

On a `direct` bind the opposite holds: a loopback peer really is a process on this box, so address-based trust is still sound there. That is why the modes are separate.

### Terminator recipes

These are **recipes, not supported infrastructure**. This repo installs, configures and certifies none of this. Pick a terminator you already run and trust, and set `lan.mode = "fronted"` before you point it at the stack.

Tailscale, serving the control center to your tailnet over the Tailscale certificate:

```bash
tailscale serve --bg --https 443 http://127.0.0.1:5175
```

An SSH tunnel, forwarding the control center to a laptop with no listener on the network at all:

```bash
ssh -N -L 5175:127.0.0.1:5175 you@dev-box
```

The tunnel case is the lower risk of the two, because reaching it already needs shell access to the box. It also needs no host-check entry: the browser reaches it as `localhost`.

If your terminator forwards the browser's own `Host` header, set `lan.publicHost` to the name the browser uses. The Vite dev server answers `403` to a name its `ALLOWED_HOSTS` list does not hold, and a tailnet name is not in that list by default.

### What `fronted` costs

Five consumers reach this API over loopback with no token today. Each one needs a token in `fronted` mode:

| Consumer                            | Where it is                                               |
| ----------------------------------- | --------------------------------------------------------- |
| The process-compose readiness probe | `devenv.nix`, an `http.get` that sends no headers         |
| The `brokkr-lab` MCP server         | `apps/local-lab-mcp`, registered from tracked devenv      |
| `task sim:commissioning:add`        | `Taskfile.yml`, which POSTs to `/api/stack/runs`          |
| The spoke-HA test harness           | `apps/local-sim/tests/ts-e2e/spoke-ha.ts`                 |
| The documented `curl` recipes       | `apps/local-sim/README.md` and `apps/local-sim/CLAUDE.md` |

The readiness probe is the reason `GET /api/health` exists: it can present no token, so it needs a route that asks for none.

The MCP server needs one line of your own. The `lab` process exports `LAB_API_TOKEN_FILE`, but it does **not** reach the devenv shell, and the MCP server runs as a child of your editor session rather than of the stack. Export it yourself in `.envrc.local`:

```bash
export LAB_API_TOKEN_FILE="$DEVENV_STATE/lab/api-token"
export LAB_HOST_TOKEN_FILE="$DEVENV_STATE/lab/host-token"   # only for lab_pg_query + lab_fleet_exec
```

The other three consumers take a token the same way any client does: an `x-lab-token` header, an `Authorization: Bearer` header, or a `token` query parameter.

### Datastore credentials

`lan.datastoreAuth` decides whether an off-loopback datastore client needs a credential. **It defaults to `true`, and it applies only under `direct`** — `loopback` and `fronted` put no datastore on the network at all.

With `lan.mode = "direct"` and `lan.datastoreAuth` on:

- Postgres demands `scram-sha-256` on the non-loopback `pg_hba` lines.
- Redis sets a `requirepass` on the `default` user.
- The Mailpit UI and API demand HTTP basic auth.
- Thanos receive stays pinned to loopback, because it has no authentication of its own.

Postgres keeps `trust` on loopback in every mode, because `pg_hba` is per-source and the readiness probe connects as the OS account with no password. Redis does not: `requirepass` is connection-global and has no per-source form, so a loopback `redis-cli` presents the password too, and the readiness probe carries `REDISCLI_AUTH`. Mailpit basic auth is global in the same way.

**Upgrading a checkout that already sets `lan.expose = true`:** the alias resolves to `lan.mode = "direct"`, and `lan.datastoreAuth` defaults to `true`, so the next `task up` starts demanding credentials on the four listeners above. Nothing warns you — the Nix evaluation succeeds either way, and the breakage surfaces as auth errors in whatever external client was already connected (a Redis CLI, pgAdmin, a Mailpit API poller). Either take the credentials from `stack.local.nix` and give them to those clients, or set `lan.datastoreAuth = false` after reading the caution below.

**CAUTION: Do not set `lan.datastoreAuth = false` while `lan.mode = "direct"`.** That combination writes `trust` on the `0.0.0.0/0` and `::/0` `pg_hba` lines, so any client on the network reaches Postgres **with no password, as a `SUPERUSER` role**. The `brokkr` role is `SUPERUSER` so the hub's Prisma migrate can create extensions. Under `datastoreAuth` the credential rules are what keep that role out of reach, not the grant.

The nginx OS-layer cache is the one listener that ignores all of this and binds every interface in every mode. Its `listen` directive is deliberately address-less: a provisioning VM pulls its OS-layer blobs from the data-plane gateway address, which the sim's virtual network creates **after** nginx starts. Naming that address in a `listen` directive would make nginx fail to start whenever the fleet network is down. The residual surface is an origin-pinned CDN blob cache that strips `Authorization` and `Cookie`, not an open proxy.

### Audit trail

Every mutating request is written to the `audit_events` table (`src/common/audit.interceptor.ts`), redacted, with the origin it came from. Three surfaces the interceptor structurally cannot see are covered separately:

- **Guard denials.** `LabAuthGuard` writes its own `denied` row before throwing, because guards run before interceptors — otherwise "someone tried to nuke the stack from a LAN address" would leave no trace at all. Safe-method (`GET`/`HEAD`/`OPTIONS`) denials are deliberately not recorded, so a probe cannot fill the table.
- **Middleware refusals.** The mutation guard (`src/common/require-json-mutation.middleware.ts`) answers 415/403 ahead of the router entirely, so it writes its own `denied` row under handler `requireJsonMutation`.
- **WebSocket upgrades.** Both terminals are audited on attach _and_ on rejection, under method `WS` (never an HTTP verb) — an upgrade never enters Nest, so its origin is read off the raw socket rather than the request context.

A failed audit write is logged and swallowed: it never turns a denial into a `500` or costs a request the response it earned. Denials carry their own retention cap (`LAB_AUDIT_DENIED_KEEP`) so an unauthenticated flood cannot evict the `ok`/`error` history.
