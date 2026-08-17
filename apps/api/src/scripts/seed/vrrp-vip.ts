import { PrismaPg } from '@prisma/adapter-pg';
import { DeviceRole, DeviceStatus } from '@repo/database';

import { getErrorMessage } from '../../common/error-utils';
import { isLocalSimulationEnabled } from '../../common/local-simulation';
import { PrismaClient } from '../../prisma/prisma.client';

import { deriveSeedAddress } from './vrrp-vip.helpers';

const SEED_HOST_BASE = 240;

const SEED_IP_ID_STEM = '00000000-0000-0000-0000-00000000f1';
const seedIpId = (index: number): string => `${SEED_IP_ID_STEM}${String(index).padStart(2, '0')}`;

async function findZone(prisma: PrismaClient): Promise<{ id: string; organizationId: string }> {
  const byId = process.env.BROKKR_ZONE_ID?.trim();
  const rows = byId
    ? await prisma.$queryRaw<Array<{ id: string; organizationId: string }>>`
        SELECT id, "organizationId" FROM "Zone" WHERE id = ${byId} AND "deletedAt" IS NULL LIMIT 1`
    : await prisma.$queryRaw<Array<{ id: string; organizationId: string }>>`
        SELECT id, "organizationId" FROM "Zone" WHERE name = 'sim-zone' AND "deletedAt" IS NULL
        ORDER BY "createdAt" ASC LIMIT 1`;
  if (rows.length === 0) {
    throw new Error(
      'No sim zone found (looked up by BROKKR_ZONE_ID or name=sim-zone). Run `task up` first so the zone is enrolled.',
    );
  }
  return rows[0];
}

async function findPrimaryPrefix(prisma: PrismaClient, zoneId: string): Promise<{ id: string; cidr: string }> {
  const rows = await prisma.$queryRaw<Array<{ id: string; cidr: string }>>`
    SELECT id, prefix::text AS cidr FROM "Prefix"
    WHERE "zoneId" = ${zoneId} AND role = 'PRIMARY'::"IpamRole" AND "deletedAt" IS NULL
    ORDER BY "createdAt" ASC LIMIT 1`;
  if (rows.length === 0) {
    throw new Error(
      `No PRIMARY-role prefix found in zone ${zoneId} — run \`task up\` first so the data-plane prefix is seeded.`,
    );
  }
  return rows[0];
}

async function clearSeededVrrpIps(prisma: PrismaClient): Promise<void> {
  const inUse = await prisma.$queryRaw<Array<{ id: string; prefix: string }>>`
    SELECT p.id, p.prefix::text AS prefix
    FROM "Prefix" p
    JOIN "IpAddress" ip ON ip.id = p."vrrpVipId"
    WHERE ip.id LIKE ${`${SEED_IP_ID_STEM}%`} AND p."deletedAt" IS NULL AND ip."deletedAt" IS NULL`;
  if (inUse.length > 0) {
    const list = inUse.map((p) => `${p.prefix} (${p.id})`).join(', ');
    throw new Error(
      `Cannot clear: a seeded IP is still the VRRP VIP of prefix(es) ${list}. ` +
        'Clear the VIP first (prefix edit → VRRP, or DELETE /ipam/prefixes/:id/vrrp-vip), then re-run.',
    );
  }
  const removed = await prisma.$executeRaw`
    DELETE FROM "IpAddress" WHERE id LIKE ${`${SEED_IP_ID_STEM}%`}`;
  process.stdout.write(`VRRP test IPs cleared: ${removed} seeded IpAddress row(s) removed.\n`);
}

async function main(): Promise<void> {
  if (!isLocalSimulationEnabled()) {
    throw new Error(
      'seed:vrrp-vip is sim-only: set LOCAL_SIMULATION_ENABLED=true in a permitted env (HH_ENV in AUTH_BYPASS_ALLOWED_ENVS, NODE_ENV!==production).',
    );
  }
  const clear = process.argv.includes('--clear');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set.');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const zone = await findZone(prisma);

    if (clear) {
      await clearSeededVrrpIps(prisma);
      return;
    }

    const bridges = await prisma.device.findMany({
      where: { zoneId: zone.id, role: DeviceRole.Bridge, status: DeviceStatus.ACTIVE, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (bridges.length === 0) {
      throw new Error(
        `No ACTIVE bridges found in zone ${zone.id} — run \`task up\` and wait for the spoke(s) to register.`,
      );
    }

    const primaryPrefix = await findPrimaryPrefix(prisma, zone.id);

    const seeded: string[] = [];
    for (const [index, bridge] of bridges.entries()) {
      const address = deriveSeedAddress(primaryPrefix.cidr, SEED_HOST_BASE + index);
      const existing = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "IpAddress"
        WHERE "organizationId" = ${zone.organizationId} AND address = ${address}::inet
          AND "vrfId" IS NULL AND "deletedAt" IS NULL
        LIMIT 1`;
      if (existing.length === 0) {
        await prisma.$executeRaw`
          INSERT INTO "IpAddress" (id, address, "organizationId", "updatedAt")
          VALUES (${seedIpId(index)}, ${address}::inet, ${zone.organizationId}, now())
          ON CONFLICT (id) DO UPDATE SET address = EXCLUDED.address,
            "organizationId" = EXCLUDED."organizationId", "deletedAt" = NULL, "updatedAt" = now()`;
      }
      seeded.push(`${address} (for ${bridge.name})${existing.length > 0 ? ' — already existed, reused' : ''}`);
    }

    process.stdout.write(
      `VRRP test inventory ready on ${primaryPrefix.cidr} (prefix ${primaryPrefix.id}, zone ${zone.id}):\n` +
        seeded.map((s) => `  ${s}\n`).join('') +
        'Nothing is bound — attach a VIP to a bridge NIC via the hub UI (edit prefix → VRRP Virtual IP).\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  process.stderr.write(`seed:vrrp-vip failed: ${getErrorMessage(error)}\n`);
  process.exit(1);
});
