import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@repo/database';
import Redis from 'ioredis';

import { isLocalSimulationEnabled } from '../common/local-simulation';
import { sha256Hex, zoneAclSetUserArgs, zoneAclUsername } from '../zones/zone-redis-acl.util';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  if (!isLocalSimulationEnabled()) {
    throw new Error(
      'seed-sim-redis-acl is sim-only: set LOCAL_SIMULATION_ENABLED=true in a permitted env (HH_ENV in AUTH_BYPASS_ALLOWED_ENVS, NODE_ENV!==production).',
    );
  }

  const zoneName = argValue('--zone-name');
  const password = argValue('--password');
  if (!zoneName || !password) {
    throw new Error('Usage: seed-sim-redis-acl.ts --zone-name <name> --password <password>');
  }

  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL and REDIS_URL must be set');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
  try {
    const zone = await prisma.zone.findFirst({ where: { name: zoneName, deletedAt: null } });
    if (!zone) {
      throw new Error(`Sim zone not found (name=${zoneName}). Has sim:seed run?`);
    }

    const passwordHash = sha256Hex(password);
    await prisma.zoneRedisCredential.upsert({
      where: { zoneId: zone.id },
      create: { zoneId: zone.id, passwordHash },
      update: { passwordHash },
    });
    await redis.call('ACL', ...zoneAclSetUserArgs(zone.id, passwordHash));

    process.stderr.write(
      `[redis-acl] applied ACL user ${zoneAclUsername(zone.id)} for zone ${zoneName} (${zone.id})\n`,
    );
  } finally {
    await prisma.$disconnect();
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `[redis-acl] FATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
