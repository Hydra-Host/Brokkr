# brokkr-lab MCP server

MCP server exposing the **local dev stack control center** (`apps/local-lab`) to AI agents: stack lifecycle, sim fleet power/console/exec, test-scenario runs with structured results, Postgres/Redis/Thanos explorers, BullMQ queue inspection, hub debug views (lifecycle jobs, webhooks, device tokens, zone runtime), and build/layer/storage ops.

This is dev tooling. For the **product API** (deployments, servers, org, inventory, account) use the `brokkr-mcp` server from `apps/cli` instead — register both when a task spans the stack and the product.

## Prerequisites

- The local stack is up (`task up`) — the server is a client of the running control center.
- pnpm install has been run in the monorepo.

## Register

Registration is automatic. `devenv/modules/agent-tooling.nix` is tracked, so every checkout gets the `brokkr-lab` stdio entry in its generated `.mcp.json`, along with a pre-approved read-only tool surface. There is no manual add step, and the entry carries no `LAB_MCP_URL` — a pinned URL would defeat the slot resolution below.

The registered command is `pnpm --filter local-lab-mcp dev` (tsx). Plain `node dist/index.js` is not a supported invocation — the workspace contract package ships untranspiled TS whose extensionless imports only the tsx/vitest loaders resolve.

## Which stack the tools reach

One host runs one stack per checkout, each on its own **slot**, so the server has to decide which stack it drives. There is no default base URL. The precedence is:

1. A target chosen at run time by `lab_use_stack`. A deliberate act by the caller outranks every start-up pin, so the tool is never a silent no-op.
2. An explicit base URL passed to the client.
3. `LAB_MCP_URL`.
4. `LAB_MCP_SLOT`, a slot number resolved through the registry.
5. The host slot-registry entry that owns the process working directory's repository toplevel.
6. Otherwise the server refuses.

The registry is `${XDG_STATE_HOME:-~/.local/state}/brokkr-local/stacks/stack-<slot>.json`, one entry per claimed slot. The lab port comes off the entry's `ports.lab`, so the port map keeps one source and the server never recomputes the slot formula.

Resolution is **lazy** — it runs on first use, not at module load. A server started before `task up` therefore works once the stack comes up, with no MCP restart.

A checkout that owns no slot gets a refusal, not a silent fall back to slot 0. That fall back is the defect this behavior removes: it succeeds, against a stranger's stack.

```
this checkout owns no dev-stack slot: /path/to/checkout
stacks on this host:
  slot 0  .worktrees/session-integration  live, same repo, lab 3002
  slot 2  /some/other/clone  down, other clone, lab 21002
call lab_use_stack {"slot": N} to drive one of them, or run `task up` here to claim your own
```

With no registry at all:

```
this checkout owns no dev-stack slot: /path/to/checkout
no stacks are registered on this host; run `task up` here
```

### Driving another checkout's stack

A session in the primary checkout regularly needs the stack a worktree owns, because a worktree claims its own slot and the primary checkout claims nothing. The remedy is `lab_use_stack`, and it needs no restart and no environment change:

- `lab_use_stack {}` lists every stack on the host — slot, checkout, liveness, lab port, and whether the checkout belongs to this repository. This is the **only** stack read that works before a target resolves, because `lab_list_stacks` is itself a lab call.
- `lab_use_stack {"slot": 0}` targets a slot by number. Any slot is reachable this way, including a checkout of an unrelated clone, because a slot number is a deliberate act.
- `lab_use_stack {"checkout": "session-integration"}` names a checkout of **this** repository, by directory name or substring. A name never matches another clone, so a loose name cannot land on one by accident. Two checkouts of this repository run one stack each, so the primary checkout and its worktrees are one family here: they share a `git rev-parse --git-common-dir`.

The server never adopts a sibling stack on its own. A slot must be stated, so a session cannot end up driving another session's stack silently.

The choice lives in memory for the life of the server process. A restart re-derives from the registry, and `LAB_MCP_SLOT` pins a slot for a session that starts already knowing it.

While a target is set that this checkout does not own, every tool result — success and failure alike — carries a first content block naming it:

```
[lab: slot 0 · .worktrees/session-integration]
```

That block is separate from the JSON payload, which stays the last block and stays parseable.

To confirm which stack answers, call `lab_list_stacks` (every slot registered on the host with its owning checkout) or read `selfSlot` and `labTarget` from `lab_get_status`. `labTarget` reports the slot this server decided on and the reason (`registry`, `tool`, `env-slot`, `env-url`, `explicit`), so `labTarget.slot` disagreeing with `selfSlot` means the target is stale. `selfSlot` is `null` when the serving slot could not be read — the stacks route is loopback-only, so a remote lab refuses it.

**Token limitation.** Tokens come from this session's environment, not from the targeted checkout. Loopback is trusted unconditionally, so a same-host target works without any token set. A lab reached off loopback needs both: `LAB_API_TOKEN` for ordinary routes, and `LAB_HOST_TOKEN` for the two `host-exec` tools (`lab_pg_query`, `lab_fleet_exec`) — the api token cannot reach those, whoever issued it.

## Configuration

