import { NestFactory } from '@nestjs/core';
import { DeviceRole, DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { readFileSync } from 'node:fs';

import { isLocalSimulationEnabled } from '../common/local-simulation';
import { DeviceSecretService, SecretStorageUnavailableError } from '../device-secret/device-secret.service';
import { PrismaClient } from '../prisma/prisma.client';
import { ZoneCryptoRepository } from '../zone-crypto/zone-crypto.repository';
import {
  ENROLLMENT_POLL_ATTEMPTS,
  parseFleetMode,
  parseFleetYaml,
  simDeviceUuid,
  waitForEnrollment,
} from './sim-bmc-seed.helpers';
import { SimSeedModule } from './sim-seed.module';

const SIM_OWNER_EMAIL = 'brokkr@brokkr.local';

async function main(): Promise<void> {
  if (!isLocalSimulationEnabled()) {
    throw new Error(
      'seed-sim-bmc-secrets is sim-only: set LOCAL_SIMULATION_ENABLED=true in a permitted env (HH_ENV in AUTH_BYPASS_ALLOWED_ENVS, NODE_ENV!==production).',
    );
  }

  const fleetPath = process.env.LOCAL_FLEET_PATH || process.env.LOCAL_FLEET_SOURCE;
  if (!fleetPath) {
    throw new Error('LOCAL_FLEET_PATH (or LOCAL_FLEET_SOURCE) must point at the rendered fleet.yml.');
  }
  const fleetText = readFileSync(fleetPath, 'utf8');

  if (parseFleetMode(fleetText) === 'baremetal') {
    process.stderr.write('[seed-bmc] bare-metal mode — vm BMC seal skipped (seed:baremetal-bmc owns bm creds)\n');
    return;
  }

  const nodes = parseFleetYaml(fleetText);

  const app = await NestFactory.createApplicationContext(SimSeedModule, { logger: false, abortOnError: false });
  try {
    const prisma = app.get(PrismaClient);
    const secrets = app.get(DeviceSecretService);
    const enrollments = app.get(ZoneCryptoRepository);

    const owner = await prisma.user.findUnique({ where: { email: SIM_OWNER_EMAIL } });
    if (!owner) {
      throw new Error(
        `Sim Owner ${SIM_OWNER_EMAIL} not found. The hub admin bootstrap (seedBypassUser) seeds it before binding :3000.`,
      );
    }

    let sealed = 0;
    let skipped = 0;
    const zoneEnrolled = new Map<string, boolean>();

    for (const node of nodes) {
      const deviceId = simDeviceUuid(node.index);
      const device = await prisma.device.findUnique({
        where: { id: deviceId },
        select: { id: true, role: true, zoneId: true, deletedAt: true },
      });
      if (!device || device.deletedAt || device.role !== DeviceRole.Server) {
        process.stderr.write(`[seed-bmc] ${node.name} (${deviceId}): no live Server device — skip.\n`);
        skipped += 1;
        continue;
      }
      if (!device.zoneId) {
        process.stderr.write(`[seed-bmc] ${node.name} (${deviceId}): device has no zone — skip.\n`);
        skipped += 1;
        continue;
      }

      if (!zoneEnrolled.has(device.zoneId)) {
        zoneEnrolled.set(device.zoneId, await waitForEnrollment(enrollments, device.zoneId));
      }
      if (!zoneEnrolled.get(device.zoneId)) {
        process.stderr.write(
          `[seed-bmc] zone ${device.zoneId} not enrolled after ${ENROLLMENT_POLL_ATTEMPTS} polls; skipping ${node.name}.\n`,
        );
        skipped += 1;
        continue;
      }

      try {
        const result = await secrets.write(
          device.id,
          DeviceSecretPurpose.BMC,
          DeviceSecretKind.USER,
          { user: node.bmc.user, pass: node.bmc.pass },
          owner.id,
          { skipIfLivePresent: true },
        );
        process.stderr.write(`[seed-bmc] ${node.name} (${deviceId}): BMC/USER secret v${result.version}.\n`);
        sealed += 1;
      } catch (error) {
        if (error instanceof SecretStorageUnavailableError) {
          process.stderr.write(`[seed-bmc] ${node.name} (${deviceId}): seal unavailable (${error.message}) — skip.\n`);
          skipped += 1;
          continue;
        }
        throw error;
      }
    }

    process.stderr.write(`[seed-bmc] done: ${sealed} sealed/reused, ${skipped} skipped, of ${nodes.length} node(s).\n`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `[seed-bmc] FATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
