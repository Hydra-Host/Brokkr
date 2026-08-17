import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import { runAndCollect, waitShape } from '../runs.js';
import { call, failOnError } from '../shared.js';
import type { ToolOptions } from './index.js';

export function registerStackTools(server: McpServer, ctx: LabContext, options: ToolOptions): void {
  server.tool(
    'lab_run_stack_op',
    'Launch a stack lifecycle op by id (from lab_list_stack_ops: up, down, restart, reconcile, seed, db-migrate-deploy, fleet-up, fleet-apply, …) as a background run. Returns 409 when a lifecycle op is already running in the domain. Destructive op ids (nuke/reset/purge) require this server to run with LAB_MCP_ALLOW_DESTRUCTIVE=1 — check lab_list_stack_ops destructive flags before choosing an opId.',
    {
      opId: z.string().min(1).describe('Id of the stack/fleet op to launch (from lab_list_stack_ops)'),
      allowDataLoss: z
        .boolean()
        .optional()
        .describe('Authorize a disk-recreating fleet apply; the op aborts without it when the plan needs data loss'),
      force: z
        .boolean()
        .optional()
        .describe('Override the active-saga guard on a fleet-mode-apply (409 while BullMQ jobs are in flight)'),
      ...waitShape,
    },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            // registration gating cannot cover a multiplexed by-id launcher — check the op itself
            const ops = await client.listStackOps({});
            failOnError(ops, 'listStackOps');
            const op = ops.body.find((candidate) => candidate.id === args.opId);
            if (op?.destructive && !options.allowDestructive) {
              throw new Error(
                `stack op '${args.opId}' is destructive — restart the MCP server with LAB_MCP_ALLOW_DESTRUCTIVE=1 to run it`,
              );
            }
            const res = await client.startStackRun({
              body: { opId: args.opId, allowDataLoss: args.allowDataLoss, force: args.force },
            });
            failOnError(res, 'startStackRun');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_control_service',
    'Start/stop/restart one supervised service (ids from lab_list_services, e.g. hub-api, spoke). Returns once accepted; watch progress with lab_get_run_logs or the service list.',
    {
      id: z.string().min(1).describe('Service id from lab_list_services'),
      action: z.enum(['start', 'stop', 'restart']).describe('Lifecycle action to issue'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.controlService({ body: { id: args.id, action: args.action } });
        failOnError(res, 'controlService');
        return res.body;
      }),
  );

  server.tool(
    'lab_reload_services',
    'Roll just the hub or spoke group after editing stack config: applies stack.local.nix overrides, regenerates the process-compose config, and restarts that group only.',
    {
      group: z.enum(['hub', 'spoke']).describe('Service group to reload'),
      ...waitShape,
    },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.reloadService({ body: { group: args.group } });
            failOnError(res, 'reloadService');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_redeploy_stack',
    'Heavyweight: tear down and bring the full hub/spoke roster back up in dependency order so changed instance counts and overrides take effect. Prefer lab_reload_services for env-only tweaks.',
    { ...waitShape },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.redeployStack({ body: {} });
            failOnError(res, 'redeployStack');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_control_datastore',
    'Start/stop/restart a supervised datastore or fleet-plumbing process (postgres, redis, nginx, thanos, virtqemud — ids from lab_get_stack_state).',
    {
      id: z.string().min(1).describe('Datastore/process id from lab_get_stack_state'),
      action: z.enum(['start', 'stop', 'restart']).describe('Lifecycle action to issue'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.controlDatastore({ body: { id: args.id, action: args.action } });
        failOnError(res, 'controlDatastore');
        return res.body;
      }),
  );

  if (options.allowDestructive) {
    server.tool(
      'lab_update_stack_config',
      'DESTRUCTIVE-gated: write hub/spoke env overrides, counts, ports, LAN exposure, or the telemetry toggle to the stack.local.nix overlay. The server treats hub/spoke as full-replacement maps, so omitted sections are filled from the current effective overrides before sending — a ports-only call preserves existing env overrides. Inert until a lab_reload_services or lab_redeploy_stack applies them (telemetry auto-applies). Returns applied vs rejected keys.',
      {
        hub: z
          .record(z.string(), z.string())
          .optional()
          .describe('Hub env overrides (knob keys from lab_get_stack_config); omit to keep the current ones'),
        spoke: z
          .record(z.string(), z.string())
          .optional()
          .describe('Spoke env overrides; omit to keep the current ones'),
        counts: z
          .object({ hub: z.number().int().optional(), spoke: z.number().int().optional() })
          .optional()
          .describe('Instance counts per group'),
        ports: z
          .record(z.string(), z.number().int().min(1).max(65535))
          .optional()
          .describe('Editable port overrides (config.ports key → port)'),
        lan: z.object({ expose: z.boolean() }).optional().describe('Bind sim services to 0.0.0.0 for LAN reach'),
        telemetry: z.object({ enable: z.boolean() }).optional().describe('Local OTEL sink toggle (auto-applies)'),
      },
      (args) =>
        call(ctx, async (client) => {
          const current = await client.getStackConfig({});
          failOnError(current, 'getStackConfig');
          const res = await client.putStackConfig({
            body: {
              hub: args.hub ?? current.body.values.hub,
              spoke: args.spoke ?? current.body.values.spoke,
              counts: args.counts,
              ports: args.ports,
              lan: args.lan,
              telemetry: args.telemetry,
            },
          });
          failOnError(res, 'putStackConfig');
          return res.body;
        }),
    );

    server.tool(
      'lab_checkout_branch',
      'DESTRUCTIVE-gated: check out a branch in the single hub/spoke polyrepo checkout (idempotent; tracks origin for remote-only branches, creates from HEAD otherwise). Running processes pick up the new code on the next redeploy; the response flags ccRebuildRequired when the control center itself needs a rebuild.',
      {
        branch: z.string().min(1).describe('Target branch for the stack checkout'),
      },
      (args) =>
        call(ctx, async (client) => {
          const res = await client.putStackBranches({ body: { branch: args.branch } });
          failOnError(res, 'putStackBranches');
          return res.body;
        }),
    );
  }
}