| Env var                     | Default                               | Purpose                                                                                                                                                        |
| --------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAB_MCP_URL`               | unset — the slot registry resolves it | Control-center base URL; pins the server to one stack                                                                                                          |
| `LAB_MCP_SLOT`              | unset — the slot registry resolves it | Host slot number; pins the server to that slot's stack, resolved through the registry. Overridden by `LAB_MCP_URL` and by `lab_use_stack`                      |
| `LAB_API_TOKEN`             | unset                                 | Sent as `x-lab-token`; unneeded on loopback (trusted unconditionally)                                                                                          |
| `LAB_API_TOKEN_FILE`        | unset                                 | Path to a file holding the api token; read when `LAB_API_TOKEN` is unset or empty. The stack writes one and exports this                                       |
| `LAB_HOST_TOKEN`            | unset — falls back to the api token   | Sent as `x-lab-token` by `lab_pg_query` and `lab_fleet_exec` only; the `host-exec` routes refuse the api token                                                 |
| `LAB_HOST_TOKEN_FILE`       | unset                                 | Path to a file holding the host token; read when `LAB_HOST_TOKEN` is unset or empty                                                                            |
| `LAB_MCP_ALLOW_DESTRUCTIVE` | unset                                 | Set to `1` to register the destructive tools (stack nuke/reset/purge ops, fleet reset, storage wipe, queue drain/clean/remove, config writes, branch checkout) |

## Default-deny gates

Destructive tools are **not registered** unless `LAB_MCP_ALLOW_DESTRUCTIVE=1` — an agent cannot call what it cannot see. Four tools take an id or a staged config rather than a fixed blast radius, so registration-time gating cannot cover them. They check at call time instead:

- `lab_run_stack_op` refuses an op whose catalog `destructive` flag is set.
- `lab_fleet_power` refuses a machine whose roster `kind` is `baremetal` — its power actions reach a real BMC over Redfish. A VM row needs no flag.
- `lab_run_test` refuses a scenario whose catalog `destructive` flag is set. Twelve of the fifteen scenarios are destructive; `smoke`, `redis-acl` and `vrrp-failover` are not, and stay reachable without the flag.
- `lab_redeploy_stack` refuses when the redeploy would migrate this checkout to another slot — the staged stack-config slot differs from the serving `selfSlot`. A slot migration releases the registry entry and wipes slot-bound state. The ordinary same-slot redeploy needs no flag. The tool also refuses when it cannot tell the two apart, which is the case while the stack-config eval is unseeded.

Each refusal names the scenario or the slots and the environment variable, so the message says what to change. The control center's own guards (lane exclusivity, active-saga guard, loopback-only routes, audit log) still apply on top; every mutation lands in `lab_get_audit_log`.

## Tool groups

- **Target selection**: `lab_use_stack` — which host slot every other tool talks to (see [Which stack the tools reach](#which-stack-the-tools-reach))
- **Status/stack reads**: `lab_get_status`, `lab_list_stacks`, `lab_list_services`, `lab_list_app_links`, `lab_get_stack_state`, `lab_list_stack_ops`, `lab_get_stack_config`, `lab_get_audit_log`, `lab_get_branches`
- **Stack control**: `lab_run_stack_op`, `lab_control_service`, `lab_reload_services`, `lab_redeploy_stack`, `lab_control_datastore` (+ gated `lab_update_stack_config`, `lab_checkout_branch`)
- **Runs**: `lab_list_runs`, `lab_get_run`, `lab_get_run_logs`, `lab_cancel_run`
- **Fleet**: `lab_list_fleet_machines`, `lab_fleet_power`, `lab_fleet_discover`, `lab_fleet_exec`, `lab_fleet_console_log`, `lab_fleet_verify`, `lab_fleet_heal`, `lab_get_fleet_config`, `lab_get_fleet_apply_plan` (+ gated `lab_fleet_reset`)
- **Testing**: `lab_list_test_scenarios`, `lab_run_test`, `lab_get_test_result`, `lab_list_test_events`, `lab_get_disk_layouts`, `lab_get_layer_catalog`, `lab_get_plan_catalog`
- **Datastore/queues**: `lab_pg_query`, `lab_pg_list_tables`, `lab_pg_table_rows`, `lab_pg_migrations`, `lab_redis_info`, `lab_redis_scan`, `lab_redis_get`, `lab_thanos_query`, `lab_list_queues`, `lab_list_queue_jobs`, `lab_get_queue_job`, `lab_retry_queue_job` (+ gated `lab_drain_queue`, `lab_clean_queue`, `lab_remove_queue_job`)
- **Builds/layers/storage**: `lab_build_agent`, `lab_build_ipxe`, `lab_build_netboot_grub`, `lab_seed_layers`, `lab_get_layers_default_url`, `lab_get_layers_manifest`, `lab_list_layer_cache`, `lab_prime_layer_cache`, `lab_get_storage_state`, `lab_verify_storage` (+ gated `lab_wipe_storage`, `lab_nuke_layer_blob`)
- **Hub debug**: `lab_list_lifecycle_jobs`, `lab_get_lifecycle_job`, `lab_get_lifecycle_job_queue_jobs`, `lab_list_webhook_deliveries`, `lab_list_device_tokens`, `lab_get_device_token_events`, `lab_get_zone_runtime`

All long-running ops accept `wait` (default true) and `timeoutMs`; with `wait: false` they return `{ runId }` for polling via `lab_get_run` / `lab_get_run_logs`.

Not exposed by design: sudo caching, bare-metal power (real hardware), the WebSocket terminals (`/api/fleet/shell`, `/api/tests/term`), and process-env reveal.
