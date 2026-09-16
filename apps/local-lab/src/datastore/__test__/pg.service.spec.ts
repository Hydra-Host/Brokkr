import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';

const TokenRowSchema = z.object({ token: z.string() });

type ScriptedQuery = (
  arg: string | { text: string; values?: unknown[] },
) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number; tableID: number; columnID: number }[] }>;
type ScriptedClient = { query: Mock<ScriptedQuery>; release: Mock<() => void> };
type ScriptedPool = { connect: Mock<() => Promise<ScriptedClient>>; on: Mock<() => void>; end: Mock<() => void> };

const hp = vi.hoisted((): { client: ScriptedClient; pool: ScriptedPool } => ({
  client: { query: vi.fn(), release: vi.fn() },
  pool: { connect: vi.fn(), on: vi.fn(), end: vi.fn() },
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor() {
      return hp.pool;
    }
  },
  types: {
    builtins: { TIMESTAMP: 1114 },
    setTypeParser: () => {},
    getTypeParser: () => (value: string) => value,
  },
}));

import { assertReadOnlySql, BadInput, PgService } from '../pg.service';

type QueryArg = string | { text: string; values?: unknown[] };

type HandlerResult = { rows: Record<string, unknown>[]; fields?: { name: string; dataTypeID: number; tableID: number; columnID: number }[] };

const RELATIONS = new Map<number, { relname: string; columns: string[] }>([
  [16001, { relname: 'Device', columns: ['id', 'name', 'dsn', 'payload'] }],
  [16002, { relname: 'Verification', columns: ['id', 'identifier', 'value'] }],
  [16003, { relname: 'Session', columns: ['id', 'token'] }],
  [16004, { relname: 'apikey', columns: ['id', 'key'] }],
]);

const catalogTables = [
  ...[...RELATIONS.values()].map((r) => ({ schema: 'public', name: r.relname })),
  { schema: 'pg_catalog', name: 'pg_authid' },
];

const relationRows = (values: unknown[]): HandlerResult => {
  const oids = Array.isArray(values[0]) ? values[0] : [];
  const rows = oids.flatMap((oid) => {
    const rel = RELATIONS.get(Number(oid));
    return rel === undefined
      ? []
      : rel.columns.map((attname, i) => ({ reloid: oid, relname: rel.relname, attnum: i + 1, attname }));
  });
  return { rows };
};

const defaultHandler = (text: string, values: unknown[]): HandlerResult => {
  if (text.includes('c.oid AS reloid')) return relationRows(values);
  if (text.includes('pg_class') && text.includes('n.nspname NOT IN')) {
    const schema = String(values[0]);
    const name = String(values[1]);
    if (schema === 'pg_catalog' || schema === 'information_schema' || schema.startsWith('pg_toast')) {
      return { rows: [] };
    }
    const hit = catalogTables.find((t) => t.schema === schema && t.name === name);
    return { rows: hit ? [{ schema: hit.schema, name: hit.name }] : [] };
  }
  if (text.includes('pg_attribute')) {
    return { rows: [{ name: 'id', type: 'uuid', nullable: false, pk: true }] };
  }
  if (text.includes('pg_type')) {
    return { rows: [{ oid: 2950, name: 'uuid' }] };
  }
  if (text.trimStart().startsWith('SELECT * FROM')) {
    return { rows: [{ id: 'row-1' }], fields: [{ name: 'id', dataTypeID: 2950, tableID: 16001, columnID: 1 }] };
  }
  return { rows: [] };
};

function installScriptedPool(handler: (text: string, values: unknown[]) => HandlerResult = defaultHandler) {
  const query = vi.fn((arg: QueryArg) => {
    if (typeof arg === 'string') return Promise.resolve({ rows: [], fields: [] });
    const { rows, fields } = handler(arg.text, arg.values ?? []);
    return Promise.resolve({ rows, fields: fields ?? [] });
  });
  hp.client = { query, release: vi.fn() };
  hp.pool = { connect: vi.fn(() => Promise.resolve(hp.client)), on: vi.fn(), end: vi.fn() };
}

const queryTexts = (): string[] => hp.client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : c[0].text));

