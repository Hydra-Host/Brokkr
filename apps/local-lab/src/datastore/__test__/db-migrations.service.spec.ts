import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DbMigrationRow } from '../../contract';
import { DbMigrationsService, diffMigrations } from '../db-migrations.service';

const row = (over: Partial<DbMigrationRow> & { name: string }): DbMigrationRow => ({
  startedAt: 1,
  finishedAt: 2,
  rolledBackAt: null,
  ...over,
});

describe('diffMigrations', () => {
  it('reports nothing when every on-disk migration is cleanly applied', () => {
    expect(diffMigrations([row({ name: 'a' })], ['a'])).toEqual({ pending: [], missing: [], failed: [] });
  });

  it('re-lists a rolled-back migration as pending while it is still on disk', () => {
    expect(diffMigrations([row({ name: 'b', finishedAt: 2, rolledBackAt: 3 })], ['b'])).toEqual({
      pending: ['b'],
      missing: [],
      failed: [],
    });
  });

  it('buckets a started-but-unfinished migration as failed, not pending', () => {
    expect(diffMigrations([row({ name: 'c', finishedAt: null, rolledBackAt: null })], ['c'])).toEqual({
      pending: [],
      missing: [],
      failed: ['c'],
    });
  });

  it('lists an on-disk migration never seen in the database as pending', () => {
    expect(diffMigrations([], ['d'])).toEqual({ pending: ['d'], missing: [], failed: [] });
  });

  it('lists a cleanly applied migration absent from the checkout as missing', () => {
    expect(diffMigrations([row({ name: 'e' })], [])).toEqual({ pending: [], missing: ['e'], failed: [] });
  });

  it('treats an empty applied set (nuked table) as everything on disk pending', () => {
    expect(diffMigrations([], ['x', 'y'])).toEqual({ pending: ['x', 'y'], missing: [], failed: [] });
  });

  it('classifies a mixed set across all buckets', () => {
    const applied = [
      row({ name: 'clean' }),
      row({ name: 'rolled', rolledBackAt: 5 }),
      row({ name: 'broke', finishedAt: null }),
      row({ name: 'gone' }),
    ];
    expect(diffMigrations(applied, ['clean', 'rolled', 'broke', 'fresh'])).toEqual({
      pending: ['rolled', 'fresh'],
      missing: ['gone'],
      failed: ['broke'],
    });
  });
});

describe('DbMigrationsService on-disk read', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  const fixture = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'lab-mig-'));
    roots.push(root);
    const migrations = join(root, 'packages/database/prisma/migrations');
    mkdirSync(join(migrations, '0_init'), { recursive: true });
    mkdirSync(join(migrations, '20240316195414_first'));
    mkdirSync(join(migrations, '20260720000000_last'));
    mkdirSync(join(migrations, 'scratch'));
    writeFileSync(join(migrations, 'migration_lock.toml'), 'provider = "postgresql"\n');
    return root;
  };

  it('keeps timestamped dirs plus 0_init and drops the lock file and stray dirs', async () => {
    const svc = new DbMigrationsService(
      { listAppliedMigrations: () => Promise.resolve({ tableExists: true, applied: [] }) } as never,
      { repoPath: () => fixture() } as never,
    );
    const res = await svc.status();
    expect(res.tableExists).toBe(true);
    expect(res.onDisk).toEqual(['0_init', '20240316195414_first', '20260720000000_last']);
    expect(res.note).toBeUndefined();
  });

  it('returns empty onDisk with a note when the repo path is unset', async () => {
    const svc = new DbMigrationsService(
      { listAppliedMigrations: () => Promise.resolve({ tableExists: false, applied: [] }) } as never,
      { repoPath: () => undefined } as never,
    );
    const res = await svc.status();
    expect(res.onDisk).toEqual([]);
    expect(res.note).toBeTruthy();
    expect(res.tableExists).toBe(false);
  });

  it('suppresses missing and pending and reports only unfinished rows as failed when the disk read fails [bugbot 1249b907]', async () => {
    const applied = [
      row({ name: '0_init' }),
      row({ name: '20240316195414_first' }),
      row({ name: '20260720000000_broke', finishedAt: null }),
    ];
    const svc = new DbMigrationsService(
      { listAppliedMigrations: () => Promise.resolve({ tableExists: true, applied }) } as never,
      { repoPath: () => undefined } as never,
    );
    const res = await svc.status();
    expect(res.missing).toEqual([]);
    expect(res.pending).toEqual([]);
    expect(res.failed).toEqual(['20260720000000_broke']);
    expect(res.note).toBeTruthy();
  });
});
