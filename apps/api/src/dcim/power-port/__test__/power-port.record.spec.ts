import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { PowerPortType } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PowerPortRecord } from '../power-port.record';

describe('PowerPortRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const mockDevice = { findUnique: vi.fn() };

  const supplierOrgId = 'supplier-org-1';
  const deviceId = 'device-1';

  const fullPort = {
    id: 'pp-1',
    deviceId,
    name: 'PSU1',
    type: PowerPortType.IEC_C14,
    maximumDraw: 800,
    allocatedDraw: 500,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest({ powerPort: mockDelegate, device: mockDevice }, () => ({
      organizationId: supplierOrgId,
      permissions: new Set(['dcim:read', 'dcim:create', 'dcim:update', 'dcim:delete']),
    }));
  });

  afterEach(() => vi.resetAllMocks());

  describe('listPaginated', () => {
    beforeEach(() => {
      (mockDelegate as { count?: ReturnType<typeof vi.fn> }).count = vi.fn().mockResolvedValue(0);
    });

    it('applies default sort + page size + scoped where to both findMany and count', async () => {
      mockDelegate.findMany.mockResolvedValue([fullPort]);
      const countSpy = mockDelegate as unknown as { count: ReturnType<typeof vi.fn> };
      countSpy.count.mockResolvedValue(1);

      const result = await PowerPortRecord.listPaginated({});

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { device: { supplierId: supplierOrgId } },
          orderBy: [{ name: 'asc' }],
          skip: 0,
          take: 50,
        }),
      );
      expect(countSpy.count).toHaveBeenCalledWith({ where: { device: { supplierId: supplierOrgId } } });
      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({ page: 1, pageSize: 50, totalItems: 1, totalPages: 1 });
    });

    it('merges discrete filters into the scoped where', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await PowerPortRecord.listPaginated({ deviceId, type: PowerPortType.IEC_C14 });

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            device: { supplierId: supplierOrgId },
            AND: [{ deviceId }, { type: PowerPortType.IEC_C14 }],
          },
        }),
      );
    });
  });

  describe('findByIdOrThrow', () => {
    it('auto-scopes via parent device', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullPort);
      const found = await PowerPortRecord.findByIdOrThrow('pp-1');
      expect(found.data.id).toBe('pp-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'pp-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('throws NotFoundException for a foreign-supplier power port', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PowerPortRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a power port on a foreign-supplier device is invisible to the caller', async () => {
      const foreignPort = { ...fullPort };
      mockDelegate.findFirst.mockImplementation((args: { where: { device?: { supplierId?: string } } }) =>
        Promise.resolve(args.where.device?.supplierId === 'other-supplier' ? foreignPort : null),
      );

      await expect(PowerPortRecord.findByIdOrThrow('pp-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'pp-1', device: { supplierId: supplierOrgId } },
      });
    });
  });

  describe('createForDevice', () => {
    it('creates when the parent device is owned by the caller', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullPort);

      await PowerPortRecord.createForDevice(deviceId, {
        name: 'PSU1',
        type: PowerPortType.IEC_C14,
        maximumDraw: 800,
        allocatedDraw: 500,
      });

      expect(mockDevice.findUnique).toHaveBeenCalledWith({
        where: { id: deviceId, supplierId: supplierOrgId },
        select: { id: true },
      });
      expect(mockDelegate.create).toHaveBeenCalled();
    });

    it('rejects create when device is not owned by the caller', async () => {
      mockDevice.findUnique.mockResolvedValue(null);

      await expect(PowerPortRecord.createForDevice(deviceId, { name: 'PSU1' })).rejects.toThrow(NotFoundException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate name on the same device', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(PowerPortRecord.createForDevice(deviceId, { name: 'PSU1' })).rejects.toThrow(ConflictException);
    });

    it('rejects create when allocatedDraw exceeds maximumDraw', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(
        PowerPortRecord.createForDevice(deviceId, { name: 'PSU1', maximumDraw: 500, allocatedDraw: 800 }),
      ).rejects.toThrow(BadRequestException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe('updateById', () => {
    it('updates within the caller supplier scope (relation filter lands in update WHERE)', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullPort).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullPort, name: 'PSU2' });

      const result = await PowerPortRecord.updateById('pp-1', { name: 'PSU2' });

      expect(mockDelegate.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'pp-1', device: { supplierId: supplierOrgId } },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'pp-1', device: { supplierId: supplierOrgId } },
        data: { name: 'PSU2' },
      });
      expect(result.data.name).toBe('PSU2');
    });

    it('throws NotFoundException when the power port is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PowerPortRecord.updateById('pp-1', { name: 'x' })).rejects.toThrow(NotFoundException);
    });

    it('rejects update when new name conflicts on same device', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullPort).mockResolvedValueOnce({ id: 'other' });

      await expect(PowerPortRecord.updateById('pp-1', { name: 'PSU2' })).rejects.toThrow(ConflictException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('rejects update when new allocatedDraw exceeds existing maximumDraw', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullPort);

      await expect(PowerPortRecord.updateById('pp-1', { allocatedDraw: 1200 })).rejects.toThrow(BadRequestException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('rejects update when new maximumDraw falls below existing allocatedDraw', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullPort);

      await expect(PowerPortRecord.updateById('pp-1', { maximumDraw: 100 })).rejects.toThrow(BadRequestException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('refreshes DB-bumped fields (e.g. updatedAt) on the record after save', async () => {
      const beforeUpdatedAt = new Date('2026-01-01T00:00:00Z');
      const afterUpdatedAt = new Date('2026-01-01T00:00:05Z');
      const before = { ...fullPort, updatedAt: beforeUpdatedAt };
      const after = { ...fullPort, name: 'PSU2', updatedAt: afterUpdatedAt };

      mockDelegate.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue(after);

      const result = await PowerPortRecord.updateById('pp-1', { name: 'PSU2' });

      expect(result.data.updatedAt).toEqual(afterUpdatedAt);
      expect(result.data.name).toBe('PSU2');
    });
  });

  describe('deleteById', () => {
    it('deletes when the power port is visible to the caller (relation filter lands in delete WHERE)', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullPort);
      await PowerPortRecord.deleteById('pp-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'pp-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('throws NotFoundException when the power port is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PowerPortRecord.deleteById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  it('createForDevice fails closed when no request context is bound', async () => {
    ActiveRecordRegistry.configureForTest({ powerPort: mockDelegate, device: mockDevice }, null);
    await expect(PowerPortRecord.createForDevice(deviceId, { name: 'PSU1' })).rejects.toThrow(
      /Permission context required/,
    );
  });
});
