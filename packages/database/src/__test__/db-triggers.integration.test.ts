import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const PG_CHECK_VIOLATION = '23514';

describe.skipIf(!connectionString)('DB-enforced Device invariants', () => {
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

  describe('changelog audit trigger', () => {
    it('records a before/after/diff Changelog row when a non-secret column changes', async () => {
      const device = await newDevice({ name: 'audit-before' });
      await prisma.changelog.deleteMany({ where: { pk: device.id } });

      await prisma.device.update({ where: { id: device.id }, data: { name: 'audit-after' } });

      const rows = await prisma.changelog.findMany({ where: { pk: device.id } });
      expect(rows).toHaveLength(1);

      const entry = rows[0]!;
      expect(entry.tableName).toBe('Device');
      const before = entry.before as Record<string, unknown>;
      const after = entry.after as Record<string, unknown>;
      const diff = entry.diff as Record<string, unknown>;
      expect(before.name).toBe('audit-before');
      expect(after.name).toBe('audit-after');
      expect(diff.name).toBe('audit-after');
      expect(Object.keys(diff).sort()).toEqual(['name', 'updatedAt']);
    });

    it('does not record a Changelog row when only updatedAt changes', async () => {
      const device = await newDevice({ name: 'noop-audit' });
      await prisma.changelog.deleteMany({ where: { pk: device.id } });

      await prisma.device.update({ where: { id: device.id }, data: { name: 'noop-audit' } });

      const rows = await prisma.changelog.findMany({ where: { pk: device.id } });
      expect(rows).toHaveLength(0);
    });
  });

  describe('write-once role trigger', () => {
    it('rejects changing role from a non-null value with a check_violation', async () => {
      const device = await newDevice({ name: 'role-locked', role: 'Server' });

      const attempt = prisma.device.update({
        where: { id: device.id },
        data: { role: 'Bridge' },
      });

      await expect(attempt).rejects.toMatchObject({
        name: 'DriverAdapterError',
        cause: { kind: 'postgres', code: PG_CHECK_VIOLATION },
      });

      const reread = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
      expect(reread.role).toBe('Server');
    });

    it('allows a no-op role write (NEW.role = OLD.role)', async () => {
      const device = await newDevice({ name: 'role-noop', role: 'Server' });

      await expect(
        prisma.device.update({ where: { id: device.id }, data: { role: 'Server', name: 'role-noop-2' } }),
      ).resolves.toMatchObject({ role: 'Server', name: 'role-noop-2' });
    });

    it('allows assigning a role to an unassigned (NULL) device', async () => {
      const device = await newDevice({ name: 'role-unassigned' });
      expect(device.role).toBeNull();

      await expect(prisma.device.update({ where: { id: device.id }, data: { role: 'Server' } })).resolves.toMatchObject(
        { role: 'Server' },
      );
    });

    it('allows the Server->DiscoveredHost re-commissioning transition', async () => {
      const device = await newDevice({ name: 'role-recommission', role: 'Server' });

      await expect(
        prisma.device.update({ where: { id: device.id }, data: { role: 'DiscoveredHost' } }),
      ).resolves.toMatchObject({ role: 'DiscoveredHost' });
    });
  });
});
