import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import labContractPkg from '../lab-contract.js';
import { call, failOnError } from '../shared.js';

const { DeliveryStatusSchema, DeviceTokenStatusSchema, LifecycleJobPhaseSchema } = labContractPkg;

const pageShape = {
  limit: z.number().int().min(1).max(200).optional().describe('Rows to read (default 50, cap 200)'),
  offset: z.number().int().min(0).optional().describe('Rows to skip before the page starts'),
};

export function registerHubTools(server: McpServer, ctx: LabContext): void {
  server.tool(
    'lab_list_lifecycle_jobs',
    'Lifecycle-engine jobs, newest first, filterable by phase and device, with a whole-table phase census. A job id is also the bridge plan_id — the join key into queue jobs (lab_get_lifecycle_job_queue_jobs).',
    {
      phases: z.array(LifecycleJobPhaseSchema).optional().describe('Phases to include; omit for every phase'),
      deviceId: z.string().optional().describe('Restrict to one device'),
      ...pageShape,
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.listLifecycleJobs({
          query: {
            phases: args.phases?.join(','),
            deviceId: args.deviceId,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          },
        });
        failOnError(res, 'listLifecycleJobs');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_lifecycle_job',
    'One lifecycle job with its redacted payload and its full step timeline (every inbound bridge message and engine transition). A job id that matches nothing returns a null job, not an error.',
    {
      jobId: z.string().min(1).describe('LifecycleJob.id, which is also the bridge plan_id'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getLifecycleJob({ params: { jobId: args.jobId } });
        failOnError(res, 'getLifecycleJob');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_lifecycle_job_queue_jobs',
    "Find the saga queue jobs carrying this lifecycle job's plan id (the hub composes saga job ids as <deviceId>-<sagaName>-<planId>). Finding nothing is normal for a finished job — queues retain completed jobs only briefly.",
    {
      jobId: z.string().min(1).describe('LifecycleJob.id, which is also the bridge plan_id'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getLifecycleJobQueueJobs({ params: { jobId: args.jobId } });
        failOnError(res, 'getLifecycleJobQueueJobs');
        return res.body;
      }),
  );

  server.tool(
    'lab_list_webhook_deliveries',
    'Webhook deliveries with attempt, response, and processing-lock state (a lockedBy still set past lockExpiresAtMs is a wedged delivery). Secrets are never selected.',
    {
      status: DeliveryStatusSchema.optional().describe('Restrict to one delivery state'),
      webhookId: z.string().optional().describe('Restrict to one webhook'),
      ...pageShape,
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.listWebhookDeliveries({
          query: {
            status: args.status,
            webhookId: args.webhookId,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          },
        });
        failOnError(res, 'listWebhookDeliveries');
        return res.body;
      }),
  );

  server.tool(
    'lab_list_device_tokens',
    'Device phone-home tokens with recency (identified by non-secret display id; the hash is never selected). The only reliable evidence a device is still calling home.',
    {
      deviceId: z.string().optional().describe('Restrict to one device'),
      status: DeviceTokenStatusSchema.optional().describe('Restrict to active or revoked tokens'),
      ...pageShape,
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.listDeviceTokens({
          query: {
            deviceId: args.deviceId,
            status: args.status,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          },
        });
        failOnError(res, 'listDeviceTokens');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_device_token_events',
    "One device token's audit trail, including uses after revocation or expiry (USED_AFTER_REVOKE / USED_AFTER_EXPIRY mean something still holds a token it should no longer be able to use).",
    {
      tokenId: z.string().min(1).describe('DeviceToken.id'),
      ...pageShape,
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getDeviceTokenEvents({
          params: { tokenId: args.tokenId },
          query: { limit: args.limit ?? 50, offset: args.offset ?? 0 },
        });
        failOnError(res, 'getDeviceTokenEvents');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_zone_runtime',
    'Per-zone bridge runtime: leader election (authoritative key vs self-reported flag), bridge presence, VRRP desired-vs-observed, zone-crypto presence, recent agent work. Fields read null when a probe failed — distinct from a measured zero/false/empty.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.listZoneRuntimes({});
        failOnError(res, 'listZoneRuntimes');
        return res.body;
      }),
  );
}
