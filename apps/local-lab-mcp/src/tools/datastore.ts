import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import labContractPkg from '../lab-contract.js';
import { call, callHost, failOnError } from '../shared.js';
import type { ToolOptions } from './index.js';

const { QueueCleanableStateSchema, QueueJobStateSchema } = labContractPkg;

const queuePathShape = {
  prefix: z.string().min(1).describe('BullMQ key prefix of the queue — a Zone UUID, "results", or "bull"'),
  name: z.string().min(1).describe('BullMQ queue name (lifecycle, collection, inbox, …)'),
};

export function registerDatastoreTools(server: McpServer, ctx: LabContext, options: ToolOptions): void {
  server.tool(
    'lab_pg_query',
    'Run a single read-only SQL statement against the hub Postgres (SELECT / WITH…SELECT / EXPLAIN / SHOW only; executed in a READ ONLY transaction with a statement timeout). The fastest way to ground-truth hub state while debugging.',
    {
      sql: z.string().min(1).describe('A single read-only statement: SELECT / WITH…SELECT / EXPLAIN / SHOW'),
    },
    (args) =>
      callHost(ctx, async (client) => {
        const res = await client.runPgQuery({ body: { sql: args.sql } });
        failOnError(res, 'runPgQuery');
        return res.body;
      }),
  );

  server.tool('lab_pg_list_tables', 'List user tables in non-system schemas with exact row counts.', {}, () =>
    call(ctx, async (client) => {
      const res = await client.listPgTables({});
      failOnError(res, 'listPgTables');
      return res.body;
    }),
  );

  server.tool(
    'lab_pg_table_rows',
    'Paginated rows from one table; identifiers are validated against the live table/column allowlist.',
    {
      schema: z.string().min(1).describe('Postgres schema (e.g. public)'),
      table: z.string().min(1).describe('Table name (from lab_pg_list_tables)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Page size (default 100)'),
      offset: z.number().int().min(0).optional().describe('Rows skipped'),
      orderBy: z.string().optional().describe('Column to ORDER BY (validated against the column allowlist)'),
      orderDir: z.enum(['asc', 'desc']).optional().describe('Sort direction (default asc)'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getPgRows({
          params: { schema: args.schema, table: args.table },
          query: {
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
            orderBy: args.orderBy,
            orderDir: args.orderDir ?? 'asc',
          },
        });
        failOnError(res, 'getPgRows');
        return res.body;
      }),
  );

  server.tool(
    'lab_pg_migrations',
    'Hub DB migration status: _prisma_migrations vs the on-disk Prisma migrations — applied rows plus pending/missing/failed diffs.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getDbMigrations({});
        failOnError(res, 'getDbMigrations');
        return res.body;
      }),
  );

  server.tool('lab_redis_info', 'Parsed Redis INFO plus DBSIZE and clients grouped by name/IP.', {}, () =>
    call(ctx, async (client) => {
      const res = await client.getRedisInfo({});
      failOnError(res, 'getRedisInfo');
      return res.body;
    }),
  );

  server.tool(
    'lab_redis_scan',
    'Cursor-based SCAN of Redis keys (never the blocking KEYS). Thread the returned cursor back to page.',
    {
      cursor: z.string().optional().describe('SCAN cursor; start at "0" (default)'),
      match: z.string().optional().describe('MATCH glob pattern (e.g. *:device:*)'),
      count: z.number().int().min(1).max(1000).optional().describe('SCAN COUNT hint per round (default 200)'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.scanRedisKeys({
          query: { cursor: args.cursor ?? '0', match: args.match, count: args.count ?? 200 },
        });
        failOnError(res, 'scanRedisKeys');
        return res.body;
      }),
  );

  server.tool(
    'lab_redis_get',
    'Read one Redis key: resolves type and TTL, reads with the matching cursor command (large collections capped).',
    {
      key: z.string().min(1).describe('Full key name'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getRedisValue({ query: { key: args.key } });
        failOnError(res, 'getRedisValue');
        return res.body;
      }),
  );

  server.tool(
    'lab_thanos_query',
    'Run a read-only instant PromQL query against the local Thanos stack.',
    {
      query: z.string().min(1).describe('PromQL expression'),
      time: z.string().optional().describe('Evaluation time (RFC3339 or unix seconds); defaults to now'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.queryThanos({ query: { query: args.query, time: args.time } });
        failOnError(res, 'queryThanos');
        return res.body;
      }),
  );

  server.tool(
    'lab_list_queues',
    'The hub/spoke BullMQ inventory (zone saga queues, results inbox, hub queues) with per-state counts, stalled sets, paused flags, and worker counts.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.listQueues({});
        failOnError(res, 'listQueues');
        return res.body;
      }),
  );

  server.tool(
    'lab_list_queue_jobs',
    'Jobs in one queue by state, or all jobs for one device. A full window sets "truncated" and is only the head of the queue; "delayed" is a normal in-flight state for a healthy saga, not a failure.',
    {
      ...queuePathShape,
      states: z.array(QueueJobStateSchema).optional().describe('States to read; omit for every state'),
      limit: z.number().int().min(1).max(200).optional().describe('Jobs per state (default 50, cap 200)'),
      offset: z.number().int().min(0).optional().describe('Index into each state list'),
      deviceId: z.string().uuid().optional().describe('Restrict to one device (UUID)'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.listQueueJobs({
          params: { prefix: args.prefix, name: args.name },
          query: {
            states: args.states?.join(','),
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
            deviceId: args.deviceId,
          },
        });
        failOnError(res, 'listQueueJobs');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_queue_job',
    'One queue job: timing, attempts, failure detail, and the redacted payload (a sealed zone job exposes only its cleartext AAD header).',
    {
      ...queuePathShape,
      jobId: z.string().min(1).describe('BullMQ job id within this queue (may contain ":")'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getQueueJob({
          params: { prefix: args.prefix, name: args.name, jobId: args.jobId },
        });
        failOnError(res, 'getQueueJob');
        return res.body;
      }),
  );

  server.tool(
    'lab_retry_queue_job',
    'Move a failed or completed job back onto the wait list, optionally zeroing its attempts counter. 409 if the job moved on since you read it.',
    {
      ...queuePathShape,
      jobId: z.string().min(1).describe('BullMQ job id'),
      state: z
        .enum(['failed', 'completed'])
        .optional()
        .describe('Finished state the job must still be in (default "failed")'),
      resetAttempts: z.boolean().optional().describe('Zero the attempts-made counter (default false)'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.retryQueueJob({
          params: { prefix: args.prefix, name: args.name, jobId: args.jobId },
          body: { state: args.state ?? 'failed', resetAttempts: args.resetAttempts ?? false },
        });
        failOnError(res, 'retryQueueJob');
        return res.body;
      }),
  );

  if (options.allowDestructive) {
    server.tool(
      'lab_drain_queue',
      'DESTRUCTIVE-gated: remove every wait/paused/prioritized job from one queue (delayed only when delayed=true). Active/completed/failed/waiting-children jobs are never touched.',
      {
        ...queuePathShape,
        delayed: z.boolean().optional().describe('Also remove the delayed set (default false)'),
      },
      (args) =>
        call(ctx, async (client) => {
          const res = await client.drainQueue({
            params: { prefix: args.prefix, name: args.name },
            body: { delayed: args.delayed ?? false },
          });
          failOnError(res, 'drainQueue');
          return res.body;
        }),
    );

    server.tool(
      'lab_clean_queue',
      'DESTRUCTIVE-gated: bulk-remove up to limit jobs of one cleanable state older than grace ms.',
      {
        ...queuePathShape,
        state: QueueCleanableStateSchema.describe('Which cleanable state to remove'),
        grace: z.number().int().min(0).optional().describe('Minimum age in ms (default 0 = any age)'),
        limit: z.number().int().min(1).max(10_000).optional().describe('Max jobs to remove (default 1000)'),
      },
      (args) =>
        call(ctx, async (client) => {
          const res = await client.cleanQueue({
            params: { prefix: args.prefix, name: args.name },
            body: { state: args.state, grace: args.grace ?? 0, limit: args.limit ?? 1000 },
          });
          failOnError(res, 'cleanQueue');
          return res.body;
        }),
    );

    server.tool(
      'lab_remove_queue_job',
      'DESTRUCTIVE-gated: delete one job, keeping its children. 409 for active jobs, parents with pending children, or scheduler occurrences.',
      {
        ...queuePathShape,
        jobId: z.string().min(1).describe('BullMQ job id'),
      },
      (args) =>
        call(ctx, async (client) => {
          const res = await client.removeQueueJob({
            params: { prefix: args.prefix, name: args.name, jobId: args.jobId },
          });
          failOnError(res, 'removeQueueJob');
          return res.body;
        }),
    );
  }
}
