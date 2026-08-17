import { Injectable } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getErrorMessage } from '../common/errors';
import type { DbMigrationRow, DbMigrations } from '../contract';
import { RepoBranchService } from '../services/repo-branch.service';
import { PgService } from './pg.service';

const MIGRATIONS_SUBPATH = 'packages/database/prisma/migrations';
const MIGRATION_DIR = /^\d{14}_/;

@Injectable()
export class DbMigrationsService {
  constructor(
    private readonly pg: PgService,
    private readonly repo: RepoBranchService,
  ) {}

  async status(): Promise<DbMigrations> {
    const { tableExists, applied } = await this.pg.listAppliedMigrations();
    const { onDisk, note } = await this.readOnDisk();
    // with no on-disk side, pending/missing (drift vs the checkout) are indeterminate; only failed is DB-derivable.
    const diff: { pending: string[]; missing: string[]; failed: string[] } = note
      ? { pending: [], missing: [], failed: failedMigrationNames(applied) }
      : diffMigrations(applied, onDisk);
    return { tableExists, applied, onDisk, ...diff, ...(note ? { note } : {}) };
  }

  private async readOnDisk(): Promise<{ onDisk: string[]; note?: string }> {
    const repoPath = this.repo.repoPath();
    if (!repoPath) return { onDisk: [], note: 'repo path not configured — on-disk migrations unavailable' };
    try {
      const entries = await readdir(join(repoPath, MIGRATIONS_SUBPATH), { withFileTypes: true });
      const onDisk = entries
        .filter((e) => e.isDirectory() && (MIGRATION_DIR.test(e.name) || e.name === '0_init'))
        .map((e) => e.name)
        .sort();
      return { onDisk };
    } catch (error) {
      return { onDisk: [], note: `could not read on-disk migrations: ${getErrorMessage(error)}` };
    }
  }
}

export function failedMigrationNames(applied: DbMigrationRow[]): string[] {
  return applied.filter((m) => m.finishedAt === null && m.rolledBackAt === null).map((m) => m.name);
}

export function diffMigrations(
  applied: DbMigrationRow[],
  onDisk: string[],
): { pending: string[]; missing: string[]; failed: string[] } {
  const onDiskSet = new Set(onDisk);
  const byName = new Map(applied.map((m) => [m.name, m]));

  const cleanlyApplied = (m: DbMigrationRow) => m.finishedAt !== null && m.rolledBackAt === null;

  const missing = applied.filter((m) => cleanlyApplied(m) && !onDiskSet.has(m.name)).map((m) => m.name);
  const failed = failedMigrationNames(applied);

  const pending = onDisk.filter((name) => {
    const m = byName.get(name);
    return !m || m.rolledBackAt !== null;
  });

  return { pending, missing, failed };
}
