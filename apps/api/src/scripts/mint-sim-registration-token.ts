/** stdout must carry ONLY the raw token (the caller captures it into BROKKR_REGISTRATION_TOKEN); all diagnostics go to stderr. */
import { NestFactory } from '@nestjs/core';

import { isLocalSimulationEnabled } from '../common/local-simulation';
import { PrismaClient } from '../prisma/prisma.client';
import { ZoneCryptoRepository } from '../zone-crypto/zone-crypto.repository';
import { ZoneRegistrationTokenService } from '../zone-crypto/zone-registration-token.service';
import { isReusableTokenRow, readCachedToken } from './mint-sim-registration-token.helpers';
import { SimSeedModule } from './sim-seed.module';

const SIM_OWNER_EMAIL = 'brokkr@brokkr.local';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  if (!isLocalSimulationEnabled()) {
    throw new Error(
      'mint-sim-registration-token is sim-only: set LOCAL_SIMULATION_ENABLED=true in a permitted env (HH_ENV in AUTH_BYPASS_ALLOWED_ENVS, NODE_ENV!==production).',
    );
  }

  const zoneName = argValue('--zone-name');
  const zoneIdArg = argValue('--zone-id');
  if (!zoneName && !zoneIdArg) {
    throw new Error('Usage: mint-sim-registration-token.ts (--zone-name <name> | --zone-id <uuid>)');
  }

  const app = await NestFactory.createApplicationContext(SimSeedModule, { logger: false, abortOnError: false });
  try {
    const prisma = app.get(PrismaClient);
    const tokens = app.get(ZoneRegistrationTokenService);
    const enrollments = app.get(ZoneCryptoRepository);

    const zone = zoneIdArg
      ? await prisma.zone.findUnique({ where: { id: zoneIdArg } })
      : await prisma.zone.findFirst({ where: { name: zoneName, deletedAt: null } });
    if (!zone) {
      throw new Error(`Sim zone not found (${zoneIdArg ? `id=${zoneIdArg}` : `name=${zoneName}`}).`);
    }

    const owner = await prisma.user.findUnique({ where: { email: SIM_OWNER_EMAIL } });
    if (!owner) {
      throw new Error(
        `Sim Owner ${SIM_OWNER_EMAIL} not found. The hub admin bootstrap (seedBypassUser) seeds it before binding :3000 — is the hub up and bypass-seeded?`,
      );
    }

    const cached = readCachedToken(argValue('--reuse-file'));
    if (cached) {
      const row = await prisma.zoneRegistrationToken.findUnique({
        where: { tokenHash: cached.hash },
        select: { id: true, zoneId: true, consumedAt: true, expiresAt: true },
      });
      if (isReusableTokenRow(row, zone.id, new Date())) {
        process.stderr.write(
          `[mint-sim] reusing live token ${row.id} for zone ${zone.name} (${zone.id}); skipping mint to avoid re-run churn.\n`,
        );
        process.stdout.write(cached.token);
        return;
      }
    }

    const existing = await enrollments.findEnrollmentByZoneId(zone.id);
    const minted = await tokens.mintRegistrationTokenForSim(zone.id, owner.id);
    process.stderr.write(
      `[mint-sim] minted token ${minted.tokenId} for zone ${zone.name} (${zone.id})` +
        `${existing ? ` (already enrolled gen ${existing.generation}; token is a no-op unless the bridge cache-misses and re-enrolls)` : ''}.\n`,
    );
    process.stdout.write(minted.token);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `[mint-sim] FATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
