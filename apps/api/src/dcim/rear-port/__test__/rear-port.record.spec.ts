import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { PortType } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RearPortRecord } from '../rear-port.record';

describe('RearPortRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockFrontPort = { count: vi.fn() };
  const mockDevice = { findUnique: vi.fn() };

  const supplierOrgId = 'supplier-org-1';
  const deviceId = 'device-1';

  const fullRearPort = {
    id: 'rp-1',
    deviceId,
    name: 'RP-01',
    type: PortType.MPO,
    positions: 12,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest(
      { rearPort: mockDelegate, frontPort: mockFrontPort, device: mockDevice },
      () => ({
        organizationId: supplierOrgId,
        permissions: new Set(['dcim:read', 'dcim:create', 'dcim:update', 'dcim:delete']),
      }),
    );
  });

  afterEach(() => vi.resetAllMocks());

  describe('listPaginated', () => {
    beforeEach(() => {
      (mockDelegate as { count?: ReturnType<typeof vi.fn> }).count = vi.fn().mockResolvedValue(0);
    });

    it('applies default sort + page size + scoped where to both findMany and count', async () => {
      mockDelegate.findMany.mockResolvedValue([fullRearPort]);
      const countSpy = mockDelegate as unknown as { count: ReturnType<typeof vi.fn> };
      countSpy.count.mockResolvedValue(1);

      const result = await RearPortRecord.listPaginated({});

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

      await RearPortRecord.listPaginated({ deviceId, type: PortType.MPO });

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            device: { supplierId: supplierOrgId },
            AND: [{ deviceId }, { type: PortType.MPO }],
          },
        }),
      );
    });
  });

  describe('findByIdOrThrow', () => {
    it('auto-scopes via parent device', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRearPort);

      const found = await RearPortRecord.findByIdOrThrow('rp-1');
      expect(found.data.id).toBe('rp-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'rp-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('throws NotFoundException for a foreign-supplier rear port', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(RearPortRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a rear port on a foreign-supplier device is invisible to the caller', async () => {
      const foreignPort = { ...fullRearPort };
      mockDelegate.findFirst.mockImplementation((args: { where: { device?: { supplierId?: string } } }) =>
        Promise.resolve(args.where.device?.supplierId === 'other-supplier' ? foreignPort : null),
      );

      await expect(RearPortRecord.findByIdOrThrow('rp-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'rp-1', device: { supplierId: supplierOrgId } },
      });
    });
  });

  describe('createForDevice', () => {
    it('creates when the parent device is owned by the caller', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullRearPort);

      await RearPortRecord.createForDevice(deviceId, { name: 'RP-01', type: PortType.MPO, positions: 12 });

      expect(mockDevice.findUnique).toHaveBeenCalledWith({
        where: { id: deviceId, supplierId: supplierOrgId },
        select: { id: true },
      });
      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: { deviceId, name: 'RP-01', type: PortType.MPO, positions: 12 },
      });
    });

    it('defaults positions to 1 when not provided', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue({ ...fullRearPort, positions: 1 });

      await RearPortRecord.createForDevice(deviceId, { name: 'RP-01', type: PortType.LC });

      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: { deviceId, name: 'RP-01', type: PortType.LC, positions: 1 },
      });
    });

    it('rejects create when device is not owned by the caller', async () => {
      mockDevice.findUnique.mockResolvedValue(null);

      await expect(RearPortRecord.createForDevice(deviceId, { name: 'RP-01', type: PortType.MPO })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate name on the same device', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(RearPortRecord.createForDevice(deviceId, { name: 'RP-01', type: PortType.MPO })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('updateById', () => {
    it('updates within the caller supplier scope (relation filter lands in update WHERE)', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullRearPort).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullRearPort, name: 'RP-02' });

      const result = await RearPortRecord.updateById('rp-1', { name: 'RP-02' });

      expect(mockDelegate.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'rp-1', device: { supplierId: supplierOrgId } },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'rp-1', device: { supplierId: supplierOrgId } },
        data: { name: 'RP-02' },
      });
      expect(result.data.name).toBe('RP-02');
    });

    it('throws NotFoundException when the rear port is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(RearPortRecord.updateById('rp-1', { name: 'RP-02' })).rejects.toThrow(NotFoundException);
    });

    it('rejects positions reduction below front port count', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullRearPort);
      mockFrontPort.count.mockResolvedValue(8);

      await expect(RearPortRecord.updateById('rp-1', { positions: 6 })).rejects.toThrow(BadRequestException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('allows positions increase', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullRearPort);
      mockFrontPort.count.mockResolvedValue(4);
      mockDelegate.update.mockResolvedValue({ ...fullRearPort, positions: 24 });

      const result = await RearPortRecord.updateById('rp-1', { positions: 24 });
      expect(result.data.positions).toBe(24);
    });

    it('refreshes DB-bumped fields (e.g. updatedAt) on the record after save', async () => {
      const beforeUpdatedAt = new Date('2026-01-01T00:00:00Z');
      const afterUpdatedAt = new Date('2026-01-01T00:00:05Z');
      const before = { ...fullRearPort, updatedAt: beforeUpdatedAt };
      const after = { ...fullRearPort, name: 'RP-02', updatedAt: afterUpdatedAt };

      mockDelegate.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue(after);

      const result = await RearPortRecord.updateById('rp-1', { name: 'RP-02' });

      expect(result.data.updatedAt).toEqual(afterUpdatedAt);
      expect(result.data.name).toBe('RP-02');
    });
  });

  describe('deleteById', () => {
    it('deletes when the rear port is visible to the caller (relation filter lands in delete WHERE)', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRearPort);

      await RearPortRecord.deleteById('rp-1');

      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'rp-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('throws NotFoundException when the rear port is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(RearPortRecord.deleteById('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
