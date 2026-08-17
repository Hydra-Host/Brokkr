# brokkr-lab MCP server

MCP server exposing the **local dev stack control center** (`apps/local-lab`, default `http://127.0.0.1:3002`) to AI agents: stack lifecycle, sim fleet power/console/exec, test-scenario runs with structured results, Postgres/Redis/Thanos explorers, BullMQ queue inspection, hub debug views (lifecycle jobs, webhooks, device tokens, zone runtime), and build/layer/storage ops.

This is dev tooling. For the **product API** (deployments, servers, org, inventory, account) use the `brokkr-mcp` server from `apps/cli` instead — register both when a task spans the stack and the product.

## Prerequisites

- The local stack is up (`task up`) — the server is a client of the running control center.
- pnpm install has been run in the monorepo.

## Register

```bash
# Claude Code (project or user scope)
claude mcp add brokkr-lab -- pnpm --filter local-lab-mcp dev
```

Run via `pnpm --filter local-lab-mcp dev` (tsx). Plain `node dist/index.js` is not a supported invocation — the workspace contract package ships untranspiled TS whose extensionless imports only the tsx/vitest loaders resolve.

Add the `brokkr-lab` stdio entry to your local root `.mcp.json` (gitignored, per-developer) for clients that read it.

## Configuration

| Env var                     | Default                 | Purpose                                                                                                                                                        |
| --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAB_MCP_URL`               | `http://127.0.0.1:3002` | Control-center base URL                                                                                                                                        |
| `LAB_API_TOKEN`             | unset                   | Sent as `x-lab-token`; unneeded on loopback (trusted unconditionally)                                                                                          |
| `LAB_MCP_ALLOW_DESTRUCTIVE` | unset                   | Set to `1` to register the destructive tools (stack nuke/reset/purge ops, fleet reset, storage wipe, queue drain/clean/remove, config writes, branch checkout) |

Destructive tools are **not registered** unless `LAB_MCP_ALLOW_DESTRUCTIVE=1` — an agent cannot call what it cannot see. The control center's own guards (lane exclusivity, active-saga guard, loopback-only routes, audit log) still apply on top; every mutation lands in `lab_get_audit_log`.

## Tool groups

- **Status/stack reads**: `lab_get_status`, `lab_list_services`, `lab_list_app_links`, `lab_get_stack_state`, `lab_list_stack_ops`, `lab_get_stack_config`, `lab_get_audit_log`, `lab_get_branches`
- **Stack control**: `lab_run_stack_op`, `lab_control_service`, `lab_reload_services`, `lab_redeploy_stack`, `lab_control_datastore` (+ gated `lab_update_stack_config`, `lab_checkout_branch`)
- **Runs**: `lab_list_runs`, `lab_get_run`, `lab_get_run_logs`, `lab_cancel_run`
- **Fleet**: `lab_list_fleet_machines`, `lab_fleet_power`, `lab_fleet_discover`, `lab_fleet_exec`, `lab_fleet_console_log`, `lab_fleet_verify`, `lab_fleet_heal`, `lab_get_fleet_config`, `lab_get_fleet_apply_plan` (+ gated `lab_fleet_reset`)
- **Testing**: `lab_list_test_scenarios`, `lab_run_test`, `lab_get_test_result`, `lab_list_test_events`, `lab_get_disk_layouts`, `lab_get_layer_catalog`, `lab_get_plan_catalog`
- **Datastore/queues**: `lab_pg_query`, `lab_pg_list_tables`, `lab_pg_table_rows`, `lab_pg_migrations`, `lab_redis_info`, `lab_redis_scan`, `lab_redis_get`, `lab_thanos_query`, `lab_list_queues`, `lab_list_queue_jobs`, `lab_get_queue_job`, `lab_retry_queue_job` (+ gated `lab_drain_queue`, `lab_clean_queue`, `lab_remove_queue_job`)
- **Builds/layers/storage**: `lab_build_agent`, `lab_build_ipxe`, `lab_build_netboot_grub`, `lab_seed_layers`, `lab_get_layers_default_url`, `lab_get_layers_manifest`, `lab_list_layer_cache`, `lab_prime_layer_cache`, `lab_get_storage_state`, `lab_verify_storage` (+ gated `lab_wipe_storage`, `lab_nuke_layer_blob`)
- **Hub debug**: `lab_list_lifecycle_jobs`, `lab_get_lifecycle_job`, `lab_get_lifecycle_job_queue_jobs`, `lab_list_webhook_deliveries`, `lab_list_device_tokens`, `lab_get_device_token_events`, `lab_get_zone_runtime`

All long-running ops accept `wait` (default true) and `timeoutMs`; with `wait: false` they return `{ runId }` for polling via `lab_get_run` / `lab_get_run_logs`.

Not exposed by design: sudo caching, bare-metal power (real hardware), the WebSocket terminals (`/api/fleet/shell`, `/api/tests/term`), and process-env reveal.
