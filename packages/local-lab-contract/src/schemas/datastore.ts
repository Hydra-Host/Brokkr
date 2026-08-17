import { z } from 'zod';
import { ErrorBodySchema } from './common';

export const PgTableSchema = z.object({
  schema: z.string().describe('Postgres schema (e.g. public)'),
  name: z.string().describe('Table name'),
  estRows: z.number().describe('Row count — exact COUNT(*) for tables/matviews, planner estimate for plain views'),
});
export type PgTable = z.infer<typeof PgTableSchema>;

export const PgColumnSchema = z.object({
  name: z.string(),
  type: z.string().describe('Postgres data type (format_type)'),
  nullable: z.boolean(),
  pk: z.boolean().describe('Part of the primary key'),
});
export type PgColumn = z.infer<typeof PgColumnSchema>;

export const PgResultSchema = z.object({
  columns: z
    .array(z.object({ name: z.string(), type: z.string() }))
    .describe('Result column names + pg type oids resolved to names'),
  rows: z.array(z.record(z.string(), z.unknown())).describe('Row objects keyed by column name'),
  rowCount: z.number().describe('Rows returned'),
  truncated: z.boolean().describe('More rows exist than were returned (limit hit)'),
});
export type PgResult = z.infer<typeof PgResultSchema>;

export const DbMigrationRowSchema = z.object({
  name: z.string().describe('Migration directory name, i.e. the _prisma_migrations.migration_name value'),
  startedAt: z.number().describe('When the migration began applying, as a unix epoch in milliseconds'),
  finishedAt: z
    .number()
    .nullable()
    .describe('When the migration finished applying (unix ms); null when it never completed'),
  rolledBackAt: z
    .number()
    .nullable()
    .describe('When the migration was rolled back (unix ms); null when it was not rolled back'),
});
export type DbMigrationRow = z.infer<typeof DbMigrationRowSchema>;

export const DbMigrationsSchema = z.object({
  tableExists: z
    .boolean()
    .describe('Whether _prisma_migrations exists; false is a fresh or nuked database with no schema applied yet'),
  applied: z.array(DbMigrationRowSchema).describe('Rows read from _prisma_migrations, ordered by start time'),
  onDisk: z
    .array(z.string())
    .describe('Migration directory names present in the repo checkout; empty when the on-disk side could not be read'),
  pending: z
    .array(z.string())
    .describe('On-disk migrations not cleanly applied yet — never applied, or previously rolled back'),
  missing: z.array(z.string()).describe('Migrations cleanly applied in the database but absent from the checkout'),
  failed: z.array(z.string()).describe('Migrations that started but neither finished nor were rolled back'),
  note: z
    .string()
    .optional()
    .describe('Degradation reason when the on-disk migration list could not be read (e.g. repo path unset)'),
});
export type DbMigrations = z.infer<typeof DbMigrationsSchema>;

export const RedisClientSchema = z.object({
  id: z.string().describe('Server-assigned client id (from CLIENT LIST id=)'),
  addr: z.string().describe('Client socket (ip:port)'),
  ageSeconds: z.number().describe('Seconds since connect'),
  idleSeconds: z.number().describe('Seconds since the connection last issued a command'),
  db: z.number().describe('Selected DB index'),
  cmd: z.string().describe('Most recent command name'),
});
export type RedisClient = z.infer<typeof RedisClientSchema>;

export const RedisClientGroupSchema = z.object({
  label: z.string().describe('Group key — CLIENT SETNAME if set, else lib-name (e.g. ioredis), else source IP'),
  count: z.number().int(),
  clients: z.array(RedisClientSchema),
});
export type RedisClientGroup = z.infer<typeof RedisClientGroupSchema>;

export const RedisInfoSchema = z.object({
  dbsize: z.number().describe('Number of keys in the selected DB (DBSIZE)'),
  server: z
    .record(z.string(), z.string())
    .describe('Selected fields from INFO (version, uptime, memory, ops/sec, hits/misses, …)'),
  clients: z
    .array(RedisClientGroupSchema)
    .describe('Connected clients grouped by name (or source IP). Empty if CLIENT LIST not permitted.'),
});
export type RedisInfo = z.infer<typeof RedisInfoSchema>;

export const RedisKeySchema = z.object({
  key: z.string(),
  type: z.string().describe('Redis type (string|hash|list|set|zset|stream|none)'),
});
export type RedisKey = z.infer<typeof RedisKeySchema>;

export const RedisScanSchema = z.object({
  cursor: z.string().describe('Next SCAN cursor; "0" = iteration complete'),
  keys: z.array(RedisKeySchema),
});
export type RedisScan = z.infer<typeof RedisScanSchema>;

export const RedisZsetMemberSchema = z.object({
  member: z.string().describe('Sorted-set member'),
  score: z.string().describe('Member score, string-encoded to preserve full precision'),
});
export type RedisZsetMember = z.infer<typeof RedisZsetMemberSchema>;

