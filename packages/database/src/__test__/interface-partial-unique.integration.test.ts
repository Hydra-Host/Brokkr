import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';
import { PG_UNIQUE_VIOLATION, extractPgErrorCode } from './test-utils.js';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('Interface active partial unique indexes', () => {
  let prisma: PrismaClient;
  const createdDeviceIds: string[] = [];

  const newDevice = async (name: string) => {
    const device = await prisma.device.create({ data: { name } });
    createdDeviceIds.push(device.id);
    return device;
  };

  const expectUniqueViolation = async (attempt: Promise<unknown>) => {
    const error = await attempt.then(() => null).catch((e: unknown) => e);
    expect(error, 'expected the second live write to reject with a unique violation').not.toBeNull();
    const code = extractPgErrorCode(error);
    expect(code, `unexpected error shape: ${JSON.stringify(error)}`).toMatch(
      new RegExp(`^(${PG_UNIQUE_VIOLATION}|P2002)$`),
    );
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

  describe('(deviceId, name)', () => {
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

      await expectUniqueViolation(prisma.interface.create({ data: { deviceId: device.id, name: 'eth0' } }));
    });
  });

  describe('(deviceId, lower(macAddress))', () => {
    it('rejects two LIVE interfaces on one device sharing a MAC (unique violation)', async () => {
      const device = await newDevice(`iface-mac-collision-${Date.now()}`);

      await prisma.interface.create({ data: { deviceId: device.id, name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:01' } });

      await expectUniqueViolation(
        prisma.interface.create({ data: { deviceId: device.id, name: 'eth1', macAddress: 'aa:bb:cc:dd:ee:01' } }),
      );
    });

    it('rejects the same MAC in a different letter case (lower() index)', async () => {
      const device = await newDevice(`iface-mac-case-${Date.now()}`);

      await prisma.interface.create({ data: { deviceId: device.id, name: 'eth0', macAddress: 'AA:BB:CC:DD:EE:02' } });

      await expectUniqueViolation(
        prisma.interface.create({ data: { deviceId: device.id, name: 'eth1', macAddress: 'aa:bb:cc:dd:ee:02' } }),
      );
    });

    it('lets a NEW live interface reuse a tombstoned MAC', async () => {
      const device = await newDevice(`iface-mac-reuse-${Date.now()}`);

      const a = await prisma.interface.create({
        data: { deviceId: device.id, name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:03' },
      });
      await prisma.interface.update({ where: { id: a.id }, data: { deletedAt: new Date() } });

      const b = await prisma.interface.create({
        data: { deviceId: device.id, name: 'eth1', macAddress: 'aa:bb:cc:dd:ee:03' },
      });

      expect(b.deletedAt).toBeNull();
      expect(b.id).not.toBe(a.id);
    });

    it('allows the same MAC on two different devices', async () => {
      const first = await newDevice(`iface-mac-first-${Date.now()}`);
      const second = await newDevice(`iface-mac-second-${Date.now()}`);

      const a = await prisma.interface.create({
        data: { deviceId: first.id, name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:04' },
      });
      const b = await prisma.interface.create({
        data: { deviceId: second.id, name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:04' },
      });

      expect(b.id).not.toBe(a.id);
    });

    it('allows two live rows with a null MAC on one device', async () => {
      const device = await newDevice(`iface-mac-null-${Date.now()}`);

      const a = await prisma.interface.create({ data: { deviceId: device.id, name: 'eth0' } });
      const b = await prisma.interface.create({ data: { deviceId: device.id, name: 'eth1' } });

      expect(a.macAddress).toBeNull();
      expect(b.macAddress).toBeNull();
    });

    it('rejects a bare update onto a MAC another live interface holds, which is why the record stages MAC clears', async () => {
      const device = await newDevice(`iface-mac-update-collision-${Date.now()}`);

      await prisma.interface.create({ data: { deviceId: device.id, name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:05' } });
      const b = await prisma.interface.create({
        data: { deviceId: device.id, name: 'eth1', macAddress: 'aa:bb:cc:dd:ee:06' },
      });

      await expectUniqueViolation(
        prisma.interface.update({ where: { id: b.id }, data: { macAddress: 'aa:bb:cc:dd:ee:05' } }),
      );
    });
  });
});
