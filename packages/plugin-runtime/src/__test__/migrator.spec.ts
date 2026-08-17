import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginManifest } from '@hydrahost/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


const h = vi.hoisted(() => {
  const query = vi.fn();
  const fakeClient = { query, connect: vi.fn(), end: vi.fn() };
  return {
    query,
    fakeClient,
    ClientCtor: vi.fn(function () {
      return fakeClient;
    }),
  };
});
vi.mock('pg', () => ({ Client: h.ClientCtor }));

import { PluginMigrator } from '../migrator';

let appliedRows: Array<{ version: string; checksum: string }> = [];
const tmpDirs: string[] = [];

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugmig-'));
  tmpDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

function manifest(over: Partial<PluginManifest> & { migrationsDir?: string } = {}): PluginManifest {
  return {
    id: 'demo',
    schemaName: 'demo_plugin',
    migrationsDir: tmpDirs[tmpDirs.length - 1],
    ...over,
  } as PluginManifest;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sqls = () => h.query.mock.calls.map((c) => c[0] as unknown).filter((s): s is string => typeof s === 'string');

const migrator = () => new PluginMigrator('postgres://test', { log: vi.fn(), warn: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  appliedRows = [];
  h.query.mockImplementation((sql: unknown) =>
    typeof sql === 'string' && sql.includes('SELECT version, checksum')
      ? Promise.resolve({ rows: appliedRows })
      : Promise.resolve({ rows: [] }),
  );
});
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('PluginMigrator.applyAll — connection gating', () => {
  it('never opens a DB connection when no manifest is stateful', async () => {
    await migrator().applyAll([{ id: 'stateless' } as PluginManifest]);
    expect(h.ClientCtor).not.toHaveBeenCalled();
  });
});

describe('PluginMigrator — schemaName allowlist (injection guard for the unparameterized CREATE SCHEMA)', () => {
  it.each(['public; DROP SCHEMA x', 'x"y', '1leadingdigit', 'Has-Caps', 'with space', ''])(
    'rejects adversarial schemaName %j before issuing any query',
    async (schemaName) => {
      migrationsDir({ '0001_init.sql': 'CREATE TABLE demo_plugin.t (id int);' });
      await expect(migrator().applyAll([manifest({ schemaName })])).rejects.toThrow(/invalid schemaName|stateless/i);
      expect(sqls().some((s) => s.includes('CREATE SCHEMA'))).toBe(false);
    },
  );

  it('accepts a valid snake_case schemaName and creates the schema', async () => {
    migrationsDir({ '0001_init.sql': 'CREATE TABLE demo_plugin.t (id int);' });
    await migrator().applyAll([manifest({ schemaName: 'demo_plugin' })]);
    expect(sqls().some((s) => s.includes('CREATE SCHEMA IF NOT EXISTS "demo_plugin"'))).toBe(true);
  });
});

describe('PluginMigrator — filename validation + ordering', () => {
  it('rejects a filename that is not NNNN_name.sql', async () => {
    migrationsDir({ 'no-version.sql': 'SELECT 1;' });
    await expect(migrator().applyAll([manifest()])).rejects.toThrow(/invalid migration filename/i);
  });

  it('rejects .down.sql files as invalid filenames (migrations are forward-only)', async () => {
    migrationsDir({ '0001_up.sql': 'SELECT 1;', '0001_up.down.sql': 'DROP TABLE x;' });
    await expect(migrator().applyAll([manifest()])).rejects.toThrow(/invalid migration filename/i);
    expect(sqls()).not.toContain('DROP TABLE x;');
  });

  it('applies migrations in BigInt version order, even above Number.MAX_SAFE_INTEGER', async () => {
    migrationsDir({
      '0002_b.sql': '-- b',
      '0001_a.sql': '-- a',
      '30000000000000000000_c.sql': '-- c',
    });
    await migrator().applyAll([manifest()]);
    const order = sqls().filter((s) => s.startsWith('-- '));
    expect(order).toEqual(['-- a', '-- b', '-- c']);
  });
});

describe('PluginMigrator — checksum + idempotency + rollback', () => {
  it('applies a fresh migration inside BEGIN/COMMIT and records it', async () => {
    const body = 'CREATE TABLE demo_plugin.t (id int);';
    migrationsDir({ '0001_init.sql': body });
    await migrator().applyAll([manifest()]);
    const s = sqls();
    expect(s).toContain('BEGIN');
    expect(s).toContain(body);
    expect(s.some((q) => q.includes('INSERT INTO _brokkr_plugin_migrations'))).toBe(true);
    expect(s).toContain('COMMIT');
    expect(s).not.toContain('ROLLBACK');
  });

  it('skips an already-applied migration whose recorded checksum matches (idempotent re-apply)', async () => {
    const body = 'CREATE TABLE demo_plugin.t (id int);';
    migrationsDir({ '0001_init.sql': body });
    appliedRows = [{ version: '0001', checksum: sha(body) }];
    await migrator().applyAll([manifest()]);
    const s = sqls();
    expect(s).not.toContain('BEGIN');
    expect(s).not.toContain(body);
  });

  it('rejects a migration whose file changed after being applied (checksum mismatch)', async () => {
    migrationsDir({ '0001_init.sql': 'CREATE TABLE demo_plugin.t (id int);' });
    appliedRows = [{ version: '0001', checksum: 'deadbeef' }];
    await expect(migrator().applyAll([manifest()])).rejects.toThrow(/checksum mismatch/i);
    expect(sqls()).not.toContain('BEGIN');
  });

  it('ROLLBACKs and does not record the migration when its SQL fails', async () => {
    const body = '-- failing migration';
    migrationsDir({ '0001_init.sql': body });
    h.query.mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SELECT version, checksum')) return Promise.resolve({ rows: [] });
      if (sql === body) return Promise.reject(new Error('syntax error at or near'));
      return Promise.resolve({ rows: [] });
    });
    await expect(migrator().applyAll([manifest()])).rejects.toThrow(/syntax error/);
    const s = sqls();
    expect(s).toContain('ROLLBACK');
    expect(s.some((q) => q.includes('INSERT INTO _brokkr_plugin_migrations'))).toBe(false);
  });
});

describe('PluginMigrator — advisory lock lifecycle', () => {
  it('takes and releases a pg advisory lock around the apply', async () => {
    migrationsDir({ '0001_init.sql': 'SELECT 1;' });
    await migrator().applyAll([manifest()]);
    const lockCalls = h.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('advisory'),
    );
    const lockKey = (lockCalls[0]?.[1] as unknown[])?.[0];
    expect(sqls().some((s) => s.includes('pg_advisory_lock'))).toBe(true);
    expect(sqls().some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(typeof lockKey).toBe('string');
    expect(() => BigInt(lockKey as string)).not.toThrow();
  });
});
