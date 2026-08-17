import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { FeedLegPhase, PowerOutletType } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PowerOutletRecord } from '../power-outlet.record';

describe('PowerOutletRecord', () => {
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

  const fullOutlet = {
    id: 'po-1',
    deviceId,
    name: 'Outlet-01',
    type: PowerOutletType.IEC_C13,
    feedLegPhase: FeedLegPhase.A,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest({ powerOutlet: mockDelegate, device: mockDevice }, () => ({
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
      mockDelegate.findMany.mockResolvedValue([fullOutlet]);
      const countSpy = mockDelegate as unknown as { count: ReturnType<typeof vi.fn> };
      countSpy.count.mockResolvedValue(1);

      const result = await PowerOutletRecord.listPaginated({});

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

    it('merges discrete filters (deviceId, type, feedLegPhase) into the scoped where', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await PowerOutletRecord.listPaginated({
        deviceId,
        type: PowerOutletType.IEC_C13,
        feedLegPhase: FeedLegPhase.A,
      });

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            device: { supplierId: supplierOrgId },
            AND: [{ deviceId }, { type: PowerOutletType.IEC_C13 }, { feedLegPhase: FeedLegPhase.A }],
          },
        }),
      );
    });
  });

  describe('findByIdOrThrow', () => {
    it('auto-scopes via parent device', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullOutlet);
      const found = await PowerOutletRecord.findByIdOrThrow('po-1');
      expect(found.data.id).toBe('po-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'po-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('throws NotFoundException for a foreign-supplier power outlet', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PowerOutletRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a power outlet on a foreign-supplier device is invisible to the caller', async () => {
      const foreignOutlet = { ...fullOutlet };
      mockDelegate.findFirst.mockImplementation((args: { where: { device?: { supplierId?: string } } }) =>
        Promise.resolve(args.where.device?.supplierId === 'other-supplier' ? foreignOutlet : null),
      );

      await expect(PowerOutletRecord.findByIdOrThrow('po-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'po-1', device: { supplierId: supplierOrgId } },
      });
    });
  });

  describe('createForDevice', () => {
    it('creates when the parent device is owned by the caller', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullOutlet);

      await PowerOutletRecord.createForDevice(deviceId, {
        name: 'Outlet-01',
        type: PowerOutletType.IEC_C13,
        feedLegPhase: FeedLegPhase.A,
      });

      expect(mockDevice.findUnique).toHaveBeenCalledWith({
        where: { id: deviceId, supplierId: supplierOrgId },
        select: { id: true },
      });
      expect(mockDelegate.create).toHaveBeenCalled();
    });

    it('rejects create when device is not owned by the caller', async () => {
      mockDevice.findUnique.mockResolvedValue(null);

      await expect(PowerOutletRecord.createForDevice(deviceId, { name: 'Outlet-01' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate name on the same device', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(PowerOutletRecord.createForDevice(deviceId, { name: 'Outlet-01' })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('updateById', () => {
    it('updates within the caller supplier scope (relation filter lands in update WHERE)', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullOutlet).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullOutlet, name: 'Outlet-02' });

      const result = await PowerOutletRecord.updateById('po-1', { name: 'Outlet-02' });

      expect(mockDelegate.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'po-1', device: { supplierId: supplierOrgId } },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'po-1', device: { supplierId: supplierOrgId } },
        data: { name: 'Outlet-02' },
      });
      expect(result.data.name).toBe('Outlet-02');
    });

    it('throws NotFoundException when the power outlet is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PowerOutletRecord.updateById('po-1', { name: 'x' })).rejects.toThrow(NotFoundException);
    });

    it('rejects update when new name conflicts on same device', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullOutlet).mockResolvedValueOnce({ id: 'other' });

      await expect(PowerOutletRecord.updateById('po-1', { name: 'Outlet-02' })).rejects.toThrow(ConflictException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('refreshes DB-bumped fields (e.g. updatedAt) on the record after save', async () => {
      const beforeUpdatedAt = new Date('2026-01-01T00:00:00Z');
      const afterUpdatedAt = new Date('2026-01-01T00:00:05Z');
      const before = { ...fullOutlet, updatedAt: beforeUpdatedAt };
      const after = { ...fullOutlet, name: 'Outlet-02', updatedAt: afterUpdatedAt };

      mockDelegate.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue(after);

      const result = await PowerOutletRecord.updateById('po-1', { name: 'Outlet-02' });

      expect(result.data.updatedAt).toEqual(afterUpdatedAt);
      expect(result.data.name).toBe('Outlet-02');
    });
  });

  describe('deleteById', () => {
    it('deletes when the power outlet is visible to the caller (relation filter lands in delete WHERE)', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullOutlet);
      await PowerOutletRecord.deleteById('po-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'po-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('throws NotFoundException when the power outlet is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PowerOutletRecord.deleteById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  it('createForDevice fails closed when no request context is bound', async () => {
    ActiveRecordRegistry.configureForTest({ powerOutlet: mockDelegate, device: mockDevice }, null);
    await expect(PowerOutletRecord.createForDevice(deviceId, { name: 'Outlet-01' })).rejects.toThrow(
      /Permission context required/,
    );
  });
});
