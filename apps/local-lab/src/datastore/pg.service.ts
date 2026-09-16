import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, types } from 'pg';
import type { z } from 'zod';

import { getErrorMessage } from '@repo/utils';
import { type LenientRead, readRows } from '../common/lenient-rows';
import { isSecretKey, maskEmbeddedDsns, REDACTED, redactPayload } from '../common/redact';
import type { DbMigrationRow, PgColumn, PgResult, PgTable } from '../contract';
import { resolvePgUrl } from '../ports';

export interface DeviceStatusRow {
  id: string;
  lifecycleStatus: string | null;
  gpuModel: string | null;
}

/** `failed` is not the same as an empty map: a fleet whose devices the hub has not seeded and a read
 *  that threw both return no rows, and only the second must not read as a measurement. */
export interface DevicesStatusRead {
  byName: Map<string, DeviceStatusRow>;
  failed: boolean;
}

interface PgFieldMeta {
  name: string;
  dataTypeID: number;
  tableID: number;
  columnID: number;
}

/** Credentials the shared key heuristic cannot see because the column reads as ordinary — an api key
 *  stored as `value`, a sealed envelope as `ciphertext`. Keyed by the name Postgres holds. */
const SECRET_COLUMNS_BY_TABLE = new Map<string, ReadonlySet<string>>([
  ['Account', new Set(['accessToken', 'refreshToken', 'idToken', 'password'])],
  ['apikey', new Set(['key'])],
  ['DeviceSecret', new Set(['ciphertext', 'ephPub', 'tag'])],
  ['DeviceToken', new Set(['tokenHash'])],
  ['OrganizationApiKey', new Set(['value'])],
  ['Session', new Set(['token'])],
  ['SshKeys', new Set(['key'])],
  ['TwoFactor', new Set(['secret', 'backupCodes'])],
  ['Verification', new Set(['value'])],
  ['Webhook', new Set(['secret'])],
  ['ZoneRedisCredential', new Set(['passwordHash'])],
  ['ZoneRegistrationToken', new Set(['tokenHash'])],
]);

function isSecretColumn(table: string | undefined, column: string): boolean {
  if (isSecretKey(column)) return true;
  if (table === undefined) return false;
  return SECRET_COLUMNS_BY_TABLE.get(table)?.has(column) === true;
}

// Prisma writes naive timestamp columns in UTC, but node-postgres parses them in the process's
// local zone — so every stamp read here lands offset by that zone unless the parser is told.
types.setTypeParser(types.builtins.TIMESTAMP, (value) => new Date(`${value.replace(' ', 'T')}Z`));

@Injectable()
export class PgService implements OnModuleDestroy {
  private readonly url = resolvePgUrl();

  private pool?: Pool;
  private readonly log = new Logger(PgService.name);

