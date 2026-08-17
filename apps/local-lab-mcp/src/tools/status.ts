import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import labContractPkg from '../lab-contract.js';
import { call, failOnError } from '../shared.js';

const { AuditOutcomeSchema } = labContractPkg;

export function registerStatusTools(server: McpServer, ctx: LabContext): void {
  server.tool(
    'lab_get_status',
    'Whole-stack overview: running version, process/build freshness, repo checkouts, service + datastore health, and fleet node state. Call this first to orient before changing anything.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getStatus({});
        failOnError(res, 'getStatus');
        return res.body;
      }),
  );

  server.tool(
    'lab_list_services',
    'Snapshot of each supervised process-compose service (hub and spoke) with process run state and health-probe readiness.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.listServices({});
        failOnError(res, 'listServices');
        return res.body;
      }),
  );

  server.tool(
    'lab_list_app_links',
    'Web UIs auto-discovered from process-compose markers — port, path, readiness, and loopback binding for each UI in the stack.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.listAppLinks({});
        failOnError(res, 'listAppLinks');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_stack_state',
    'Per-datastore status the control center uses to gate which lifecycle ops are valid right now (e.g. a reset is blocked while a datastore is mid-restart).',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getStackState({});
        failOnError(res, 'getStackState');
        return res.body;
      }),
  );

  server.tool(
    'lab_list_stack_ops',
    'Catalog of named lifecycle ops (up/down/reset/nuke/fleet-*) the control center can launch via lab_run_stack_op, with their destructive flags.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.listStackOps({});
        failOnError(res, 'listStackOps');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_stack_config',
    'Editable hub/spoke env knobs, the read-only port map, and the overrides currently applied via the stack.local.nix overlay.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getStackConfig({});
        failOnError(res, 'getStackConfig');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_audit_log',
    'Recorded control-center requests, newest first — the machine-readable trail of every mutation made through the API (including by this MCP server).',
    {
      outcome: AuditOutcomeSchema.optional().describe('Restrict to one outcome'),
      method: z.string().optional().describe('Restrict to one HTTP method (e.g. POST)'),
      since: z.number().int().min(0).optional().describe('Unix ms lower bound on the event timestamp'),
      limit: z.number().int().min(1).max(500).optional().describe('Page size, newest first (default 100)'),
      offset: z.number().int().min(0).optional().describe('Rows skipped before the page starts'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.listAuditEvents({
          query: {
            outcome: args.outcome,
            method: args.method,
            since: args.since,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          },
        });
        failOnError(res, 'listAuditEvents');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_branches',
    'The branch the single hub/spoke polyrepo checkout is currently on — what code the running hub/spoke are built from.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getStackBranches({});
        failOnError(res, 'getStackBranches');
        return res.body;
      }),
  );
}
