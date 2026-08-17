import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';

type QueryArg = string | { text: string; values?: unknown[] };
type QueryResult = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
type ScriptedClient = { query: Mock<(arg: QueryArg) => Promise<QueryResult>>; release: Mock<() => void> };
type ScriptedPool = { connect: Mock<() => Promise<ScriptedClient>>; on: Mock<() => void>; end: Mock<() => void> };

const hp = vi.hoisted((): { pool: ScriptedPool } => ({
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

import { PgService } from '../pg.service';

const RowSchema = z.object({ id: z.string().min(1), n: z.number() });

let calls: QueryArg[];

function installPool(rows: Record<string, unknown>[] | Error) {
  calls = [];
  const query = vi.fn((arg: QueryArg): Promise<QueryResult> => {
    calls.push(arg);
    const text = typeof arg === 'string' ? arg : arg.text;
    if (text.includes('FROM "Thing"')) {
      if (rows instanceof Error) return Promise.reject(rows);
      return Promise.resolve({ rows, fields: [] });
    }
    return Promise.resolve({ rows: [], fields: [] });
  });
  hp.pool = { connect: vi.fn(() => Promise.resolve({ query, release: vi.fn() })), on: vi.fn(), end: vi.fn() };
}

const SQL = 'SELECT id, n FROM "Thing" WHERE id = $1';
const service = () => new PgService();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PgService.readTyped', () => {
  it('parses rows through the schema', async () => {
    installPool([{ id: 'a', n: 1 }]);

    await expect(service().readTyped(SQL, ['a'], RowSchema)).resolves.toEqual({
      rows: [{ id: 'a', n: 1 }],
      skipped: 0,
    });
  });

  it('binds values rather than splicing them into the statement', async () => {
    installPool([]);

    await service().readTyped(SQL, ['\'; DROP TABLE "Thing"; --'], RowSchema);

    const call = calls.find((arg) => typeof arg !== 'string' && arg.text.includes('FROM "Thing"'));
    if (!call || typeof call === 'string') throw new Error('the domain query was not issued as a bound statement');
    expect(call.text).toBe(SQL);
    expect(call.values).toEqual(['\'; DROP TABLE "Thing"; --']);
    expect(call.text).not.toContain('DROP TABLE');
  });

  it('runs inside the read-only transaction with a statement timeout', async () => {
    installPool([{ id: 'a', n: 1 }]);

    await service().readTyped(SQL, ['a'], RowSchema);

    const texts = calls.map((arg) => (typeof arg === 'string' ? arg : arg.text));
    expect(texts).toContain('BEGIN TRANSACTION READ ONLY');
    expect(texts.some((text) => text.startsWith('SET LOCAL statement_timeout'))).toBe(true);
    expect(texts).toContain('ROLLBACK');
  });

  it('counts a row that does not fit the schema rather than dropping it silently', async () => {
    installPool([{ id: 'a', n: 1 }, { id: '', n: 2 }, { id: 'c' }]);

    await expect(service().readTyped(SQL, [], RowSchema)).resolves.toEqual({
      rows: [{ id: 'a', n: 1 }],
      skipped: 2,
    });
  });

  it('normalizes a bigint so the row survives json serialization', async () => {
    installPool([{ id: 'a', n: 1, big: 9007199254740993n }]);
    const WithBig = RowSchema.extend({ big: z.string() });

    const read = await service().readTyped(SQL, [], WithBig);

    expect(read.rows[0].big).toBe('9007199254740993');
  });

  it('lets a query failure propagate so the caller decides how to degrade', async () => {
    installPool(new Error('pg down'));

    await expect(service().readTyped(SQL, ['a'], RowSchema)).rejects.toThrow('pg down');
  });

  it('rolls the transaction back even when the query throws', async () => {
    installPool(new Error('pg down'));

    await expect(service().readTyped(SQL, ['a'], RowSchema)).rejects.toThrow();

    const texts = calls.map((arg) => (typeof arg === 'string' ? arg : arg.text));
    expect(texts).toContain('ROLLBACK');
  });
});
