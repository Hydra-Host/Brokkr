import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';
import { PG_UNIQUE_VIOLATION, extractPgErrorCode } from './test-utils.js';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('Interface active (deviceId, name) partial unique index', () => {
  let prisma: PrismaClient;
  const createdDeviceIds: string[] = [];

  const newDevice = async (name: string) => {
    const device = await prisma.device.create({ data: { name } });
    createdDeviceIds.push(device.id);
    return device;
  };

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    if (createdDeviceIds.length > 0) {
      await prisma.interface.deleteMany({ where: { deviceId: { in: createdDeviceIds } } });
      await prisma.device.deleteMany({ where: { id: { in: createdDeviceIds } } });
      await prisma.changelog.deleteMany({ where: { pk: { in: createdDeviceIds } } });
    }
    await prisma.$disconnect();
  });

  it('lets a NEW live interface reuse a tombstoned (deviceId, name)', async () => {
    const device = await newDevice(`iface-partial-reuse-${Date.now()}`);

    const a = await prisma.interface.create({ data: { deviceId: device.id, name: 'eth0' } });
    await prisma.interface.update({ where: { id: a.id }, data: { deletedAt: new Date() } });

    const b = await prisma.interface.create({ data: { deviceId: device.id, name: 'eth0' } });

    expect(b.deletedAt).toBeNull();
    expect(b.id).not.toBe(a.id);
  });

  it('rejects two LIVE interfaces sharing (deviceId, name) (unique violation)', async () => {
    const device = await newDevice(`iface-partial-collision-${Date.now()}`);

    await prisma.interface.create({ data: { deviceId: device.id, name: 'eth0' } });

    const error = await prisma.interface
      .create({ data: { deviceId: device.id, name: 'eth0' } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error, 'expected the second live insert to reject with a unique violation').not.toBeNull();
    const code = extractPgErrorCode(error);
    expect(code, `unexpected error shape: ${JSON.stringify(error)}`).toMatch(
      new RegExp(`^(${PG_UNIQUE_VIOLATION}|P2002)$`),
    );
  });
});
