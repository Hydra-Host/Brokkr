import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import { runAndCollect, waitShape } from '../runs.js';
import { call, failOnError } from '../shared.js';
import type { ToolOptions } from './index.js';

export function registerFleetTools(server: McpServer, ctx: LabContext, options: ToolOptions): void {
  server.tool(
    'lab_list_fleet_machines',
    'Roster of simulated fleet VMs with current power state (names like cpu-1…cpu-4).',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.listMachines({});
        failOnError(res, 'listMachines');
        return res.body;
      }),
  );

  server.tool(
    'lab_fleet_power',
    'Power a fleet VM on/off/cycle through the simulated Redfish BMC (the real provisioning path). 409 while another power/discover op holds the node.',
    {
      name: z.string().min(1).describe('Fleet node name (e.g. cpu-1)'),
      action: z.enum(['on', 'off', 'cycle']).describe('Power action'),
      ...waitShape,
    },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.powerMachine({ body: { name: args.name, action: args.action } });
            failOnError(res, 'powerMachine');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_fleet_discover',
    'Force hardware rediscovery on a node so the hub recomposes storageLayouts from its real disks. Use after changing a node disk topology.',
    {
      name: z.string().min(1).describe('Fleet node name'),
      ...waitShape,
    },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.discoverMachine({ body: { name: args.name } });
            failOnError(res, 'discoverMachine');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_fleet_exec',
    "Run a one-shot SSH command on a fleet VM with the operator key. Default user 'root' reaches the brokkr-live discovery OS; pass 'ubuntu'/'debian' for a provisioned customer OS. Blocks until the command finishes.",
    {
      name: z.string().min(1).describe('Fleet node name (e.g. cpu-1)'),
      command: z.string().min(1).describe('Shell command to run on the VM via SSH'),
      user: z
        .string()
        .optional()
        .describe("SSH user; default 'root' (brokkr-live), 'ubuntu'/'debian' for the deployed OS"),
      timeout_s: z.number().int().min(1).max(300).optional().describe('SSH timeout in seconds (default 30, max 300)'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.execMachine({
          body: { name: args.name, command: args.command, user: args.user, timeout_s: args.timeout_s },
        });
        failOnError(res, 'execMachine');
        return res.body;
      }),
  );

  server.tool(
    'lab_fleet_console_log',
    'Tail of a VM serial-console log — boot/provision output before the network is up.',
    {
      name: z.string().min(1).describe('Fleet node name'),
      tailBytes: z
        .number()
        .int()
        .min(1024)
        .max(8 * 1024 * 1024)
        .optional()
        .describe('Tail size in bytes (default 65536, max 8 MiB)'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getMachineConsoleLog({
          params: { name: args.name },
          query: { tail_bytes: args.tailBytes },
        });
        failOnError(res, 'getMachineConsoleLog');
        return res.body;
      }),
  );

  server.tool(
    'lab_fleet_verify',
    'Verify the applied fleet against live state: every node libvirt domain, BMC daemons (ipmi_sim/sushy), fleet-level bindings, orphan domains. A report with findings is still a 200 — read the report, not the status.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getFleetVerify({});
        failOnError(res, 'getFleetVerify');
        return res.body;
      }),
  );

  server.tool(
    'lab_fleet_heal',
    'Repair every healable fleet finding in place (restart a down ipmi_sim/sushy, re-add a loopback alias, power a stopped domain on). 409 while any fleet-mutating op runs.',
    { ...waitShape },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.healFleet({ body: {} });
            failOnError(res, 'healFleet');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_get_fleet_config',
    'The fleet topology currently in effect — the stack.local.nix overlay when customized, otherwise the committed base.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getFleetConfig({});
        failOnError(res, 'getFleetConfig');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_fleet_apply_plan',
    'Preview desired-vs-applied fleet drift as minimal per-node ops (or a full rebuild) plus ETA. Changes nothing.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getFleetApplyPlan({});
        failOnError(res, 'getFleetApplyPlan');
        return res.body;
      }),
  );

  if (options.allowDestructive) {
    server.tool(
      'lab_fleet_reset',
      'DESTRUCTIVE-gated: tear a node back to clean INVENTORY — closes active Reservations + Deployments, deletes Job history, DELs spoke Redis atoms. Fleet-wide exclusive (409 while any fleet op runs).',
      {
        name: z.string().min(1).describe('Fleet node name'),
        ...waitShape,
      },
      (args) =>
        call(ctx, (client) =>
          runAndCollect(
            ctx,
            async () => {
              const res = await client.resetMachine({ body: { name: args.name } });
              failOnError(res, 'resetMachine');
              return res.body.runId;
            },
            args,
          ),
        ),
    );
  }
}
