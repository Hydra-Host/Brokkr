import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeviceSecretAuditEventType, DeviceSecretActorType, DeviceSecretKind, DeviceSecretPurpose, createPrismaClient, type PrismaClient } from '../index.js';
import { extractPgErrorCode } from './test-utils.js';

const connectionString = process.env.DATABASE_URL;

const PG_FK_VIOLATION = '23503';
const PG_RESTRICT_VIOLATION = '23001';
const FK_ERROR = new RegExp(`^(${PG_FK_VIOLATION}|${PG_RESTRICT_VIOLATION}|P2003)$`);

describe('DeviceSecret custody invariants', () => {
  if (!connectionString) {
    it.todo('skipped: DATABASE_URL not set — custody-invariant assertions require a live Postgres instance');
    return;
  }

  let prisma: PrismaClient;
  const runId = randomUUID().slice(0, 8);
  const createdOrgIds: string[] = [];
  const createdDeviceIds: string[] = [];
  let userId: string;

  const sealBytes = { ephPub: Buffer.alloc(32, 1), ciphertext: Buffer.alloc(16, 2), tag: Buffer.alloc(16, 3) };

  const newZoneWithDevice = async (suffix: string) => {
    const org = await prisma.organization.create({
      data: { name: `secret-fk-${runId}-${suffix}`, tenantType: 'DemandCustomer' },
    });
    createdOrgIds.push(org.id);
    const zone = await prisma.zone.create({ data: { name: `secret-fk-zone-${runId}-${suffix}`, organizationId: org.id } });
    const device = await prisma.device.create({ data: { name: `secret-fk-dev-${runId}-${suffix}`, zoneId: zone.id } });
    createdDeviceIds.push(device.id);
    return { org, zone, device };
  };

  const newSecret = (deviceId: string, zoneId: string, version = 1) =>
    prisma.deviceSecret.create({
      data: {
        deviceId,
        zoneId,
        purpose: DeviceSecretPurpose.BMC,
        kind: DeviceSecretKind.USER,
        version,
        zoneKeyId: randomUUID(),
        keyGen: 1,
        createdById: userId,
        ...sealBytes,
      },
    });

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: connectionString! });
    const user = await prisma.user.create({ data: { email: `secret-fk-${runId}@test.local` } });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.deviceSecretAuditEvent.deleteMany({ where: { deviceId: { in: createdDeviceIds } } });
    for (const orgId of createdOrgIds) {
      await prisma.device.deleteMany({ where: { zone: { organizationId: orgId } } }); // secrets cascade
      await prisma.zone.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    }
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('composite custody FK exists with ON UPDATE RESTRICT / ON DELETE CASCADE', async () => {
    const rows = await prisma.$queryRaw<Array<{ confupdtype: string; confdeltype: string }>>`
      SELECT confupdtype::text AS confupdtype, confdeltype::text AS confdeltype
      FROM pg_constraint WHERE conname = 'DeviceSecret_deviceId_zoneId_fkey'
    `;
    expect(rows, 'DeviceSecret_deviceId_zoneId_fkey must exist').toHaveLength(1);
    expect(rows[0]?.confupdtype).toBe('r');
    expect(rows[0]?.confdeltype).toBe('c');
  });

  it('Device carries the unique (id, zoneId) pair backing the composite FK', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'Device_id_zoneId_key'
    `;
    expect(rows, 'Device_id_zoneId_key must exist').toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/UNIQUE/i);
  });

  it('DeviceSecretAuditEvent has no FK to Device', async () => {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = '"DeviceSecretAuditEvent"'::regclass
        AND contype = 'f'
        AND confrelid = '"Device"'::regclass
    `;
    expect(rows[0]?.n).toBe(0);
  });

  it("rejects a secret whose zoneId is not the device's zone", async () => {
    const a = await newZoneWithDevice('mismatch-a');
    const b = await newZoneWithDevice('mismatch-b');

    const error = await newSecret(a.device.id, b.zone.id)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error, 'cross-zone secret must be rejected').not.toBeNull();
    expect(extractPgErrorCode(error)).toMatch(FK_ERROR);
  });

  it('blocks rezoning a device that still has secret rows', async () => {
    const a = await newZoneWithDevice('rezone');
    const other = await prisma.zone.create({
      data: { name: `secret-fk-zone-${runId}-rezone-target`, organizationId: a.org.id },
    });
    await newSecret(a.device.id, a.zone.id);

    const error = await prisma.device
      .update({ where: { id: a.device.id }, data: { zoneId: other.id } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error, 'rezone with live secret rows must be rejected').not.toBeNull();
    expect(extractPgErrorCode(error)).toMatch(FK_ERROR);
  });

  it('audit history survives device hard-deletion (secrets cascade away)', async () => {
    const a = await newZoneWithDevice('survive');
    await newSecret(a.device.id, a.zone.id);
    await prisma.deviceSecretAuditEvent.create({
      data: {
        deviceId: a.device.id,
        event: DeviceSecretAuditEventType.WRITE,
        actorType: DeviceSecretActorType.SYSTEM,
      },
    });

    await prisma.device.delete({ where: { id: a.device.id } });

    const secrets = await prisma.deviceSecret.count({ where: { deviceId: a.device.id } });
    expect(secrets).toBe(0);
    const audits = await prisma.deviceSecretAuditEvent.count({ where: { deviceId: a.device.id } });
    expect(audits).toBe(1);
  });
});
