import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(here, '..', '..', 'prisma', 'migrations', '20260803195500_add_prefix_dhcp_relay_agent_ip', 'migration.sql'),
  'utf8',
);

const prefixTable = '_dhcp_relay_migration_prefix';
const statements = migrationSql
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

if (statements.some((statement) => statement.includes('UPDATE'))) {
  throw new Error('The DHCP relay migration must stay additive DDL (no data updates)');
}

function forTestTables(statement: string): string {
  return statement
    .replace(/"Prefix"/g, `"${prefixTable}"`)
    .replace(/"Prefix_zone_dhcpRelayAgentIp_enabled_key"/g, '"_dhcp_relay_migration_unique"');
}

describe.skipIf(!connectionString)('DHCP relay agent migration', () => {
  let prisma: PrismaClient;

  function insertPrefix(values: {
    id: string;
    zoneId?: string;
    associatedPrefixId?: string | null;
    status?: string;
    dhcpMode?: string | null;
    dhcpRelayAgentIp?: string | null;
  }): Promise<number> {
    return prisma.$executeRawUnsafe(
      `INSERT INTO "${prefixTable}"
         ("id", "zoneId", "associatedPrefixId", "status", "dhcpMode", "dhcpRelayAgentIp")
       VALUES ($1, $2, $3, $4, $5, $6::inet)`,
      values.id,
      values.zoneId ?? 'zone-1',
      values.associatedPrefixId ?? null,
      values.status ?? 'ACTIVE',
      values.dhcpMode ?? null,
      values.dhcpRelayAgentIp ?? null,
    );
  }

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: connectionString! });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${prefixTable}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${prefixTable}" (
        "id" TEXT PRIMARY KEY,
        "zoneId" TEXT,
        "associatedPrefixId" TEXT,
        "deletedAt" TIMESTAMP(3),
        "status" TEXT NOT NULL,
        "dhcpMode" TEXT
      )`,
    );
    for (const statement of statements) {
      await prisma.$executeRawUnsafe(forTestTables(statement));
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${prefixTable}"`);
      await prisma.$disconnect();
    }
  });

  it('accepts a routable unicast IPv4 relay agent IP', async () => {
    await expect(insertPrefix({ id: 'routable', dhcpRelayAgentIp: '198.51.100.1' })).resolves.toBe(1);
  });

  it('rejects non-routable relay agent IPs via the check constraints', async () => {
    for (const nonRoutable of [
      '0.0.0.0',
      '127.0.0.1',
      '169.254.1.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.1.2.3',
      '255.255.255.255',
      'fe80::2',
    ]) {
      await expect(insertPrefix({ id: `reject-${nonRoutable}`, dhcpRelayAgentIp: nonRoutable })).rejects.toThrow(
        /Prefix_dhcpRelayAgentIp_(unicast|ipv4)_check/,
      );
    }
  });

  it('rejects an active relayed prefix with DHCP enabled and no relay agent IP', async () => {
    await expect(
      insertPrefix({ id: 'relayed-no-agent', associatedPrefixId: 'assoc-1', dhcpMode: 'AUTHORITATIVE' }),
    ).rejects.toThrow(/Prefix_active_relay_requires_agent_ip_check/);
    await expect(insertPrefix({ id: 'relayed-off', associatedPrefixId: 'assoc-1', dhcpMode: 'OFF' })).resolves.toBe(1);
    await expect(
      insertPrefix({
        id: 'relayed-reserved',
        associatedPrefixId: 'assoc-1',
        status: 'RESERVED',
        dhcpMode: 'AUTHORITATIVE',
      }),
    ).resolves.toBe(1);
  });

  it('enforces per-zone relay agent IP uniqueness only for enabled live prefixes', async () => {
    await expect(
      insertPrefix({ id: 'enabled-a', dhcpMode: 'AUTHORITATIVE', dhcpRelayAgentIp: '203.0.113.1' }),
    ).resolves.toBe(1);
    await expect(insertPrefix({ id: 'enabled-b', dhcpMode: 'PROXY', dhcpRelayAgentIp: '203.0.113.1' })).rejects.toThrow(
      /_dhcp_relay_migration_unique/,
    );
    await expect(insertPrefix({ id: 'disabled-dup', dhcpMode: 'OFF', dhcpRelayAgentIp: '203.0.113.1' })).resolves.toBe(
      1,
    );
    await expect(
      insertPrefix({
        id: 'other-zone-dup',
        zoneId: 'zone-2',
        dhcpMode: 'AUTHORITATIVE',
        dhcpRelayAgentIp: '203.0.113.1',
      }),
    ).resolves.toBe(1);
  });
});