export const RedisStreamEntrySchema = z.object({
  id: z.string().describe('Stream entry id (millis-seq)'),
  fields: z.record(z.string(), z.string()).describe('Entry field→value pairs'),
});
export type RedisStreamEntry = z.infer<typeof RedisStreamEntrySchema>;

// Envelope fields common to every value variant; `kind` discriminates the shape of `value`.
const redisValueBase = {
  key: z.string().describe('The queried key'),
  type: z.string().describe('Redis type (string|hash|list|set|zset|stream|none)'),
  ttl: z.number().describe('TTL in seconds; -1 = no expiry, -2 = key missing'),
  truncated: z.boolean().describe('Collection larger than the fetch cap — only a prefix returned'),
  length: z.number().describe('Full element count (HLEN/LLEN/SCARD/ZCARD/XLEN); 1 for string, 0 when missing'),
};

// Discriminated on `kind` so `value` is typed to exactly what the lab reads per type (redis.service.ts).
export const RedisValueSchema = z.discriminatedUnion('kind', [
  z.object({
    ...redisValueBase,
    kind: z.literal('none').describe('Key does not exist'),
    value: z.null().describe('Always null for a missing key'),
  }),
  z.object({
    ...redisValueBase,
    kind: z.literal('string').describe('Plain string value'),
    value: z.string().nullable().describe('The string; null if the key vanished between the TYPE and GET'),
  }),
  z.object({
    ...redisValueBase,
    kind: z.literal('hash').describe('Hash'),
    value: z.record(z.string(), z.string()).describe('Field→value map (capped)'),
  }),
  z.object({
    ...redisValueBase,
    kind: z.literal('list').describe('List'),
    value: z.array(z.string()).describe('Elements in list order (capped)'),
  }),
  z.object({
    ...redisValueBase,
    kind: z.literal('set').describe('Set'),
    value: z.array(z.string()).describe('Members (capped, unordered)'),
  }),
  z.object({
    ...redisValueBase,
    kind: z.literal('zset').describe('Sorted set'),
    value: z.array(RedisZsetMemberSchema).describe('Members with scores, ascending (capped)'),
  }),
  z.object({
    ...redisValueBase,
    kind: z.literal('stream').describe('Stream'),
    value: z.array(RedisStreamEntrySchema).describe('Entries oldest-first (capped)'),
  }),
]);
export type RedisValue = z.infer<typeof RedisValueSchema>;

export const DatastoreError = ErrorBodySchema;

export const ThanosStoreSchema = z.object({
  name: z.string().describe('StoreAPI endpoint address (host:port)'),
  type: z.string().describe('Store component type (receive|store|sidecar|rule)'),
  minTime: z.string().describe('Human-readable earliest sample time the store advertises, or "—"'),
  maxTime: z.string().describe('Human-readable latest sample time the store advertises, or "—"'),
  lastError: z.string().nullable().describe('Last StoreAPI health-check error, if any'),
});
export type ThanosStore = z.infer<typeof ThanosStoreSchema>;

export const ThanosStatusSchema = z.object({
  version: z.string().describe('thanos query build version'),
  stores: z.array(ThanosStoreSchema).describe('StoreAPI endpoints the query layer is fanning out to'),
});
export type ThanosStatus = z.infer<typeof ThanosStatusSchema>;

export const ThanosSampleSchema = z.object({
  metric: z.record(z.string(), z.string()).describe('Series label set (includes __name__)'),
  value: z.string().describe('Sample value as returned by Prometheus (string-encoded float)'),
  timestamp: z.number().describe('Sample time (unix seconds); for matrix results this is the latest point'),
});
export type ThanosSample = z.infer<typeof ThanosSampleSchema>;

export const ThanosQueryResultSchema = z.object({
  resultType: z.enum(['vector', 'matrix', 'scalar', 'string']).describe('PromQL result type'),
  samples: z
    .array(ThanosSampleSchema)
    .describe('Flattened samples — one per series; matrix collapses to each series’ latest point'),
  warnings: z.array(z.string()).describe('Non-fatal query warnings from Thanos'),
});
export type ThanosQueryResult = z.infer<typeof ThanosQueryResultSchema>;

export const ThanosRangePointSchema = z.tuple([
  z.number().describe('Sample time (unix seconds)'),
  z.string().describe('Sample value (string-encoded float, full precision)'),
]);
export type ThanosRangePoint = z.infer<typeof ThanosRangePointSchema>;

export const ThanosRangeSeriesSchema = z.object({
  metric: z.record(z.string(), z.string()).describe('Series label set (includes __name__)'),
  points: z.array(ThanosRangePointSchema).describe('Samples in ascending time order at the requested step'),
});
export type ThanosRangeSeries = z.infer<typeof ThanosRangeSeriesSchema>;

export const ThanosRangeResultSchema = z.object({
  series: z.array(ThanosRangeSeriesSchema).describe('One entry per matrix series'),
  warnings: z.array(z.string()).describe('Non-fatal warnings from the Thanos evaluation'),
});
export type ThanosRangeResult = z.infer<typeof ThanosRangeResultSchema>;