const resolveArg = (): { text: string; values?: unknown[] } | undefined => {
  for (const c of hp.client.query.mock.calls) {
    const arg = c[0];
    if (typeof arg !== 'string' && arg.text.includes("n.nspname NOT IN ('pg_catalog', 'information_schema')")) {
      return arg;
    }
  }
  return undefined;
};

describe('assertReadOnlySql', () => {
  it.each([
    'SELECT 1',
    'select * from device',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    '(SELECT 1)',
    'EXPLAIN SELECT 1',
    'SHOW search_path',
    'TABLE device',
    'VALUES (1), (2)',
    'SELECT 1;',
  ])('allows the read-only query: %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });

  it('rejects an empty / comment-only query', () => {
    expect(() => assertReadOnlySql('   ')).toThrow(BadInput);
    expect(() => assertReadOnlySql('-- just a comment')).toThrow(BadInput);
    expect(() => assertReadOnlySql('/* nothing */')).toThrow(BadInput);
  });

  it('rejects multiple statements but allows one trailing semicolon', () => {
    expect(() => assertReadOnlySql('SELECT 1; SELECT 2')).toThrow(/single statement/);
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE x')).toThrow(/single statement/);
  });

  it('strips -- and /* */ comments before classifying (keywords in comments are ignored)', () => {
    expect(() => assertReadOnlySql('/* leading */ SELECT 1')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT 1 -- trailing')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT 1 -- delete everything')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT 1 /* drop table x */')).not.toThrow();
  });

  it.each([
    'INSERT INTO x VALUES (1)',
    'UPDATE x SET a = 1',
    'DELETE FROM x',
    'DROP TABLE x',
    'CREATE TABLE x ()',
    'ALTER TABLE x ADD COLUMN y int',
    'TRUNCATE x',
    'GRANT ALL ON x TO y',
    'SET search_path = public',
    'BEGIN',
    'COPY x FROM stdin',
  ])('rejects the non-read-only statement: %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(BadInput);
  });

  it('rejects EXPLAIN ANALYZE (it executes the statement)', () => {
    expect(() => assertReadOnlySql('EXPLAIN ANALYZE SELECT 1')).toThrow(/ANALYZE/i);
  });

  it('rejects data-modifying CTEs', () => {
    expect(() => assertReadOnlySql('WITH w AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM w')).toThrow(
      /data-modifying/,
    );
  });

  it('rejects a forbidden keyword even behind an allowed SELECT lead', () => {
    expect(() => assertReadOnlySql('SELECT pg_sleep(10)')).toThrow(/forbidden/);
    expect(() => assertReadOnlySql("SELECT nextval('s')")).toThrow(/forbidden/);
  });

  it.each([
    "SELECT pg_read_file('/etc/passwd')",
    "select pg_read_file('/etc/passwd')",
    "SELECT PG_READ_FILE('/etc/passwd')",
    "SELECT pg_read_binary_file('/etc/passwd')",
    "SELECT pg_stat_file('/etc/passwd')",
    "SELECT pg_ls_dir('/etc')",
    "SELECT lo_import('/etc/passwd')",
    "SELECT lo_export(16384, '/tmp/out')",
  ])('rejects server-side file-read functions: %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(/forbidden/);
  });

  it('rejects a forbidden function nested inside a CTE subquery', () => {
    expect(() => assertReadOnlySql("WITH x AS (SELECT pg_read_file('/etc/passwd')) SELECT * FROM x")).toThrow(
      /forbidden/,
    );
  });

  it('still allows a plain SELECT on a table', () => {
    expect(() => assertReadOnlySql('SELECT id, name FROM device')).not.toThrow();
  });

  it('over-rejects forbidden keywords inside string literals / dollar-quotes (false positive, but safe)', () => {
    expect(() => assertReadOnlySql("SELECT 'insert' AS label")).toThrow(/forbidden/);
    expect(() => assertReadOnlySql('SELECT $$ drop $$ AS note')).toThrow(/forbidden/);
  });
});

