import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { Client } from 'pg';

import type { PluginManifest } from '@hydrahost/plugin-sdk';

const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MIGRATION_FILE_PATTERN = /^(\d+)_([a-zA-Z0-9_-]+)\.sql$/;

interface AppliedMigrationRow {
  version: string;
  checksum: string;
}

export interface PluginMigratorLogger {
  log(message: string): void;
  warn(message: string): void;
}

export class PluginMigrator {
  constructor(
    private readonly connectionString: string,
    private readonly logger: PluginMigratorLogger = console,
  ) {}

  async applyAll(manifests: PluginManifest[]): Promise<void> {
    const stateful = manifests.filter((m) => m.schemaName !== undefined);
    if (stateful.length === 0) return;

    const client = new Client({ connectionString: this.connectionString });
    await client.connect();
    try {
      for (const manifest of stateful) {
        await this.applyOne(client, manifest);
      }
    } finally {
      await client.end();
    }
  }

  private async applyOne(client: Client, manifest: PluginManifest): Promise<void> {
    if (!manifest.schemaName || !manifest.migrationsDir) {
      throw new Error(
        `Plugin "${manifest.id}" must declare both schemaName and migrationsDir to be migrated. ` +
          `Stateless plugins (no schemaName) should be filtered out before reaching applyOne.`,
      );
    }
    if (!SCHEMA_NAME_PATTERN.test(manifest.schemaName)) {
      throw new Error(
        `Plugin "${manifest.id}" has invalid schemaName "${manifest.schemaName}". ` +
          `Must match ${SCHEMA_NAME_PATTERN}.`,
      );
    }

    const lockKey = this.advisoryLockKey(manifest.id);
    await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${manifest.schemaName}"`);

      const applied = await client.query<AppliedMigrationRow>(
        'SELECT version, checksum FROM _brokkr_plugin_migrations WHERE plugin_id = $1',
        [manifest.id],
      );
      const appliedByVersion = new Map(applied.rows.map((r) => [r.version, r.checksum]));

      const files = await this.listMigrationFiles(manifest);
      for (const { file, version, name } of files) {
        const contents = await readFile(join(manifest.migrationsDir, file), 'utf-8');
        const checksum = createHash('sha256').update(contents).digest('hex');

        const recorded = appliedByVersion.get(version);
        if (recorded) {
          if (recorded !== checksum) {
            throw new Error(
              `Checksum mismatch for plugin "${manifest.id}" migration ${file}: ` +
                `database has ${recorded}, file is ${checksum}. ` +
                `Applied migrations must never be edited — add a new migration instead.`,
            );
          }
          continue;
        }

        this.logger.log(`[plugin-runtime] applying ${manifest.id} ${file}`);
        await client.query('BEGIN');
        try {
          await client.query(contents);
          await client.query(
            'INSERT INTO _brokkr_plugin_migrations (plugin_id, version, name, checksum) VALUES ($1, $2, $3, $4)',
            [manifest.id, version, name, checksum],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  }

  private async listMigrationFiles(
    manifest: PluginManifest,
  ): Promise<Array<{ file: string; version: string; name: string }>> {
    if (!manifest.migrationsDir) {
      throw new Error(`Plugin "${manifest.id}" has no migrationsDir`);
    }
    let entries: string[];
    try {
      entries = await readdir(manifest.migrationsDir);
    } catch (err) {
      throw new Error(
        `Plugin "${manifest.id}" migrationsDir not readable: ${manifest.migrationsDir}. ${(err as Error).message}`,
      );
    }
    const parsed: Array<{ file: string; version: string; name: string }> = [];
    for (const file of entries) {
      if (!file.endsWith('.sql')) continue;
      const match = MIGRATION_FILE_PATTERN.exec(file);
      if (!match) {
        throw new Error(
          `Plugin "${manifest.id}" has invalid migration filename "${file}". ` +
            `Expected NNNN_name.sql (digits, underscore, [a-zA-Z0-9_-], .sql).`,
        );
      }
      parsed.push({ file, version: match[1], name: match[2] });
    }
    parsed.sort((a, b) => {
      const aVersion = BigInt(a.version);
      const bVersion = BigInt(b.version);
      if (aVersion < bVersion) return -1;
      if (aVersion > bVersion) return 1;
      return a.file.localeCompare(b.file);
    });
    return parsed;
  }

  private advisoryLockKey(pluginId: string): string {
    const digest = createHash('sha256').update(`brokkr-plugin-migrate:${pluginId}`).digest();
    return digest.readBigInt64BE(0).toString();
  }
}
