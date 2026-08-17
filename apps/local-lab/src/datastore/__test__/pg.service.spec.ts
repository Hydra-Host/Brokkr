import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type ScriptedQuery = (
  arg: string | { text: string; values?: unknown[] },
) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] }>;
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

type HandlerResult = { rows: Record<string, unknown>[]; fields?: { name: string; dataTypeID: number }[] };

const catalogTables = [
  { schema: 'public', name: 'Device' },
  { schema: 'pg_catalog', name: 'pg_authid' },
];

const defaultHandler = (text: string, values: unknown[]): HandlerResult => {
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
    return { rows: [{ id: 'row-1' }], fields: [{ name: 'id', dataTypeID: 2950 }] };
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