describe('PgService table resolution', () => {
  beforeEach(() => {
    installScriptedPool();
  });

  it('resolves a table for getColumns via a parameterized catalog lookup, never query_to_xml', async () => {
    const columns = await new PgService().getColumns('public', 'Device');
    expect(columns).toEqual([{ name: 'id', type: 'uuid', nullable: false, pk: true }]);
    const arg = resolveArg();
    expect(arg).toBeDefined();
    expect(arg!.text).toContain('pg_class');
    expect(arg!.text).toContain("n.nspname NOT IN ('pg_catalog', 'information_schema')");
    expect(arg!.text).toContain("n.nspname NOT LIKE 'pg_toast%'");
    expect(arg!.values).toEqual(['public', 'Device']);
    expect(queryTexts().some((t) => t.includes('query_to_xml'))).toBe(false);
  });

  it('resolves a table for getRows via the parameterized lookup, never query_to_xml', async () => {
    const result = await new PgService().getRows('public', 'Device', { limit: 10, offset: 0, orderDir: 'asc' });
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.columns).toEqual([{ name: 'id', type: 'uuid' }]);
    expect(result.rows).toEqual([{ id: 'row-1' }]);
    const arg = resolveArg();
    expect(arg).toBeDefined();
    expect(arg!.values).toEqual(['public', 'Device']);
    expect(queryTexts().some((t) => t.includes('query_to_xml'))).toBe(false);
  });

  it('rejects an unknown table with the not-found error type', async () => {
    await expect(new PgService().getColumns('public', 'nope')).rejects.toBeInstanceOf(BadInput);
    await expect(new PgService().getColumns('public', 'nope')).rejects.toThrow(/unknown table/);
  });

  it('excludes pg_catalog so pg_authid resolves to not-found', async () => {
    await expect(new PgService().getColumns('pg_catalog', 'pg_authid')).rejects.toBeInstanceOf(BadInput);
  });
});

describe('PgService secret-column masking', () => {
  const rowsFrom = (
    row: Record<string, unknown>,
    fields: { name: string; dataTypeID: number; tableID: number; columnID: number }[],
  ): ((text: string, values: unknown[]) => HandlerResult) => {
    return (text, values) => {
      if (text.trimStart().startsWith('SELECT * FROM') || text.trimStart().startsWith('SELECT ')) {
        if (text.includes('pg_type') || text.includes('pg_class') || text.includes('pg_attribute')) {
          return defaultHandler(text, values);
        }
        return { rows: [row], fields };
      }
      return defaultHandler(text, values);
    };
  };

  const field = (name: string, tableID: number, columnID: number) => ({
    name,
    dataTypeID: 25,
    tableID,
    columnID,
  });

  it('masks a pinned column whose name reads as ordinary', async () => {
    installScriptedPool(
      rowsFrom({ id: 'v1', identifier: 'a@b.c', value: 'reset-token-plaintext' }, [
        field('id', 16002, 1),
        field('identifier', 16002, 2),
        field('value', 16002, 3),
      ]),
    );

    const result = await new PgService().getRows('public', 'Verification', { limit: 10, offset: 0, orderDir: 'asc' });

    expect(result.rows).toEqual([{ id: 'v1', identifier: 'a@b.c', value: '***' }]);
  });

  it('masks a secret-named column even when the source relation is unknown', async () => {
    installScriptedPool(rowsFrom({ label: 'x', session_token: 'raw' }, [field('label', 0, 0), field('session_token', 0, 0)]));

    const result = await new PgService().runQuery('SELECT label, session_token FROM whatever');

    expect(result.rows).toEqual([{ label: 'x', session_token: '***' }]);
  });

  it('masks a pinned column reached through an ad-hoc query, not just the table browser', async () => {
    installScriptedPool(rowsFrom({ id: 's1', token: 'raw' }, [field('id', 16003, 1), field('token', 16003, 2)]));

    const result = await new PgService().runQuery('SELECT id, token FROM "Session"');

    expect(result.rows).toEqual([{ id: 's1', token: '***' }]);
  });

  it('leaves a NULL secret column null rather than making unset read as hidden', async () => {
    installScriptedPool(rowsFrom({ id: 'v1', value: null }, [field('id', 16002, 1), field('value', 16002, 3)]));

    const result = await new PgService().getRows('public', 'Verification', { limit: 10, offset: 0, orderDir: 'asc' });

    expect(result.rows).toEqual([{ id: 'v1', value: null }]);
  });

  it('redacts credentials riding inside an ordinary column value', async () => {
    installScriptedPool(
      rowsFrom({ dsn: 'postgres://admin:hunter2@db:5432/brokkr', payload: { retries: 2, apiToken: 'raw' } }, [
        field('dsn', 16001, 3),
        field('payload', 16001, 4),
      ]),
    );

    const result = await new PgService().getRows('public', 'Device', { limit: 10, offset: 0, orderDir: 'asc' });

    expect(result.rows).toEqual([
      { dsn: 'postgres://***@db:5432/brokkr', payload: { retries: 2, apiToken: '***' } },
    ]);
  });

  it('leaves an ordinary column untouched', async () => {
    installScriptedPool(rowsFrom({ id: 'd1', name: 'gpu-1' }, [field('id', 16001, 1), field('name', 16001, 2)]));

    const result = await new PgService().getRows('public', 'Device', { limit: 10, offset: 0, orderDir: 'asc' });

    expect(result.rows).toEqual([{ id: 'd1', name: 'gpu-1' }]);
  });

  it('masks a pinned column hidden behind an alias', async () => {
    installScriptedPool(rowsFrom({ foo: 'sk-live-raw' }, [field('foo', 16004, 2)]));

    const result = await new PgService().runQuery('SELECT key AS foo FROM apikey');

    expect(result.rows).toEqual([{ foo: '***' }]);
  });

  it('masks an aliased verification value', async () => {
    installScriptedPool(rowsFrom({ x: 'reset-token-plaintext' }, [field('x', 16002, 3)]));

    const result = await new PgService().runQuery('SELECT value AS x FROM "Verification"');

    expect(result.rows).toEqual([{ x: '***' }]);
  });

  it('falls back to the output name for a computed column with no source relation', async () => {
    installScriptedPool(
      rowsFrom({ user_password: 'raw', row_count: 3 }, [field('user_password', 0, 0), field('row_count', 0, 0)]),
    );

    const result = await new PgService().runQuery('SELECT user_password, row_count FROM whatever');

    expect(result.rows).toEqual([{ user_password: '***', row_count: 3 }]);
  });

  it('leaves an ordinary aliased column untouched', async () => {
    installScriptedPool(rowsFrom({ label: 'gpu-1' }, [field('label', 16001, 2)]));

    const result = await new PgService().runQuery('SELECT name AS label FROM "Device"');

    expect(result.rows).toEqual([{ label: 'gpu-1' }]);
  });

  it('does not mask a readTyped domain read, which is schema-parsed rather than browsed', async () => {
    installScriptedPool(rowsFrom({ token: 'raw' }, [field('token', 16003, 2)]));

    const read = await new PgService().readTyped('SELECT token FROM "Session"', [], TokenRowSchema);

    expect(read.rows).toEqual([{ token: 'raw' }]);
  });
});

