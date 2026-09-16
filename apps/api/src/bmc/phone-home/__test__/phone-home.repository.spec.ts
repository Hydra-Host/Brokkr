import { NotFoundException } from '@nestjs/common';
import { LifecycleJobPhase, ServerLifecycleStatus, ServerPowerStatus } from '@repo/database';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { PhoneHomeRepository } from '../phone-home.repository';

interface PrismaMock {
  device: { update: Mock };
  server: { updateMany: Mock; createMany: Mock };
  deployment: { findFirst: Mock };
  deviceDiagnostics: { create: Mock };
}

const DEVICE_ID = 'device-uuid-1';

describe('PhoneHomeRepository', () => {
  let prisma: PrismaMock;
  let repo: PhoneHomeRepository;

  beforeEach(() => {
    prisma = {
      device: { update: vi.fn().mockResolvedValue({}) },
      server: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      deployment: { findFirst: vi.fn() },
      deviceDiagnostics: { create: vi.fn() },
    };
    repo = new PhoneHomeRepository(prisma as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('findActivePlanIdForDevice', () => {
    it('returns the newest in-flight lifecycle plan id for the device', async () => {
      const findOne = vi.spyOn(LifecycleJobRecord, 'findOneUnscoped').mockResolvedValue({ data: { id: 'plan-1' } });

      const result = await repo.findActivePlanIdForDevice(DEVICE_ID);

      expect(findOne).toHaveBeenCalledExactlyOnceWith({
        where: {
          deviceId: DEVICE_ID,
          phase: {
            in: [LifecycleJobPhase.DISPATCHED, LifecycleJobPhase.RUNNING, LifecycleJobPhase.AWAITING_PHONE_HOME],
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toBe('plan-1');
    });

    it('returns null when the device has no in-flight lifecycle job', async () => {
      vi.spyOn(LifecycleJobRecord, 'findOneUnscoped').mockResolvedValue(null);

      await expect(repo.findActivePlanIdForDevice(DEVICE_ID)).resolves.toBeNull();
    });
  });

  describe('updateDevice', () => {
    it('applies powerStatus to an existing row before detection and seeds the full create payload', async () => {
      await repo.updateDevice(DEVICE_ID, 'provisioned', ServerPowerStatus.On);

      expect(prisma.server.updateMany).toHaveBeenNthCalledWith(1, {
        where: { deviceId: DEVICE_ID },
        data: { powerStatus: ServerPowerStatus.On },
      });
      expect(prisma.server.createMany).toHaveBeenCalledWith({
        data: [
          {
            deviceId: DEVICE_ID,
            lifecycleStatus: ServerLifecycleStatus.PROVISIONED,
            powerStatus: ServerPowerStatus.On,
          },
        ],
        skipDuplicates: true,
      });
    });

    it('omits the powerStatus write when none is provided', async () => {
      await repo.updateDevice(DEVICE_ID, 'inventory');

      expect(prisma.server.createMany).toHaveBeenCalledWith({
        data: [{ deviceId: DEVICE_ID, lifecycleStatus: ServerLifecycleStatus.INVENTORY }],
        skipDuplicates: true,
      });
      expect(prisma.server.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_ID, lifecycleStatus: { not: ServerLifecycleStatus.INVENTORY } },
        data: { lifecycleStatus: ServerLifecycleStatus.INVENTORY },
      });
    });

    it('reports a transition via a conditional updateMany that matches only a status change', async () => {
      prisma.server.updateMany.mockResolvedValue({ count: 1 });

      const result = await repo.updateDevice(DEVICE_ID, 'provisioned', ServerPowerStatus.On);

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_ID, lifecycleStatus: { not: ServerLifecycleStatus.PROVISIONED } },
        data: { lifecycleStatus: ServerLifecycleStatus.PROVISIONED, powerStatus: ServerPowerStatus.On },
      });
      expect(result).toEqual({ transitioned: true });
    });

    it('reports no transition on a same-status re-write (createMany skipped, updateMany count 0)', async () => {
      prisma.server.updateMany.mockResolvedValue({ count: 0 });

      const result = await repo.updateDevice(DEVICE_ID, 'inventory');

      expect(result).toEqual({ transitioned: false });
      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_ID, lifecycleStatus: { not: ServerLifecycleStatus.INVENTORY } },
        data: { lifecycleStatus: ServerLifecycleStatus.INVENTORY },
      });
    });

    it('reports a transition on a first write — the createMany winner (unique deviceId) counts atomically', async () => {
      prisma.server.createMany.mockResolvedValue({ count: 1 });

      const result = await repo.updateDevice(DEVICE_ID, 'provisioned', ServerPowerStatus.On);

      expect(result).toEqual({ transitioned: true });
      expect(prisma.server.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_ID },
        data: { powerStatus: ServerPowerStatus.On },
      });
    });

    it('propagates the throw from statusSlugToServerLifecycle on an unknown status', async () => {
      await expect(repo.updateDevice(DEVICE_ID, 'bogus', ServerPowerStatus.On)).rejects.toThrow(
        /Unknown server lifecycle status/,
      );
      expect(prisma.server.updateMany).not.toHaveBeenCalled();
      expect(prisma.device.update).not.toHaveBeenCalled();
    });
  });

  describe('createDeviceDiagnostics', () => {
    it('inserts diagnostics connected to the active deployment', async () => {
      prisma.deployment.findFirst.mockResolvedValue({ id: 'dep-1' });
      prisma.deviceDiagnostics.create.mockResolvedValue({ id: 'diag-1' });

      const result = await repo.createDeviceDiagnostics(DEVICE_ID, { type: 'Health', data: { errors: 1 } });

      expect(prisma.deviceDiagnostics.create).toHaveBeenCalledWith({
        data: {
          deployment: { connect: { id: 'dep-1' } },
          type: 'Health',
          data: { errors: 1 },
        },
      });
      expect(result).toEqual({ id: 'diag-1' });
    });

    it('throws NotFoundException when the device has no active deployment', async () => {
      prisma.deployment.findFirst.mockResolvedValue(null);

      await expect(repo.createDeviceDiagnostics(DEVICE_ID, { type: 'Health', data: {} })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.deviceDiagnostics.create).not.toHaveBeenCalled();
    });
  });
});
