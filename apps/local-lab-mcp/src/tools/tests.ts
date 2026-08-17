import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import labContractPkg from '../lab-contract.js';
import { collectRunLogs, waitForRun, waitShape } from '../runs.js';
import { call, failOnError } from '../shared.js';

const { CustomizationsSchema, DiskLayoutSelectionSchema } = labContractPkg;

export function registerTestTools(server: McpServer, ctx: LabContext): void {
  server.tool(
    'lab_list_test_scenarios',
    'Catalog of runnable test scenarios (vitest-backed e2e: smoke, lifecycle-quick/full, rescue-boot, cloud-init, layer-test, disk-layout, spoke-failover, vrrp-failover, …) with their picker declarations.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.listTests({});
        failOnError(res, 'listTests');
        return res.body;
      }),
  );

  server.tool(
    'lab_run_test',
    'Launch a test scenario against the stack and (with wait=true) return the final run state, the parsed result (summary counts + per-case breakdown + captured service log slices), the structured event timeline, and the run log tail. 409 if the target node already has a running test. Use lab_get_disk_layouts / lab_get_layer_catalog / lab_get_plan_catalog to build valid picker values first.',
    {
      scenarioId: z.string().min(1).describe('Scenario id from lab_list_test_scenarios'),
      nodeIndex: z.number().int().min(0).nullable().optional().describe('Fleet node index to pin the run to'),
      base: z.string().optional().describe('Base OS slug for the layer picker (operatingSystem)'),
      customizations: CustomizationsSchema.optional().describe('Layer picker selections (group → slug(s))'),
      cloudInit: z.string().optional().describe('Composed cloud-init user-data for the cloud-init picker'),
      rescueOs: z.string().optional().describe('Rescue OS slug for the rescue picker'),
      baseOses: z.array(z.string()).optional().describe('Base OS slugs to cycle for the base-os picker'),
      ipxeUrl: z.string().optional().describe('Custom iPXE script URL for the ipxe picker'),
      diskLayouts: z.array(DiskLayoutSelectionSchema).optional().describe('Disk-layout selections to cycle'),
      steps: z.array(z.string()).optional().describe('Selected sub-step values for scenarios with a steps list'),
      plan: z.string().optional().describe('Preset plan name or inline plan JSON for the plan picker'),
      ...waitShape,
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.startTest({
          body: {
            scenarioId: args.scenarioId,
            nodeIndex: args.nodeIndex,
            base: args.base,
            customizations: args.customizations,
            cloudInit: args.cloudInit,
            rescueOs: args.rescueOs,
            baseOses: args.baseOses,
            ipxeUrl: args.ipxeUrl,
            diskLayouts: args.diskLayouts,
            steps: args.steps,
            plan: args.plan,
          },
        });
        failOnError(res, 'startTest');
        const { runId } = res.body;
        if (!args.wait) return { runId };
        const run = await waitForRun(client, runId, { timeoutMs: args.timeoutMs });
        const resultRes = await client.getTestResult({ params: { runId } });
        if (resultRes.status !== 200 && resultRes.status !== 404) failOnError(resultRes, 'getTestResult');
        const result = resultRes.status === 200 ? resultRes.body : null;
        const eventsRes = await client.listTestEvents({ params: { runId } });
        if (eventsRes.status !== 200 && eventsRes.status !== 404) failOnError(eventsRes, 'listTestEvents');
        const events = eventsRes.status === 200 ? eventsRes.body : [];
        const logs = await collectRunLogs(ctx, runId);
        return { run, result, events, logs };
      }),
  );

  server.tool(
    'lab_get_test_result',
    "A test run's parsed result — summary counts, per-case breakdown, and the captured per-run service log slices. 404 for an unknown run.",
    {
      runId: z.string().min(1).describe('Test run to fetch results for'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getTestResult({ params: { runId: args.runId } });
        failOnError(res, 'getTestResult');
        return res.body;
      }),
  );

  server.tool(
    'lab_list_test_events',
    'The recorded structured event timeline for a test run, in order.',
    {
      runId: z.string().min(1).describe('Test run to list events for'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.listTestEvents({ params: { runId: args.runId } });
        failOnError(res, 'listTestEvents');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_disk_layouts',
    "A node's discovered storageLayouts — disk groups, capabilities, and the seeded default — for building valid disk-layout picker selections.",
    {
      nodeIndex: z.number().int().min(0).describe('Fleet node index'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getDiskLayouts({ params: { nodeIndex: String(args.nodeIndex) } });
        failOnError(res, 'getDiskLayouts');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_layer_catalog',
    'The hub-computed set of base OSes and customization layers a node is eligible for — input to the layer picker.',
    {
      nodeIndex: z.number().int().min(0).describe('Fleet node index'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getLayerCatalog({ params: { nodeIndex: String(args.nodeIndex) } });
        failOnError(res, 'getLayerCatalog');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_plan_catalog',
    'The assemblable step catalog and ready-made preset plans for the custom-plan builder (submit via the plan-custom scenario).',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getPlanCatalog({});
        failOnError(res, 'getPlanCatalog');
        return res.body;
      }),
  );
}