  private static readonly STATEMENT_TIMEOUT_MS = 15_000;

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.url, max: 4, connectionTimeoutMillis: 5_000 });
      // node-pg crashes the process on unhandled idle-client errors; swallow so the pool reconnects.
      this.pool.on('error', (err) => this.log.warn(`idle pg client error (recovering): ${err.message}`));
    }
    return this.pool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private static quoteIdent(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }

  private async readTx<T>(
    fn: (
      run: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; fields: PgFieldMeta[] }>,
    ) => Promise<T>,
  ): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${PgService.STATEMENT_TIMEOUT_MS}`);
      const run = async (sql: string, params?: unknown[]) => {
        const res = await client.query<Record<string, unknown>>({ text: sql, values: params });
        return {
          rows: res.rows,
          fields: res.fields.map((f) => ({
            name: f.name,
            dataTypeID: f.dataTypeID,
            tableID: f.tableID,
            columnID: f.columnID,
          })),
        };
      };
      const out = await fn(run);
      await client.query('ROLLBACK');
      return out;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (error) {
        this.log.debug(`rollback failed: ${(error as Error).message}`);
      }
      throw e;
    } finally {
      client.release();
    }
  }

  private async resolveTypeNames(
    run: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
    oids: number[],
  ): Promise<Map<number, string>> {
    const uniq = [...new Set(oids)];
    const map = new Map<number, string>();
    if (uniq.length === 0) return map;
    const { rows } = await run('SELECT oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1)', [uniq]);
    for (const r of rows) map.set(Number(r.oid), String(r.name));
    return map;
  }

  /** Which of these result columns must never leave the box. The pin is tested against the SOURCE
   *  attribute pg names per field, never the output name — an alias must not walk a secret past it. */
  private async secretFieldNames(
    run: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
    fields: PgFieldMeta[],
  ): Promise<Set<string>> {
    // 0 is pg's "computed, no source relation" — the output name is the only signal left there
    const oids = [...new Set(fields.map((f) => f.tableID).filter((oid) => Number.isInteger(oid) && oid > 0))];
    const relNames = new Map<number, string>();
    const attNames = new Map<string, string>();
    if (oids.length > 0) {
      const { rows } = await run(
        `SELECT c.oid AS reloid, c.relname, a.attnum, a.attname
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          WHERE c.oid = ANY($1)`,
        [oids],
      );
      for (const r of rows) {
        const reloid = Number(r.reloid);
        relNames.set(reloid, String(r.relname));
        attNames.set(`${reloid}:${Number(r.attnum)}`, String(r.attname));
      }
    }
    const secret = new Set<string>();
    for (const f of fields) {
      // an alias that itself reads as secret is masked too — over-masking is free, under-masking is not
      const source = attNames.get(`${f.tableID}:${f.columnID}`) ?? f.name;
      if (isSecretKey(f.name) || isSecretColumn(relNames.get(f.tableID), source)) secret.add(f.name);
    }
    return secret;
  }

  async listTables(): Promise<PgTable[]> {
    return this.readTx(async (run) => {
      const { rows } = await run(
        `SELECT n.nspname AS schema, c.relname AS name,
                CASE WHEN c.relkind IN ('r', 'p', 'm')
                  THEN (xpath('/row/c/text()',
                              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                                           false, true, '')))[1]::text::bigint
                  ELSE GREATEST(c.reltuples, 0)::bigint
                END AS est_rows
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'm', 'v')
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg_toast%'
          ORDER BY n.nspname, c.relname`,
      );
      return rows.map((r) => ({ schema: String(r.schema), name: String(r.name), estRows: Number(r.est_rows) }));
    });
  }

  private async resolveTable(schema: string, table: string): Promise<{ schema: string; name: string } | null> {
    return this.readTx(async (run) => {
      const { rows } = await run(
        `SELECT n.nspname AS schema, c.relname AS name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2
            AND c.relkind IN ('r', 'p', 'm', 'v')
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg_toast%'`,
        [schema, table],
      );
      if (!rows.length) return null;
      return { schema: String(rows[0].schema), name: String(rows[0].name) };
    });
  }

  async getColumns(schema: string, table: string): Promise<PgColumn[]> {
    const resolved = await this.resolveTable(schema, table);
    if (!resolved) throw new BadInput(`unknown table ${schema}.${table}`);
    return this.readTx(async (run) => {
      const { rows } = await run(
        `SELECT a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type,
                NOT a.attnotnull AS nullable,
                COALESCE(pk.is_pk, false) AS pk
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN (
             SELECT a2.attname, true AS is_pk
               FROM pg_index i
               JOIN pg_attribute a2 ON a2.attrelid = i.indrelid AND a2.attnum = ANY(i.indkey)
              WHERE i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND i.indisprimary
           ) pk ON pk.attname = a.attname
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [resolved.schema, resolved.name],
      );
      return rows.map((r) => ({ name: String(r.name), type: String(r.type), nullable: !!r.nullable, pk: !!r.pk }));
    });
  }

  async getRows(
    schema: string,
    table: string,
    opts: { limit: number; offset: number; orderBy?: string; orderDir: 'asc' | 'desc' },
  ): Promise<PgResult> {
    const resolved = await this.resolveTable(schema, table);
    if (!resolved) throw new BadInput(`unknown table ${schema}.${table}`);
    const columns = await this.getColumns(schema, table);
    if (opts.orderBy && !columns.some((c) => c.name === opts.orderBy)) {
      throw new BadInput(`unknown column ${opts.orderBy} on ${schema}.${table}`);
    }
    const qualified = `${PgService.quoteIdent(resolved.schema)}.${PgService.quoteIdent(resolved.name)}`;
    const orderClause = opts.orderBy
      ? ` ORDER BY ${PgService.quoteIdent(opts.orderBy)} ${opts.orderDir === 'desc' ? 'DESC' : 'ASC'}`
      : '';
    const sql = `SELECT * FROM ${qualified}${orderClause} LIMIT $1 OFFSET $2`;
    return this.readTx(async (run) => {
      const { rows, fields } = await run(sql, [opts.limit + 1, opts.offset]);
      const truncated = rows.length > opts.limit;
      const page = truncated ? rows.slice(0, opts.limit) : rows;
      const typeNames = await this.resolveTypeNames(
        run,
        fields.map((f) => f.dataTypeID),
      );
      const secret = await this.secretFieldNames(run, fields);
      return {
        columns: fields.map((f) => ({ name: f.name, type: typeNames.get(f.dataTypeID) ?? `oid:${f.dataTypeID}` })),
        rows: page.map((r) => normalizeRow(r, secret)),
        rowCount: page.length,
        truncated,
      };
    });
  }

  async probe(): Promise<boolean> {
    try {
      await this.readTx((run) => run('SELECT 1'));
      return true;
    } catch {
      return false;
    }
  }

  async getStorageLayouts(deviceId: string): Promise<Record<string, unknown> | null> {
    try {
      const rows = await this.readTx(async (run) => {
        const res = await run('SELECT "storageLayouts" FROM "Server" WHERE "deviceId" = $1', [deviceId]);
        return res.rows;
      });
      if (!rows.length || !rows[0].storageLayouts) return null;
      const val = rows[0].storageLayouts;
      return typeof val === 'string' ? JSON.parse(val) : val;
    } catch (e) {
      this.log.warn(`getStorageLayouts(${deviceId}) failed: ${getErrorMessage(e)}`);
      return null;
    }
  }

  /** A device can hold several GPUs, so the lateral picks the lowest-indexed one as the representative
   *  model. There is no denormalized column on Device — selecting one fails the whole statement. */
  async devicesStatusByName(names: string[]): Promise<DevicesStatusRead> {
    const byName = new Map<string, DeviceStatusRow>();
    if (names.length === 0) return { byName, failed: false };
    try {
      const rows = await this.readTx(async (run) => {
        const res = await run(
          `SELECT d.id, d.name, gpu.model AS gpu_model, s."lifecycleStatus" AS lifecycle
             FROM "Device" d
             LEFT JOIN "Server" s ON s."deviceId" = d.id
             LEFT JOIN LATERAL (
               SELECT g.model FROM "Gpu" g WHERE g."deviceId" = d.id ORDER BY g."index" LIMIT 1
             ) gpu ON TRUE
            WHERE d.name = ANY($1)`,
          [names],
        );
        return res.rows;
      });
      for (const r of rows) {
        byName.set(String(r.name), {
          id: String(r.id),
          lifecycleStatus: r.lifecycle == null ? null : String(r.lifecycle),
          gpuModel: r.gpu_model == null ? null : String(r.gpu_model),
        });
      }
    } catch (e) {
      this.log.error(`devicesStatusByName failed: ${getErrorMessage(e)}`);
      return { byName: new Map(), failed: true };
    }
    return { byName, failed: false };
  }

  /** Typed read for a domain query. The sql is always a module constant in our own code and every
   *  value is bound, so a caller filter can never be spliced into the statement. */
  async readTyped<T>(
    sql: string,
    params: unknown[],
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<LenientRead<T>> {
    const rows = await this.readTx(async (run) => (await run(sql, params)).rows);
    return readRows(
      schema,
      rows.map((r) => normalizeRow(r)),
    );
  }

  async runQuery(sql: string): Promise<PgResult> {
    assertReadOnlySql(sql);
    return this.readTx(async (run) => {
      const { rows, fields } = await run(sql);
      const typeNames = await this.resolveTypeNames(
        run,
        fields.map((f) => f.dataTypeID),
      );
      const secret = await this.secretFieldNames(run, fields);
      return {
        columns: fields.map((f) => ({ name: f.name, type: typeNames.get(f.dataTypeID) ?? `oid:${f.dataTypeID}` })),
        rows: rows.map((r) => normalizeRow(r, secret)),
        rowCount: rows.length,
        truncated: false,
      };
    });
  }

  async listAppliedMigrations(): Promise<{ tableExists: boolean; applied: DbMigrationRow[] }> {
    return this.readTx(async (run) => {
      const probe = await run(`SELECT to_regclass('public._prisma_migrations') AS reg`);
      if (!probe.rows.length || probe.rows[0].reg == null) return { tableExists: false, applied: [] };
      const { rows } = await run(
        `SELECT migration_name, started_at, finished_at, rolled_back_at
           FROM public._prisma_migrations
          ORDER BY started_at`,
      );
      const applied = rows.map((r) => ({
        name: String(r.migration_name),
        startedAt: toUnixMs(r.started_at) ?? 0,
        finishedAt: toUnixMs(r.finished_at),
        rolledBackAt: toUnixMs(r.rolled_back_at),
      }));
      return { tableExists: true, applied };
    });
  }
}

function toUnixMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export class BadInput extends BadRequestException {}

function normalizeRow(row: Record<string, unknown>, secret?: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    // NULL stays NULL: masking it would make "unset" and "hidden" read the same
    if (secret?.has(k) && v !== null && v !== undefined) out[k] = REDACTED;
    else if (typeof v === 'bigint') out[k] = v.toString();
    else if (Buffer.isBuffer(v)) out[k] = `\\x${v.toString('hex')}`;
    else if (secret !== undefined) out[k] = maskCell(v);
    else out[k] = v;
  }
  return out;
}

/** A credential also rides in the VALUE under an ordinary column — a dsn in a config string, a token
 *  under a secret-named key of a jsonb payload. Only the browser paths pass a mask. */
function maskCell(value: unknown): unknown {
  if (typeof value === 'string') return maskEmbeddedDsns(value);
  // json/jsonb arrives as a plain value; a Date or any other class instance must pass through whole
  if (Array.isArray(value) || (value !== null && typeof value === 'object' && hasPlainPrototype(value))) {
    return redactPayload(value);
  }
  return value;
}

const hasPlainPrototype = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export function assertReadOnlySql(raw: string): void {
  const noComments = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const sql = noComments.trim().replace(/\s+/g, ' ');
  if (!sql) throw new BadInput('empty query');

  const body = sql.replace(/;\s*$/, '');
  if (body.includes(';')) throw new BadInput('only a single statement is allowed');

  const first = (body.match(/^\(*\s*([a-zA-Z]+)/)?.[1] ?? '').toLowerCase();
  const allowedLeads = new Set(['select', 'with', 'explain', 'show', 'table', 'values']);
  if (!allowedLeads.has(first)) {
    throw new BadInput(
      `only read-only queries are allowed (SELECT / WITH…SELECT / EXPLAIN / SHOW); got "${first || '?'}"`,
    );
  }

  if (first === 'explain' && /\banalyze\b/i.test(body)) {
    throw new BadInput('EXPLAIN ANALYZE is not allowed (it executes the statement)');
  }

  if (first === 'with' && /\bwith\b[\s\S]*\b(insert|update|delete|merge)\b/i.test(body)) {
    throw new BadInput('data-modifying CTEs are not allowed');
  }

  const forbidden =
    /\b(insert|update|delete|merge|upsert|truncate|drop|create|alter|grant|revoke|copy|call|do|vacuum|analyze|refresh|reindex|cluster|comment|lock|set|reset|begin|start|commit|rollback|savepoint|prepare|execute|deallocate|listen|notify|discard|import|attach|detach|nextval|setval|pg_sleep|dblink|pg_read_file|pg_read_binary_file|pg_stat_file|pg_ls_dir|lo_import|lo_export)\b/i;
  if (forbidden.test(body)) {
    const hit = body.match(forbidden)?.[1]?.toLowerCase();
    throw new BadInput(`forbidden keyword "${hit}" — only read-only queries are allowed`);
  }
}
