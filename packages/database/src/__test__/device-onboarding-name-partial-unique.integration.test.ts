import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';
import { PG_UNIQUE_VIOLATION, extractPgErrorCode } from './test-utils.js';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('Device active (supplierId, zoneId, name) partial unique index', () => {
  let prisma: PrismaClient;
  const createdOrgIds: string[] = [];
  const createdDeviceIds: string[] = [];

  const newOrg = async (suffix: string) => {
    const org = await prisma.organization.create({
      data: { name: `onboard-name-test-${suffix}-${Date.now()}`, tenantType: 'DemandCustomer' },
    });
    createdOrgIds.push(org.id);
    return org;
  };

  const newDevice = async (data: Parameters<PrismaClient['device']['create']>[0]['data']) => {
    const device = await prisma.device.create({ data });
    createdDeviceIds.push(device.id);
    return device;
  };

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    if (createdDeviceIds.length > 0) {
      await prisma.device.deleteMany({ where: { id: { in: createdDeviceIds } } });
      await prisma.changelog.deleteMany({ where: { pk: { in: createdDeviceIds } } });
    }
    for (const orgId of createdOrgIds) {
      await prisma.zone.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    }
    await prisma.$disconnect();
  });

  it('lets a NEW live Device reuse a tombstoned (supplierId, zoneId, name)', async () => {
    const org = await newOrg('reuse');
    const zone = await prisma.zone.create({ data: { name: 'zone-reuse', organizationId: org.id } });
    const name = `onboard-reuse-${Date.now()}`;

    const a = await newDevice({ name, supplierId: org.id, zoneId: zone.id });
    await prisma.device.update({ where: { id: a.id }, data: { deletedAt: new Date() } });

    const b = await newDevice({ name, supplierId: org.id, zoneId: zone.id });

    expect(b.name).toBe(name);
    expect(b.supplierId).toBe(org.id);
    expect(b.zoneId).toBe(zone.id);
    expect(b.deletedAt).toBeNull();
    expect(b.id).not.toBe(a.id);
  });

  it('rejects two LIVE Devices sharing (supplierId, zoneId, name)', async () => {
    const org = await newOrg('collision');
    const zone = await prisma.zone.create({ data: { name: 'zone-dup', organizationId: org.id } });
    const name = `onboard-collision-${Date.now()}`;

    await newDevice({ name, supplierId: org.id, zoneId: zone.id });

    const error = await prisma.device
      .create({ data: { name, supplierId: org.id, zoneId: zone.id } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error, 'expected the second live insert to reject with a unique violation').not.toBeNull();
    const code = extractPgErrorCode(error);
    expect(code, `unexpected error shape: ${JSON.stringify(error)}`).toMatch(
      new RegExp(`^(${PG_UNIQUE_VIOLATION}|P2002)$`),
    );
  });

  it('allows the same name in a different zone under the same supplier', async () => {
    const org = await newOrg('cross-zone');
    const zoneA = await prisma.zone.create({ data: { name: 'zone-a', organizationId: org.id } });
    const zoneB = await prisma.zone.create({ data: { name: 'zone-b', organizationId: org.id } });
    const name = `onboard-cross-zone-${Date.now()}`;

    const a = await newDevice({ name, supplierId: org.id, zoneId: zoneA.id });
    const b = await newDevice({ name, supplierId: org.id, zoneId: zoneB.id });

    expect(b.id).not.toBe(a.id);
    expect(b.name).toBe(name);
  });
});
