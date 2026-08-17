import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';
import { PG_UNIQUE_VIOLATION, extractPgErrorCode } from './test-utils.js';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('Device active-systemUuid partial unique index', () => {
  let prisma: PrismaClient;
  const createdDeviceIds: string[] = [];

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
    await prisma.$disconnect();
  });

  const uuidFor = (tag: string) => `00000000-0000-4000-8000-${Date.now().toString(16).slice(-12).padStart(12, tag[0])}`;

  it('lets a NEW live Device reuse a tombstoned Device.systemUuid', async () => {
    const systemUuid = uuidFor('a');

    const a = await newDevice({ name: 'tombstone-reuse-a', systemUuid });
    await prisma.device.update({ where: { id: a.id }, data: { deletedAt: new Date() } });

    const b = await newDevice({ name: 'tombstone-reuse-b', systemUuid });

    expect(b.systemUuid).toBe(systemUuid);
    expect(b.deletedAt).toBeNull();
    expect(b.id).not.toBe(a.id);
  });

  it('rejects two LIVE Devices sharing the same systemUuid (unique violation)', async () => {
    const systemUuid = uuidFor('b');

    await newDevice({ name: 'live-collision-1', systemUuid });

    const error = await prisma.device
      .create({ data: { name: 'live-collision-2', systemUuid } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error, 'expected the second live insert to reject with a unique violation').not.toBeNull();
    const code = extractPgErrorCode(error);
    expect(code, `unexpected error shape: ${JSON.stringify(error)}`).toMatch(
      new RegExp(`^(${PG_UNIQUE_VIOLATION}|P2002)$`),
    );
  });
});
