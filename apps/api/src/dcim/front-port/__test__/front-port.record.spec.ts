import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { PortType } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontPortRecord } from '../front-port.record';

describe('FrontPortRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockRearPort = { findFirst: vi.fn() };
  const mockDevice = { findUnique: vi.fn() };

  const supplierOrgId = 'supplier-org-1';
  const deviceId = 'device-1';
  const rearPortId = 'rp-1';

  const fullRearPort = {
    id: rearPortId,
    deviceId,
    name: 'RP-01',
    type: 'MPO',
    positions: 12,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const fullFrontPort = {
    id: 'fp-1',
    deviceId,
    rearPortId,
    rearPortPosition: 1,
    name: 'FP-01',
    type: PortType.LC,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest(
      {
        frontPort: mockDelegate,
        rearPort: mockRearPort,
        device: mockDevice,
      },
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
      mockDelegate.findMany.mockResolvedValue([fullFrontPort]);
      const countSpy = mockDelegate as unknown as { count: ReturnType<typeof vi.fn> };
      countSpy.count.mockResolvedValue(1);

      const result = await FrontPortRecord.listPaginated({});

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

    it('merges discrete filters (deviceId, rearPortId) into the scoped where', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await FrontPortRecord.listPaginated({ deviceId, rearPortId: 'rp-1' });

      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            device: { supplierId: supplierOrgId },
            AND: [{ deviceId }, { rearPortId: 'rp-1' }],
          },
        }),
      );
    });
  });

  describe('findByIdOrThrow', () => {
    it('auto-scopes via parent device', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullFrontPort);
      const found = await FrontPortRecord.findByIdOrThrow('fp-1');
      expect(found.data.id).toBe('fp-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'fp-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('throws NotFoundException for a foreign-supplier front port', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(FrontPortRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a front port on a foreign-supplier device is invisible to the caller', async () => {
      const foreignPort = { ...fullFrontPort };
      mockDelegate.findFirst.mockImplementation((args: { where: { device?: { supplierId?: string } } }) =>
        Promise.resolve(args.where.device?.supplierId === 'other-supplier' ? foreignPort : null),
      );

      await expect(FrontPortRecord.findByIdOrThrow('fp-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'fp-1', device: { supplierId: supplierOrgId } },
      });
    });
  });

  describe('createForDevice', () => {
    it('creates when the parent device is owned, rear port exists on same device, and position valid', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockRearPort.findFirst.mockResolvedValue(fullRearPort);
      mockDelegate.create.mockResolvedValue(fullFrontPort);

      await FrontPortRecord.createForDevice(deviceId, {
        name: 'FP-01',
        type: PortType.LC,
        rearPortId,
        rearPortPosition: 3,
      });

      expect(mockDevice.findUnique).toHaveBeenCalledWith({
        where: { id: deviceId, supplierId: supplierOrgId },
        select: { id: true },
      });
      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: { deviceId, name: 'FP-01', type: PortType.LC, rearPortId, rearPortPosition: 3 },
      });
    });

    it('defaults rearPortPosition to 1 when omitted', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockRearPort.findFirst.mockResolvedValue(fullRearPort);
      mockDelegate.create.mockResolvedValue(fullFrontPort);

      await FrontPortRecord.createForDevice(deviceId, { name: 'FP-01', type: PortType.LC, rearPortId });

      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: { deviceId, name: 'FP-01', type: PortType.LC, rearPortId, rearPortPosition: 1 },
      });
    });

    it('scopes the rear-port lookup by the caller supplier (via the tenant-scoped RearPortRecord)', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockRearPort.findFirst.mockResolvedValue(fullRearPort);
      mockDelegate.create.mockResolvedValue(fullFrontPort);

      await FrontPortRecord.createForDevice(deviceId, { name: 'FP-01', type: PortType.LC, rearPortId });

      expect(mockRearPort.findFirst).toHaveBeenCalledWith({
        where: { id: rearPortId, device: { supplierId: supplierOrgId } },
      });
    });

    it('rejects create when rear port belongs to a different device', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockRearPort.findFirst.mockResolvedValue({ ...fullRearPort, deviceId: 'different-device' });

      await expect(
        FrontPortRecord.createForDevice(deviceId, { name: 'FP-01', type: PortType.LC, rearPortId }),
      ).rejects.toThrow(BadRequestException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects create when rear port not found (or invisible to caller)', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockRearPort.findFirst.mockResolvedValue(null);

      await expect(
        FrontPortRecord.createForDevice(deviceId, { name: 'FP-01', type: PortType.LC, rearPortId }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects create when rearPortPosition exceeds rear port positions', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockRearPort.findFirst.mockResolvedValue(fullRearPort);

      await expect(
        FrontPortRecord.createForDevice(deviceId, {
          name: 'FP-01',
          type: PortType.LC,
          rearPortId,
          rearPortPosition: 13,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects create when rearPortPosition below 1', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockRearPort.findFirst.mockResolvedValue(fullRearPort);

      await expect(
        FrontPortRecord.createForDevice(deviceId, {
          name: 'FP-01',
          type: PortType.LC,
          rearPortId,
          rearPortPosition: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects create when device is not owned by the caller', async () => {
      mockDevice.findUnique.mockResolvedValue(null);

      await expect(
        FrontPortRecord.createForDevice(deviceId, { name: 'FP-01', type: PortType.LC, rearPortId }),
      ).rejects.toThrow(NotFoundException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate name on the same device', async () => {
      mockDevice.findUnique.mockResolvedValue({ id: deviceId });
      mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        FrontPortRecord.createForDevice(deviceId, { name: 'FP-01', type: PortType.LC, rearPortId }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updateById', () => {
    it('updates within the caller supplier scope (relation filter lands in update WHERE)', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullFrontPort).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullFrontPort, name: 'FP-02' });

      const result = await FrontPortRecord.updateById('fp-1', { name: 'FP-02' });

      expect(mockDelegate.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'fp-1', device: { supplierId: supplierOrgId } },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'fp-1', device: { supplierId: supplierOrgId } },
        data: { name: 'FP-02' },
      });
      expect(result.data.name).toBe('FP-02');
    });

    it('throws NotFoundException when the front port is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(FrontPortRecord.updateById('fp-1', { name: 'x' })).rejects.toThrow(NotFoundException);
    });

    it('rejects update when new name conflicts on same device', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullFrontPort).mockResolvedValueOnce({ id: 'other' });

      await expect(FrontPortRecord.updateById('fp-1', { name: 'FP-02' })).rejects.toThrow(ConflictException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('does NOT revalidate the rear port when only name changes', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullFrontPort).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullFrontPort, name: 'FP-02' });

      await FrontPortRecord.updateById('fp-1', { name: 'FP-02' });

      expect(mockRearPort.findFirst).not.toHaveBeenCalled();
    });

    it('revalidates the rear port when rearPortId changes', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullFrontPort);
      mockRearPort.findFirst.mockResolvedValue({ ...fullRearPort, id: 'rp-2' });
      mockDelegate.update.mockResolvedValue({ ...fullFrontPort, rearPortId: 'rp-2' });

      await FrontPortRecord.updateById('fp-1', { rearPortId: 'rp-2' });

      expect(mockRearPort.findFirst).toHaveBeenCalledWith({
        where: { id: 'rp-2', device: { supplierId: supplierOrgId } },
      });
    });

    it('rejects update when new rearPortPosition exceeds existing rear port positions', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullFrontPort);
      mockRearPort.findFirst.mockResolvedValue(fullRearPort);

      await expect(FrontPortRecord.updateById('fp-1', { rearPortPosition: 99 })).rejects.toThrow(BadRequestException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('rejects update when new rearPortId points to a different device', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullFrontPort);
      mockRearPort.findFirst.mockResolvedValue({ ...fullRearPort, id: 'rp-2', deviceId: 'different-device' });

      await expect(FrontPortRecord.updateById('fp-1', { rearPortId: 'rp-2' })).rejects.toThrow(BadRequestException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('refreshes DB-bumped fields (e.g. updatedAt) on the record after save', async () => {
      const beforeUpdatedAt = new Date('2026-01-01T00:00:00Z');
      const afterUpdatedAt = new Date('2026-01-01T00:00:05Z');
      const before = { ...fullFrontPort, updatedAt: beforeUpdatedAt };
      const after = { ...fullFrontPort, name: 'FP-02', updatedAt: afterUpdatedAt };

      mockDelegate.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue(after);

      const result = await FrontPortRecord.updateById('fp-1', { name: 'FP-02' });

      expect(result.data.updatedAt).toEqual(afterUpdatedAt);
      expect(result.data.name).toBe('FP-02');
    });
  });

  describe('deleteById', () => {
    it('deletes when the front port is visible to the caller (relation filter lands in delete WHERE)', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullFrontPort);
      await FrontPortRecord.deleteById('fp-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'fp-1', device: { supplierId: supplierOrgId } },
      });
    });

    it('throws NotFoundException when the front port is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(FrontPortRecord.deleteById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  it('createForDevice fails closed when no request context is bound', async () => {
    ActiveRecordRegistry.configureForTest(
      { frontPort: mockDelegate, rearPort: mockRearPort, device: mockDevice },
      null,
    );
    await expect(
      FrontPortRecord.createForDevice(deviceId, { name: 'FP-01', type: PortType.LC, rearPortId }),
    ).rejects.toThrow(/Permission context required/);
  });
});