describe('PgService.devicesStatusByName', () => {
  const deviceRow = { id: 'd1', name: 'gpu-1', gpu_model: 'NVIDIA H100', lifecycle: 'provisioned' };

  it('reads the gpu model from the Gpu table, never a Device column', async () => {
    installScriptedPool((text) => (text.includes('FROM "Device"') ? { rows: [deviceRow] } : { rows: [] }));

    const read = await new PgService().devicesStatusByName(['gpu-1']);

    const sql = queryTexts().find((t) => t.includes('FROM "Device"')) ?? '';
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('FROM "Gpu" g');
    expect(sql).not.toContain('d."gpuModel"');
    expect(read).toEqual({
      byName: new Map([['gpu-1', { id: 'd1', lifecycleStatus: 'provisioned', gpuModel: 'NVIDIA H100' }]]),
      failed: false,
    });
  });

  it('reports the read as failed rather than answering an empty map', async () => {
    installScriptedPool();
    hp.client.query.mockImplementation((arg: QueryArg) => {
      const text = typeof arg === 'string' ? arg : arg.text;
      if (text.includes('FROM "Device"')) return Promise.reject(new Error('column d.gpuModel does not exist'));
      return Promise.resolve({ rows: [], fields: [] });
    });

    const read = await new PgService().devicesStatusByName(['gpu-1']);

    expect(read.failed).toBe(true);
    expect(read.byName.size).toBe(0);
  });

  it('answers a not-failed empty read for an empty name list without touching the pool', async () => {
    installScriptedPool();

    const read = await new PgService().devicesStatusByName([]);

    expect(read).toEqual({ byName: new Map(), failed: false });
    expect(hp.pool.connect).not.toHaveBeenCalled();
  });
});
