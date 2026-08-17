import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';


const databasePackageDir = path.resolve(__dirname, '../../../../../packages/database');
const prismaCli = createRequire(path.join(databasePackageDir, 'package.json')).resolve('prisma/build/index.js');

const CHECK_VIOLATION = '23514';
const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

async function isReachable(serverUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: serverUrl, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function toServerUrl(raw: string): string {
  const url = new URL(raw);
  url.pathname = '/postgres';
  return url.toString();
}

async function startDockerPostgres(): Promise<{ serverUrl: string; containerId: string }> {
  const run = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_DB=postgres',
      '-p',
      '0:5432',
      'postgres:16-alpine',
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    throw new Error(`unable to start Docker Postgres for integration test: ${run.stderr || run.error}`);
  }
  const containerId = run.stdout.trim();
  const portOut = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' });
  const port = portOut.split('\n')[0]?.split(':').pop()?.trim();
  const serverUrl = `postgresql://postgres:postgres@localhost:${port}/postgres`;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isReachable(serverUrl)) return { serverUrl, containerId };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  spawnSync('docker', ['stop', containerId]);
  throw new Error('Docker Postgres did not become ready in time');
}

describe('Device.role write-once re-commission trigger (real migrated Postgres)', () => {
  let serverUrl: string;
  let containerId: string | undefined;
  let testDbName: string;
  let testDbUrl: string;
  let client: pg.Client;

  beforeAll(async () => {
    const provided = process.env.E2E_DATABASE_SERVER_URL ?? process.env.DATABASE_URL;
    if (provided && (await isReachable(toServerUrl(provided)))) {
      serverUrl = toServerUrl(provided);
    } else {
      ({ serverUrl, containerId } = await startDockerPostgres());
    }

    testDbName = `brokkr_recommission_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${testDbName}"`);
    } finally {
      await admin.end();
    }
    const dbUrl = new URL(serverUrl);
    dbUrl.pathname = `/${testDbName}`;
    testDbUrl = dbUrl.toString();

    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: databasePackageDir,
      env: { ...process.env, DATABASE_URL: testDbUrl },
      stdio: 'pipe',
    });

    client = new pg.Client({ connectionString: testDbUrl });
    await client.connect();
  }, 180_000);

  beforeEach(async () => {
    await client.query(
      `INSERT INTO "Device" (id, name, "updatedAt", role, status) VALUES ($1, 'recommission-dev', now(), 'Server', 'PLANNED')`,
      [DEVICE_ID],
    );
  });

  afterEach(async () => {
    await client.query(`DELETE FROM "Changelog" WHERE pk=$1`, [DEVICE_ID]);
    await client.query(`DELETE FROM "Device" WHERE id=$1`, [DEVICE_ID]);
  });

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect().catch(() => undefined);
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [testDbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    if (containerId) spawnSync('docker', ['stop', containerId]);
  }, 60_000);

  it('RAISEs check_violation on Server->Bridge (write-once invariant intact)', async () => {
    await expect(client.query(`UPDATE "Device" SET role='Bridge' WHERE id=$1`, [DEVICE_ID])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('allows Server->DiscoveredHost re-commission and records a Changelog row', async () => {
    await client.query(`UPDATE "Device" SET role='DiscoveredHost', status='PLANNED' WHERE id=$1`, [DEVICE_ID]);

    const role = await client.query<{ role: string }>(`SELECT role FROM "Device" WHERE id=$1`, [DEVICE_ID]);
    expect(role.rows[0]?.role).toBe('DiscoveredHost');

    const changelog = await client.query(
      `SELECT 1 FROM "Changelog" WHERE pk=$1 AND after->>'role' = 'DiscoveredHost'`,
      [DEVICE_ID],
    );
    expect(changelog.rowCount).toBeGreaterThan(0);
  });
});
