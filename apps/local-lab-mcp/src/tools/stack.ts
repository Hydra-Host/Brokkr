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
    'Heavyweight: tear down and bring the full hub/spoke roster back up in dependency order so changed instance counts and overrides take effect. Prefer lab_reload_services for env-only tweaks. A redeploy that would migrate this checkout to another slot (staged stack config slot ≠ the serving selfSlot) releases the slot registry entry and wipes slot-bound state, so it requires this server to run with LAB_MCP_ALLOW_DESTRUCTIVE=1; the ordinary same-slot redeploy needs no flag.',
    { ...waitShape },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            if (!options.allowDestructive) {
              const config = await client.getStackConfig({});
              failOnError(config, 'getStackConfig');
              const stacks = await client.listStacks({});
              failOnError(stacks, 'listStacks');
              if (!config.body.seeded) {
                throw new Error(
                  'cannot tell whether this redeploy would migrate the slot: the stack config eval is unseeded, so its slot is a bare default — restart the MCP server with LAB_MCP_ALLOW_DESTRUCTIVE=1 to redeploy anyway',
                );
              }
              // the staged slot is eval-derived, so a mismatch with the serving slot is an armed reslot
              if (config.body.slot !== stacks.body.selfSlot) {
                throw new Error(
                  `redeploy would migrate this checkout from slot ${stacks.body.selfSlot} to slot ${config.body.slot}, releasing the slot registry entry and wiping slot-bound state — restart the MCP server with LAB_MCP_ALLOW_DESTRUCTIVE=1 to run it`,
                );
              }
            }
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
      'DESTRUCTIVE-gated: write stack overrides to the stack.local.nix overlay, keyed by the canonical Nix path lab_get_stack_config reports. A path you omit is untouched, a string sets an override, and null reverts it to the value Nix declares — so no read-modify-write is needed. Inert until a lab_reload_services or lab_redeploy_stack applies them (telemetry auto-applies). Returns applied paths and, for each one it refused, the reason.',
      {
        entries: z
          .record(z.string(), z.string().nullable())
          .describe(
            'Canonical path → value, e.g. {"stackDefaults.hub.LOG_LEVEL": "warn", "ports.postgres": "5442", "lan.expose": "true"}. Null reverts a path.',
          ),
        slot: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Move the stack to this slot; drops fleet and port overrides'),
      },
      (args) =>
        call(ctx, async (client) => {
          const res = await client.putStackConfig({
            body: args.slot === undefined ? { entries: args.entries } : { entries: args.entries, slot: args.slot },
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
