# `@hydrahost/plugin-nomad`

Public Brokkr plugin that drives a customer-supplied [Nomad](https://www.nomadproject.io/)
cluster for Brokkr-oriented jobs (`validate` → `plan` → `submit` → `status` → `stop`),
plus read/dispatch routes (`nodes`, `allocs`, `logs`, `dispatch`) so consumers never
call Nomad directly.

## Enable

The plugin ships **off**. Set `NOMAD_PLUGIN_ENABLED=true` to opt in (never from
`NOMAD_ADDR` alone). With the flag set, missing/invalid `NOMAD_ADDR` /
`NOMAD_TOKEN` fail hub boot with `Plugin "nomad" config validation failed`.
Without the flag the hub boots with no Nomad routes.

To turn it on:

1. Create a Nomad ACL token with the permissions below (namespace-scoped; not a
   management token).
2. Set `NOMAD_ADDR`, `NOMAD_TOKEN`, and `NOMAD_PLUGIN_ENABLED=true` (see
   [Example config](#example-config)).
3. Restart the hub. Confirm `GET /api/v1/plugins/nomad/health` returns
   `{ "ok": true, "pluginId": "nomad" }` when called as an instance operator.
4. Prefer a dry run: `POST .../validate` then `.../plan` before `.../submit`.

Invalid or missing required settings cause hub boot to fail with
`Plugin "nomad" config validation failed` when the plugin is enabled.

## Required Nomad ACLs / permissions

Minimum capabilities for the token in `NOMAD_TOKEN` (per target namespace):

| Capability     | Why                                                             |
| -------------- | --------------------------------------------------------------- |
| `parse-job`    | HCL → Job JSON via the Nomad parse API                          |
| `submit-job`   | validate / plan / register (create-update) / stop-deregister    |
| `read-job`     | status polling, `job` spec reads, and `allocs`                  |
| `list-jobs`    | job listings backing `allocs` reads                             |
| `read-logs`    | `logs` — task log reads via the client fs API                   |
| `dispatch-job` | `dispatch` — dispatching instances of parameterized target jobs |

The `nodes` route additionally needs a node policy block (node ACLs are
cluster-level, not namespaced):

```hcl
node {
  policy = "read"
}
```

Optional: restrict the token to a single namespace and node pool that matches
your jobspec variables. Do not use a global management token in production.

## Example config

Environment (real `configSchema` field ↔ env mapping):

```bash
# Required to enable (all three)
export NOMAD_PLUGIN_ENABLED="true"
export NOMAD_ADDR="http://127.0.0.1:4646"   # settings.address
export NOMAD_TOKEN="00000000-0000-0000-0000-000000000000"  # settings.token (placeholder)

# Optional
export NOMAD_NAMESPACE="default"            # settings.namespace (default: default)
export NOMAD_REGION="global"                # settings.region (omit to use agent default)
export NOMAD_HTTP_TIMEOUT_MS="30000"        # settings.timeoutMs (default: 30000)
# export NOMAD_SKIP_VERIFY="true"           # settings.tlsSkipVerify — lab only
```

| Env var                 | Setting         | Required when enabled | Notes                                                                                         |
| ----------------------- | --------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `NOMAD_PLUGIN_ENABLED`  | (host flag)     | yes (`true`)          | Opt-in intent. Incomplete addr/token then fails boot (does not silently stay disabled).       |
| `NOMAD_ADDR`            | `address`       | yes                   | Nomad HTTP API base URL                                                                       |
| `NOMAD_TOKEN`           | `token`         | yes                   | ACL token SecretID (`X-Nomad-Token`)                                                          |
| `NOMAD_NAMESPACE`       | `namespace`     | no                    | Defaults to `default`                                                                         |
| `NOMAD_REGION`          | `region`        | no                    | Uses the Nomad agent default when unset                                                       |
| `NOMAD_HTTP_TIMEOUT_MS` | `timeoutMs`     | no                    | Defaults to `30000`                                                                           |
| `NOMAD_SKIP_VERIFY`     | `tlsSkipVerify` | no                    | Lab only. Skips TLS verify; the client logs a warning when enabled. Do not use outside a lab. |

Host registry (`plugins-config`) sets `enabled` from `NOMAD_PLUGIN_ENABLED=true`
and validates settings via `NomadConfigSchema`.

Examples use placeholder tokens and `127.0.0.1` only — no private registries or
host-specific DNS.

## Fail-closed behavior

While disabled (default — no `NOMAD_PLUGIN_ENABLED=true`):

- Nomad routes are **not** merged into the hub contract.
- Requests to `/api/v1/plugins/nomad/*` return Nest **404** (not a dedicated
  “plugin disabled” status).
- No Nomad client is constructed; missing Nomad env vars do not fail boot.

Regression coverage:
`apps/api/src/plugin-host/__test__/nomad-fail-closed.spec.ts`.

## Security

All `/plugins/nomad/*` routes require an **operator** identity via the shared
`PluginOperatorGuard` from `@hydrahost/plugin-sdk/nest`: the instance operator
always passes, and members of the org configured in `adminOrganizationId` also
pass. Ordinary tenant users cannot call validate, plan, submit, status, or stop.

`submit` accepts caller-supplied `jobHCL` / parsed `job` JSON as well as the
shipped jobspec. Treat the Nomad ACL token as highly privileged: anyone who can
call `submit` as an instance operator can schedule arbitrary Docker workloads on
clients the token can place onto.

## HTTP contract

Routes (under the host `API_PREFIX`, typically `/api/v1`):

| Method | Path                      | Purpose                                         |
| ------ | ------------------------- | ----------------------------------------------- |
| `GET`  | `/plugins/nomad/health`   | Liveness stub (does not contact Nomad)          |
| `POST` | `/plugins/nomad/validate` | Parse (if needed) + Nomad validate              |
| `POST` | `/plugins/nomad/plan`     | Parse (if needed) + Nomad plan                  |
| `POST` | `/plugins/nomad/submit`   | Parse (if needed) + register/update job         |
| `GET`  | `/plugins/nomad/status`   | One-shot startup snapshot for a `jobId`         |
| `POST` | `/plugins/nomad/stop`     | Stop/deregister a job (`purge` optional)        |
| `GET`  | `/plugins/nomad/job`      | Read a registered job spec (deploy prefill)     |
| `GET`  | `/plugins/nomad/nodes`    | List client nodes; `nodeId` reads one with meta |
| `GET`  | `/plugins/nomad/allocs`   | List allocations for a `jobId` (child IDs ok)   |
| `GET`  | `/plugins/nomad/logs`     | Single-shot task log tail for an `allocId`      |
| `POST` | `/plugins/nomad/dispatch` | Dispatch an instance of a parameterized job     |

Validate / plan / submit bodies accept `job` (parsed JSON), `jobHCL`, or
`jobspecId` (default `bridge-services`) plus optional `variables` / `namespace`.
Submit is Nomad create-or-update by `Job.ID`. Status is a single snapshot; the
caller owns polling. Stop body is `{ jobId, purge?, namespace? }` — `purge: false`
(default) deregisters so the same ID can be re-registered; `purge: true` also
removes Nomad GC history (useful for lab/smoke teardown). Schemas export from
`@hydrahost/plugin-nomad/contract`.

Observability + dispatch routes (so consumers never talk to Nomad directly):

- `nodes` — `GET /v1/nodes` list stubs mapped to `{ id, name, status,
schedulingEligibility, datacenter, nodePool, address, version, drivers }`.
  List stubs do not carry Meta; pass `?nodeId=` to read `GET /v1/node/:id` and
  get a single-element `nodes` array with `meta` populated (agent `version`
  comes from `Attributes["nomad.version"]` on that path).
- `job` — `GET /v1/job/:jobId` mapped to `{ jobId, name, jobStatus, taskGroups }`
  where each task carries `config` (driver Config), `resources`
  (`cpu`/`memoryMB`), and `env`. Backs the admin "read from server" deploy
  prefill; `namespace` override and URL-encoded job IDs work like `allocs`.
- `allocs` — `GET /v1/job/:jobId/allocations` mapped to per-alloc summaries
  (`nodeId`/`nodeName`, `clientStatus`, `taskGroup`, per-task
  `state`/`failed`/`finishedAt`, `createTime`/`modifyTime`). Dispatched child
  IDs like `facts/dispatch-…` work — path segments are URL-encoded.
- `logs` — `GET /v1/client/fs/logs/:allocId` with `plain=true`, `follow=false`:
  a bounded one-shot text read, **not** a stream. Query: `allocId`, `task`,
  `type` (`stdout`|`stderr`, default `stdout`), `origin` (`start`|`end`,
  default `end`), `offset` bytes (default 16384 — the tail size when
  `origin=end`). Returns `{ text, allocId, task, type, origin, offset }`.
- `dispatch` — `POST /v1/job/:jobId/dispatch` with optional `meta`
  (string→string) and `payload` (plain string; the plugin base64-encodes it for
  Nomad `Payload`). `namespace` override behaves like `stop`. Returns
  `{ dispatchedJobId, evalId }` mapped from `DispatchedJobID` / `EvalID`.

Step failures return HTTP 200 with `status: "error"` in the body (not 502).

Routes use `visibility: internal` (same as other operator plugins), so they do
**not** appear in the tenant-facing public ReDoc (`/api/redoc`). Contract shapes
live in `@hydrahost/plugin-nomad/contract`. A future operator-tier OpenAPI doc
may surface them; runtime auth remains instance-operator only either way.

## Managed job template

Shipped under `jobspecs/`. The primary template is **`bridge-services.hcl`** —
a public-safe, bridge-services–equivalent system job (dns / api / dhcp groups)
using native Nomad `variable` blocks. Load it from backend code via
`loadJobspec('bridge-services')`.

HCL block labels cannot interpolate variables, so the shipped job label is the
literal `bridge-services`. On the **shipped jobspec** path only, pass
`variables.job_name` to override `Job.ID` / `Name` after parse (that key is
stripped before Nomad `Variables`). Inline `jobHCL` passes `variables` through
unchanged and keeps the parsed job ID.

### `bridge-services` variables

| Variable           | Type   | Required               | Purpose                                                                   |
| ------------------ | ------ | ---------------------- | ------------------------------------------------------------------------- |
| `job_name`         | string | no (shipped path only) | Overrides Nomad `Job.ID` after parse for shipped jobspecs; not an HCL var |
| `datacenter`       | string | yes                    | Target Nomad datacenter                                                   |
| `zone_id`          | string | yes                    | Brokkr zone id injected into task env                                     |
| `bridge_api_image` | string | yes                    | Image that honours `HOST`/`PORT` and serves `/api/health`                 |
| `bind_image`       | string | yes                    | Full docker image ref for bind9                                           |
| `kea_image`        | string | yes                    | Full docker image ref for kea-dhcp                                        |
| `namespace`        | string | no (default `default`) | Nomad namespace                                                           |
| `node_pool`        | string | no (default `default`) | Nomad node pool                                                           |
| `priority`         | number | no (default `80`)      | Nomad job priority                                                        |

The `api` group sets `HOST=0.0.0.0` and `PORT=${NOMAD_PORT_api}` so a Brokkr
bridge image listens on the advertised static port (default 80). That exposes
the bridge REST surface on the node IP — firewall accordingly. There is no
nginx sidecar in v0.

### Nomad cluster requirements

The shipped system job expects:

- Docker driver with `privileged = true` allowed (`docker.privileged.enabled`)
- `allow_caps` including `net_raw`, `net_admin`, `net_bind_service` for kea/bind
- Free static host ports **53**, **80**, and **11111** on every eligible client
- `network_mode = "host"` on all tasks

## Adding another jobspec

1. Add `jobspecs/<id>.hcl` with its own `variable` blocks (keep private registry /
   Vault / internal DNS out of this package). Use a **literal** job label.
2. Add the id to `SHIPPED_JOBSPEC_IDS` in `schemas.ts` (single source for the Zod
   contract `jobspecId` enum and the runtime filesystem allowlist).
3. Document the new variables in this README. On the shipped path, `variables.job_name`
   is reserved for post-parse `Job.ID` override and is stripped from Nomad Variables —
   do not declare `variable "job_name"` in a shipped HCL unless you change that contract.
4. Add a load + real parse smoke test under `backend/__test__/`.

## Testing

```bash
pnpm --filter @hydrahost/plugin-nomad test
```

Default CI path is fully mocked (no Nomad network). The deploy pipeline
integration (`backend/__test__/deploy-pipeline.int.spec.ts`) asserts contract
field values for validate → plan → submit → status → stop against a stubbed fetch.

Optional live checks (skipped unless set):

| Env                                                   | What runs                                        |
| ----------------------------------------------------- | ------------------------------------------------ |
| `nomad` on `PATH`                                     | `nomad job run -output` parse of the shipped HCL |
| `NOMAD_LIVE_TEST=true` + `NOMAD_ADDR` + `NOMAD_TOKEN` | live parse + validate of the shipped jobspec     |

Host fail-closed (plugin disabled → Nest 404) is covered in
`apps/api/src/plugin-host/__test__/nomad-fail-closed.spec.ts`.

## Smoke against a running hub

Minimal end-to-end check without admin/BMBO: enable the plugin on the hub
([Enable](#enable)), then:

```bash
export HUB_BASE_URL="http://127.0.0.1:3000/api/v1"
export HUB_OPERATOR_API_KEY="…"   # instance-operator API key
pnpm --filter @hydrahost/plugin-nomad smoke
# optional: also register the job — SMOKE_SUBMIT=1 pnpm --filter @hydrahost/plugin-nomad smoke
# with submit, stop+purge runs afterward unless SMOKE_KEEP=1
```

Default smoke runs **health → validate → plan** only (no schedule). With
`SMOKE_SUBMIT=1`, smoke also submits, polls status once, then
`POST .../stop` with `purge: true` (skip teardown with `SMOKE_KEEP=1`).
Responses are written under `/tmp/nomad-smoke-*.json`. Override sample images /
datacenter by editing `scripts/smoke.sh` or posting the same JSON with `curl`.

## License

Apache-2.0
