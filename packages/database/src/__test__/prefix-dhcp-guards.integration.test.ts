import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('Prefix DHCP DB invariants', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('dhcpMode index is PARTIAL (WHERE "dhcpMode" IS NOT NULL)', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'Prefix_dhcpMode_idx'
    `;
    expect(rows, 'Prefix_dhcpMode_idx must exist').toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/WHERE\s+\(?"?dhcpMode"?\s+IS NOT NULL\)?/i);
  });

  it('dhcpLeaseTtlSeconds CHECK enforces the >= 120 floor', async () => {
    const rows = await prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'Prefix_dhcpLeaseTtlSeconds_check'
    `;
    expect(rows, 'Prefix_dhcpLeaseTtlSeconds_check must exist').toHaveLength(1);
    expect(rows[0]?.def).toMatch(/dhcpLeaseTtlSeconds.*>=\s*120\b/i);
  });

  it('has dropped the dhcpNextServer and dhcpDnsServers columns', async () => {
    const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Prefix'
        AND column_name IN ('dhcpNextServer', 'dhcpDnsServers')
    `;
    expect(rows.map((r) => r.column_name)).toEqual([]);
  });

  it('dhcpMode CHECK enforces the FULL eligibility invariant (zone + non-NAT + IPv4)', async () => {
    const rows = await prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'Prefix_dhcp_requires_zone_check'
    `;
    expect(rows, 'Prefix_dhcp_requires_zone_check must exist').toHaveLength(1);
    const def = rows[0]?.def ?? '';
    expect(def).toMatch(/dhcpMode.*IS NULL.*OR.*dhcpMode.*=.*'OFF'/i);
    expect(def).toMatch(/zoneId.*IS NOT NULL/i);
    expect(def).toMatch(/role.*IS DISTINCT FROM.*'NAT'/i);
    expect(def).toMatch(/family\(.*prefix.*\)\s*=\s*4/i);
  });

  describe('DML enforcement', () => {
    const orgId = randomUUID();
    const zoneId = randomUUID();

    beforeAll(async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Organization" ("id", "name", "tenantType", "createdAt")
         VALUES ($1, 'dhcp-check-test-org', 'SupplyCustomer', now())`,
        orgId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Zone" ("id", "name", "organizationId", "createdAt", "updatedAt")
         VALUES ($1, 'dhcp-check-test-zone', $2, now(), now())`,
        zoneId,
        orgId,
      );
    });

    afterAll(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM "Prefix" WHERE "organizationId" = $1`, orgId);
      await prisma.$executeRawUnsafe(`DELETE FROM "Zone" WHERE "id" = $1`, zoneId);
      await prisma.$executeRawUnsafe(`DELETE FROM "Organization" WHERE "id" = $1`, orgId);
    });

    it('rejects dhcpLeaseTtlSeconds below the 120-second floor', async () => {
      const id = randomUUID();
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Prefix"
             ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
              "dhcpLeaseTtlSeconds")
           VALUES ($1, '10.99.0.0/24'::cidr, $2, 'ACTIVE', now(), now(), 60)`,
          id,
          orgId,
        ),
      ).rejects.toThrow(/Prefix_dhcpLeaseTtlSeconds_check/);
    });

    it('accepts dhcpLeaseTtlSeconds at the 120-second boundary', async () => {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Prefix"
           ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
            "dhcpLeaseTtlSeconds")
         VALUES ($1, '10.99.1.0/24'::cidr, $2, 'ACTIVE', now(), now(), 120)`,
        id,
        orgId,
      );
      await prisma.$executeRawUnsafe(`DELETE FROM "Prefix" WHERE "id" = $1`, id);
    });

    it('accepts dhcpLeaseTtlSeconds = NULL (code default)', async () => {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Prefix"
           ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
            "dhcpLeaseTtlSeconds")
         VALUES ($1, '10.99.2.0/24'::cidr, $2, 'ACTIVE', now(), now(), NULL)`,
        id,
        orgId,
      );
      await prisma.$executeRawUnsafe(`DELETE FROM "Prefix" WHERE "id" = $1`, id);
    });

    it('rejects DHCP-enabled prefix without a zone (zoneId IS NULL)', async () => {
      const id = randomUUID();
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Prefix"
             ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
              "dhcpMode", "zoneId")
           VALUES ($1, '10.99.3.0/24'::cidr, $2, 'ACTIVE', now(), now(),
                   'AUTHORITATIVE', NULL)`,
          id,
          orgId,
        ),
      ).rejects.toThrow(/Prefix_dhcp_requires_zone_check/);
    });

    it('rejects DHCP-enabled prefix with NAT role', async () => {
      const id = randomUUID();
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Prefix"
             ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
              "dhcpMode", "zoneId", "role")
           VALUES ($1, '10.99.4.0/24'::cidr, $2, 'ACTIVE', now(), now(),
                   'AUTHORITATIVE', $3, 'NAT')`,
          id,
          orgId,
          zoneId,
        ),
      ).rejects.toThrow(/Prefix_dhcp_requires_zone_check/);
    });

    it('rejects DHCP-enabled prefix on an IPv6 subnet', async () => {
      const id = randomUUID();
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Prefix"
             ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
              "dhcpMode", "zoneId")
           VALUES ($1, 'fd00::/64'::cidr, $2, 'ACTIVE', now(), now(),
                   'AUTHORITATIVE', $3)`,
          id,
          orgId,
          zoneId,
        ),
      ).rejects.toThrow(/Prefix_dhcp_requires_zone_check/);
    });

    it('accepts DHCP-enabled prefix with zone + non-NAT role + IPv4', async () => {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Prefix"
           ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
            "dhcpMode", "zoneId", "role")
         VALUES ($1, '10.99.5.0/24'::cidr, $2, 'ACTIVE', now(), now(),
                 'AUTHORITATIVE', $3, 'PRIMARY')`,
        id,
        orgId,
        zoneId,
      );
      await prisma.$executeRawUnsafe(`DELETE FROM "Prefix" WHERE "id" = $1`, id);
    });

    it('accepts dhcpMode = OFF without a zone (OFF is the explicit-disable sentinel)', async () => {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Prefix"
           ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
            "dhcpMode", "zoneId")
         VALUES ($1, '10.99.6.0/24'::cidr, $2, 'ACTIVE', now(), now(),
                 'OFF', NULL)`,
        id,
        orgId,
      );
      await prisma.$executeRawUnsafe(`DELETE FROM "Prefix" WHERE "id" = $1`, id);
    });

    it('accepts dhcpMode = NULL without a zone (unconfigured)', async () => {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Prefix"
           ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
            "dhcpMode", "zoneId")
         VALUES ($1, '10.99.7.0/24'::cidr, $2, 'ACTIVE', now(), now(),
                 NULL, NULL)`,
        id,
        orgId,
      );
      await prisma.$executeRawUnsafe(`DELETE FROM "Prefix" WHERE "id" = $1`, id);
    });

    it('rejects an active relayed prefix without a relay agent IP when DHCP is enabled', async () => {
      const id = randomUUID();
      const associatedId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Prefix"
           ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt", "zoneId")
         VALUES ($1, '10.99.8.0/24'::cidr, $2, 'ACTIVE', now(), now(), $3)`,
        associatedId,
        orgId,
        zoneId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Prefix"
             ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
              "dhcpMode", "zoneId", "associatedPrefixId", "dhcpRelayAgentIp")
           VALUES ($1, '192.168.0.0/24'::cidr, $2, 'ACTIVE', now(), now(),
                   'AUTHORITATIVE', $3, $4, NULL)`,
          id,
          orgId,
          zoneId,
          associatedId,
        ),
      ).rejects.toThrow(/Prefix_active_relay_requires_agent_ip_check/);
      await prisma.$executeRawUnsafe(`DELETE FROM "Prefix" WHERE "id" = $1`, associatedId);
    });

    it('rejects duplicate enabled relay agent IPs in one zone', async () => {
      const firstId = randomUUID();
      const secondId = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Prefix"
           ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
            "dhcpMode", "zoneId", "dhcpRelayAgentIp")
         VALUES ($1, '10.99.9.0/24'::cidr, $2, 'ACTIVE', now(), now(),
                 'AUTHORITATIVE', $3, '172.16.0.1'::inet)`,
        firstId,
        orgId,
        zoneId,
      );
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Prefix"
             ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt",
              "dhcpMode", "zoneId", "dhcpRelayAgentIp")
           VALUES ($1, '10.99.10.0/24'::cidr, $2, 'ACTIVE', now(), now(),
                   'PROXY', $3, '172.16.0.1'::inet)`,
          secondId,
          orgId,
          zoneId,
        ),
      ).rejects.toThrow(/Prefix_zone_dhcpRelayAgentIp_enabled_key/);
      await prisma.$executeRawUnsafe(`DELETE FROM "Prefix" WHERE "id" = $1`, firstId);
    });

    it('rejects an IPv6 DHCP relay agent IP', async () => {
      const id = randomUUID();
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Prefix"
             ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt", "dhcpRelayAgentIp")
           VALUES ($1, '10.99.11.0/24'::cidr, $2, 'ACTIVE', now(), now(), 'fe80::1'::inet)`,
          id,
          orgId,
        ),
      ).rejects.toThrow(/Prefix_dhcpRelayAgentIp_ipv4_check/);
    });

    it('rejects non-routable DHCP relay agent IPv4 addresses', async () => {
      for (const relayAgentIp of ['0.0.0.0', '127.0.0.1', '169.254.1.1', '224.0.0.1', '255.255.255.255']) {
        await expect(
          prisma.$executeRawUnsafe(
            `INSERT INTO "Prefix"
               ("id", "prefix", "organizationId", "status", "createdAt", "updatedAt", "dhcpRelayAgentIp")
             VALUES ($1, '10.99.12.0/24'::cidr, $2, 'ACTIVE', now(), now(), $3::inet)`,
            randomUUID(),
            orgId,
            relayAgentIp,
          ),
        ).rejects.toThrow(/Prefix_dhcpRelayAgentIp_unicast_check/);
      }
    });
  });
});
