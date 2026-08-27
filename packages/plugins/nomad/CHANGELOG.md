# Changelog

All notable changes to `@hydrahost/plugin-nomad` are documented in this file.

## [Unreleased]

### Changed

- Replaced the plugin-local `InstanceOperatorGuard` with the shared
  `PluginOperatorGuard` from `@hydrahost/plugin-sdk/nest`, wired to
  `adminOrganizationId` via the `PLUGIN_OPERATOR_ADMIN_ORG` provider — same
  behavior, one guard implementation across plugins.

### Added

- `adminOrganizationId` plugin setting (host env `BROKKR_ADMIN_ORG_ID`): the
  operator guard now grants access to members of the configured admin
  organization in addition to the instance-operator designation, matching the
  other operator-facing plugins. Empty string (the default) disables the
  org-id grant.
- `GET /plugins/nomad/job` — read a registered job's spec via Nomad
  `GET /v1/job/:jobId`, mapping `TaskGroups[].Tasks[]` to camelCase `config` /
  `resources` (`cpu`, `memoryMB`) / `env` for the admin "read from server"
  deploy prefill. `visibility: internal`, instance-operator gated, HTTP 200
  `status: "error"` body (empty `taskGroups`) on Nomad failures. Uses the
  existing `read-job` ACL capability.
- Observability + dispatch routes so consumers (e.g. the Hydra admin
  app) never call Nomad directly:
  - `GET /plugins/nomad/nodes` — node list stubs; `?nodeId=` reads one node with
    Meta (agent version from `Attributes["nomad.version"]` on the detail path).
  - `GET /plugins/nomad/allocs?jobId=` — allocation summaries with per-task
    states; dispatched child IDs (`facts/dispatch-…`) supported via URL-encoded
    path segments.
  - `GET /plugins/nomad/logs?allocId=&task=` — bounded single-shot log tail
    (`plain=true`, `follow=false`; `origin` start|end, `offset` default 16KB),
    not a stream. Client gained a raw-text fetch path for non-JSON bodies.
  - `POST /plugins/nomad/dispatch` — dispatch a parameterized job with optional
    `meta` and `payload` (base64-encoded for Nomad `Payload`); returns
    `dispatchedJobId` + `evalId`.
  - All four are `visibility: internal`, instance-operator gated, and return
    HTTP 200 `status: "error"` bodies on Nomad failures like the v0 routes.
  - README documents the new contract rows and required Nomad ACLs
    (`list-jobs`, `read-logs`, `dispatch-job`, cluster-level `node read`).
- `POST /plugins/nomad/stop` — Nomad DELETE deregister (`purge` optional); covered by
  unit/integration tests and optional smoke teardown after `SMOKE_SUBMIT=1`.
- Scaffold workspace package `@hydrahost/plugin-nomad` (plugin id `nomad`) with
  backend Nest module, Zod config schema, and stub `/plugins/nomad/health`
  ts-rest contract.
- Zod `NomadConfigSchema` for `NOMAD_ADDR` / `NOMAD_TOKEN` (plus optional
  namespace, region, timeout, TLS skip-verify). Registered in `plugins-config`
  with `enabled: false` so the hub boots without Nomad env vars.
- Nomad HTTP client (parse / validate / plan / submit + eval/alloc/job status
  reads) wired through Nest `NomadClient` from plugin config. Zod response
  schemas under `backend/types/`. No Vault/Prisma coupling.
- Primary `jobspecs/bridge-services.hcl` (native Nomad variables; no Hydra
  registry/Vault). Loadable via `loadJobspec('bridge-services')`.
- ts-rest contract for validate / plan / submit / status under
  `/plugins/nomad/*`, with startup-status evaluator and Nest handlers.
- Instance-operator guard on all Nomad routes; literal `bridge-services` job
  label with post-parse `job_name` ID override; nullable plan `Diff`; drop
  broken nginx sidecar; inject bridge `HOST`/`PORT`.
- `job_name` strip / ID override apply only on the shipped-jobspec path; inline
  `jobHCL` keeps variables and parsed IDs intact.
- Startup timeout message uses "job startup timed out" (not bridge-specific).
- Host fail-closed regression: disabled Nomad routes omitted from merged contract
  (`apps/api` `nomad-fail-closed.spec.ts`); disabled requests are Nest 404.
- Mocked validate → plan → submit → status → stop integration path; expanded unit
  coverage (startup timeouts, network errors, operator guard behaviour).
- Self-hoster README: Enable, ACLs, example config (real `configSchema` / env
  names), fail-closed, managed job template, adding jobspecs. Package listed in
  root `.public-paths` for the public mirror.
- Host opt-in via `NOMAD_PLUGIN_ENABLED=true` (incomplete addr/token fails boot);
  routes stay `visibility: internal` like peer operator plugins (not in public ReDoc).
- Shipped jobspec path aligns `Job.Namespace` / HCL `namespace` with request override.
- `SHIPPED_JOBSPEC_IDS` lives in `schemas.ts` (shared by contract + loader).
- Live Nomad integration tests require explicit `NOMAD_LIVE_TEST=true`.
- `scripts/smoke.sh` / `pnpm smoke`: hub health → validate → plan (optional submit + stop).
