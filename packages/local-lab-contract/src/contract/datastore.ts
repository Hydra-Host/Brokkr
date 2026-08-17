import { z } from 'zod';
import {
  DatastoreError,
  DbMigrationsSchema,
  PgColumnSchema,
  PgResultSchema,
  PgTableSchema,
  RedisInfoSchema,
  RedisScanSchema,
  RedisValueSchema,
  ThanosQueryResultSchema,
  ThanosRangeResultSchema,
  ThanosStatusSchema,
} from '../schemas/datastore';

export const datastoreRoutes = {
  listPgTables: {
    method: 'GET',
    path: '/api/datastore/pg/tables',
    responses: { 200: z.array(PgTableSchema), 500: DatastoreError },
    summary: 'List Postgres tables',
    description:
      'Lists user tables in non-system schemas, returning schema, name, and exact row count (estimate for plain views). Read-only.',
  },
  getPgColumns: {
    method: 'GET',
    path: '/api/datastore/pg/tables/:schema/:table/columns',
    responses: { 200: z.array(PgColumnSchema), 400: DatastoreError, 500: DatastoreError },
    summary: "List a table's columns",
    description:
      'Returns each column with its name, type, nullable, and primary-key flag; resolves the table against the live table list (allowlist) before quoting identifiers. Read-only.',
  },
  getPgRows: {
    method: 'GET',
    path: '/api/datastore/pg/tables/:schema/:table/rows',
    query: z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      orderBy: z.string().optional().describe('Column name to ORDER BY (validated against the column allowlist)'),
      orderDir: z.enum(['asc', 'desc']).default('asc'),
    }),
    responses: { 200: PgResultSchema, 400: DatastoreError, 500: DatastoreError },
    summary: 'Get paginated table rows',
    description:
      'Identifiers validated against the live table + column allowlist; runs in BEGIN TRANSACTION READ ONLY with a statement timeout.',
  },
  runPgQuery: {
    method: 'POST',
    path: '/api/datastore/pg/query',
    body: z.object({
      sql: z.string().describe('A single read-only statement: SELECT / WITH…SELECT / EXPLAIN / SHOW'),
    }),
    responses: { 200: PgResultSchema, 400: DatastoreError, 500: DatastoreError },
    summary: 'Run a read-only SQL query',
    description:
      'Guarded: rejects multiple statements and anything but SELECT/WITH/EXPLAIN/SHOW (no INSERT/UPDATE/DELETE/DDL). Executed inside BEGIN TRANSACTION READ ONLY with a statement timeout, so even a guard miss cannot write. Loopback-only (it is raw SQL against the hub database): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getDbMigrations: {
    method: 'GET',
    path: '/api/datastore/pg/migrations',
    responses: { 200: DbMigrationsSchema, 500: DatastoreError },
    summary: 'Get hub DB migration status',
    description:
      'Compares the _prisma_migrations table against the on-disk Prisma migrations in the repo checkout, returning the applied rows plus pending/missing/failed diffs. Read-only.',
  },
  getRedisInfo: {
    method: 'GET',
    path: '/api/datastore/redis/info',
    responses: { 200: RedisInfoSchema, 500: DatastoreError },
    summary: 'Get Redis server info',
    description:
      'Parses the raw Redis INFO output into typed fields and adds DBSIZE plus clients grouped by name/IP, so the explorer shows structured health rather than a raw text blob.',
  },
  scanRedisKeys: {
    method: 'GET',
    path: '/api/datastore/redis/keys',
    query: z.object({
      cursor: z.string().default('0').describe('SCAN cursor; start at "0"'),
      match: z.string().optional().describe('MATCH glob pattern (e.g. *:device:*)'),
      count: z.coerce.number().int().min(1).max(1000).default(200).describe('SCAN COUNT hint per round'),
    }),
    responses: { 200: RedisScanSchema, 500: DatastoreError },
    summary: 'Scan Redis keys',
    description:
      'Uses cursor-based SCAN (never the blocking KEYS) so key discovery is safe on a live datastore; thread the returned cursor back to page through results.',
  },
  getRedisValue: {
    method: 'GET',
    path: '/api/datastore/redis/value',
    query: z.object({ key: z.string().describe('Full key name') }),
    responses: { 200: RedisValueSchema, 500: DatastoreError },
    summary: 'Get a Redis key value',
    description:
      'Resolves the key type and TTL and reads its value with the matching cursor command (HSCAN/SSCAN/ZSCAN), capping large collections so inspecting a big hash/set/zset cannot stall the datastore.',
  },
  getThanosStatus: {
    method: 'GET',
    path: '/api/datastore/thanos/status',
    responses: { 200: ThanosStatusSchema, 500: DatastoreError },
    summary: 'Datastore Explorer: Thanos query build version and connected StoreAPIs. Read-only.',
    description:
      'Reads the query layer build info and its /stores fan-out targets so the explorer shows structured metrics health rather than a raw text blob. The metric-name count is derived client-side from the metrics list.',
  },
  listThanosMetrics: {
    method: 'GET',
    path: '/api/datastore/thanos/metrics',
    query: z.object({
      match: z.string().optional().describe('Substring filter applied to metric names (case-insensitive)'),
    }),
    responses: {
      200: z.array(z.string()).describe('Distinct metric names (__name__ values), sorted'),
      500: DatastoreError,
    },
    summary: 'Datastore Explorer: list distinct Thanos metric names (__name__ label values). Read-only.',
    description:
      'Fetches the __name__ label values from the Thanos query layer, optionally narrowed by a case-insensitive substring, so the browser can present a searchable metric catalog.',
  },
  queryThanos: {
    method: 'GET',
    path: '/api/datastore/thanos/query',
    query: z.object({
      query: z.string().describe('A PromQL expression to evaluate as an instant query'),
      time: z.string().optional().describe('Evaluation time (RFC3339 or unix seconds); defaults to now'),
    }),
    responses: { 200: ThanosQueryResultSchema, 400: DatastoreError, 500: DatastoreError },
    summary: 'Datastore Explorer: run a read-only instant PromQL query against Thanos. Read-only.',
    description:
      'Evaluates a single instant PromQL query via the Thanos query HTTP API and flattens the vector/matrix/scalar result into a uniform sample list for tabular display. Read-only by construction (PromQL cannot mutate).',
  },
  queryThanosRange: {
    method: 'GET',
    path: '/api/datastore/thanos/query_range',
    query: z.object({
      query: z.string().describe('A PromQL expression to evaluate over the range'),
      start: z.string().describe('Range start (RFC3339 or unix seconds), passed through to Thanos'),
      end: z.string().describe('Range end (RFC3339 or unix seconds), passed through to Thanos'),
      step: z.string().describe('Resolution step — plain seconds ("30") or a duration with an s/m/h/d suffix ("5m")'),
    }),
    responses: { 200: ThanosRangeResultSchema, 400: DatastoreError, 500: DatastoreError },
    summary: 'Datastore Explorer: run a read-only range PromQL query against Thanos. Read-only.',
    description:
      'Evaluates a PromQL expression over [start, end] at the given step via the Thanos query_range HTTP API, returning every matrix series with its full point list for charting. Windows exceeding the 11,000-point resolution cap are rejected with a 400.',
  },
} as const;
