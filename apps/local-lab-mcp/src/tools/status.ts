import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import labContractPkg from '../lab-contract.js';
import { call, failOnError } from '../shared.js';

const { AuditOutcomeSchema } = labContractPkg;

export function registerStatusTools(server: McpServer, ctx: LabContext): void {
  server.tool(
    'lab_get_status',
    'Read-only, no gate: whole-stack overview — running version, process/build freshness, repo checkouts, service + datastore health, fleet node state, and selfSlot, the instance slot of the stack answering. selfSlot is null when the serving slot could not be read (the stacks route is loopback-only, so a remote lab refuses it); call lab_list_stacks for the reason. labTarget reports which stack this server decided to talk to and why, so labTarget.slot disagreeing with selfSlot means the target is stale. Call this first to orient before changing anything.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getStatus({});
        failOnError(res, 'getStatus');
        // optional sub-request: the stacks route is loopback-only (403 remote) and absent on an older
        // lab, so degrade selfSlot instead of failing the orienting call — anything else stays loud
        const stacks = await client.listStacks({});
        if (stacks.status !== 200 && stacks.status !== 403 && stacks.status !== 404) {
          failOnError(stacks, 'listStacks');
        }
        const selfSlot = stacks.status === 200 ? stacks.body.selfSlot : null;
        return { ...res.body, selfSlot, labTarget: ctx.targetInfo };
      }),
  );

  server.tool(
    'lab_list_stacks',
    'Read-only, no gate: every stack registered on this host — slot, owning checkout, recorded state, probed liveness, hub/web/lab URLs, and a process rollup — plus selfSlot for the stack answering. Use it to tell this stack apart from a sibling before driving anything.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.listStacks({});
        failOnError(res, 'listStacks');
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
