import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { RackFace, RackRole, RackStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RackRecord } from '../rack.record';

describe('RackRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockZone = { findUnique: vi.fn() };
  const mockAssignment = { findMany: vi.fn() };

  const zoneId = 'zone-1';
  const orgId = 'org-1';

  const fullRack = {
    id: 'rack-1',
    name: 'PHX1-A2',
    status: RackStatus.ACTIVE,
    role: RackRole.COMPUTE,
    heightU: 42,
    startingUnit: 1,
    description: null,
    serial: null,
    assetTag: null,
    zoneId,
    organizationId: orgId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest(
      {
        rack: mockDelegate,
        zone: mockZone,
        deviceRackAssignment: mockAssignment,
      },
      () => ({
        organizationId: orgId,
        permissions: new Set(['dcim:read', 'dcim:create', 'dcim:update', 'dcim:delete']),
      }),
    );
  });

  afterEach(() => vi.resetAllMocks());

  describe('listByZone', () => {
    it('auto-scopes by rack.organizationId (flat policy)', async () => {
      mockDelegate.findMany.mockResolvedValue([fullRack]);
      await RackRecord.listByZone(zoneId);

      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { zoneId, organizationId: orgId },
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('findByIdOrThrow', () => {
    it('auto-scopes by rack.organizationId', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRack);
      const found = await RackRecord.findByIdOrThrow('rack-1');

      expect(found.data.id).toBe('rack-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'rack-1', organizationId: orgId },
      });
    });

    it('throws NotFoundException for a foreign-tenant rack', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(RackRecord.findByIdOrThrow('missing')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a foreign-tenant rack is invisible to the caller', async () => {
      const foreignRack = { ...fullRack, organizationId: 'other-tenant' };
      mockDelegate.findFirst.mockImplementation((args: { where: { organizationId?: unknown } }) =>
        Promise.resolve(args.where.organizationId === 'other-tenant' ? foreignRack : null),
      );

      await expect(RackRecord.findByIdOrThrow('rack-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'rack-1', organizationId: orgId },
      });
    });

    it('a platform (null-org) rack is invisible to tenants even if its parent zone is theirs', async () => {
      const platformRack = { ...fullRack, organizationId: null };
      mockDelegate.findFirst.mockImplementation((args: { where: { organizationId?: unknown } }) =>
        Promise.resolve(args.where.organizationId === null ? platformRack : null),
      );

      await expect(RackRecord.findByIdOrThrow('rack-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'rack-1', organizationId: orgId },
      });
    });
  });

  describe('create', () => {
    it('creates when parent zone is owned by the caller', async () => {
      mockZone.findUnique.mockResolvedValue({ id: zoneId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullRack);

      await RackRecord.create({ name: 'PHX1-A2', zoneId });

      expect(mockZone.findUnique).toHaveBeenCalledWith({
        where: { id: zoneId, organizationId: orgId },
        select: { id: true },
      });
    });

    it('stamps rack.organizationId from ctx (matches the owning zone)', async () => {
      mockZone.findUnique.mockResolvedValue({ id: zoneId });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullRack);

      await RackRecord.create({ name: 'PHX1-A2', zoneId });

      const createCall = mockDelegate.create.mock.calls[0][0];
      expect(createCall.data.organizationId).toBe(orgId);
    });

    it('rejects when zone is not owned by the caller', async () => {
      mockZone.findUnique.mockResolvedValue(null);

      await expect(RackRecord.create({ name: 'PHX1-A2', zoneId })).rejects.toThrow(NotFoundException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate name in the same zone', async () => {
      mockZone.findUnique.mockResolvedValue({ id: zoneId });
      mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(RackRecord.create({ name: 'PHX1-A2', zoneId })).rejects.toThrow(ConflictException);
    });

    it('rejects heightU < 1', async () => {
      mockZone.findUnique.mockResolvedValue({ id: zoneId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(RackRecord.create({ name: 'PHX1-A2', zoneId, heightU: 0 })).rejects.toThrow(BadRequestException);
    });

    it('rejects startingUnit < 1', async () => {
      mockZone.findUnique.mockResolvedValue({ id: zoneId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(RackRecord.create({ name: 'PHX1-A2', zoneId, startingUnit: 0 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an unbounded heightU that would blow up getElevation', async () => {
      mockZone.findUnique.mockResolvedValue({ id: zoneId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(RackRecord.create({ name: 'PHX1-A2', zoneId, heightU: 2_000_000_000 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an unbounded startingUnit', async () => {
      mockZone.findUnique.mockResolvedValue({ id: zoneId });
      mockDelegate.findFirst.mockResolvedValue(null);

      await expect(RackRecord.create({ name: 'PHX1-A2', zoneId, startingUnit: 2_000_000_000 })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('updateById', () => {
    it('updates within the caller org and pins WHERE to the record org', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullRack).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullRack, name: 'PHX1-A3' });

      await RackRecord.updateById('rack-1', { name: 'PHX1-A3' });

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'rack-1', organizationId: orgId },
        data: { name: 'PHX1-A3' },
      });
    });

    it('throws NotFoundException when the rack is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(null);
      await expect(RackRecord.updateById('rack-1', { name: 'x' })).rejects.toThrow(NotFoundException);
    });

    it('rejects height reduction when a device would overflow', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullRack);
      mockAssignment.findMany.mockResolvedValue([{ position: 40, heightU: 4 }]);

      await expect(RackRecord.updateById('rack-1', { heightU: 30 })).rejects.toThrow(BadRequestException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('allows height reduction when no device would overflow', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullRack);
      mockAssignment.findMany.mockResolvedValue([{ position: 5, heightU: 2 }]);
      mockDelegate.update.mockResolvedValue({ ...fullRack, heightU: 24 });

      await RackRecord.updateById('rack-1', { heightU: 24 });

      expect(mockDelegate.update).toHaveBeenCalled();
    });

    it('drops any client-supplied organizationId from the update body', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullRack);
      mockDelegate.update.mockResolvedValue(fullRack);

      await RackRecord.updateById('rack-1', {
        status: RackStatus.PLANNED,
        organizationId: 'victim-org-uuid',
      } as Parameters<typeof RackRecord.updateById>[1]);

      const updateCall = mockDelegate.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('organizationId');
    });
  });

  describe('deleteById', () => {
    it('deletes within the caller org and pins WHERE to the record org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRack);
      await RackRecord.deleteById('rack-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'rack-1', organizationId: orgId },
      });
    });

    it('throws NotFoundException for a foreign-tenant rack', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(RackRecord.deleteById('rack-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.delete).not.toHaveBeenCalled();
    });
  });

  describe('getElevation', () => {
    it('returns unit breakdown with correct occupancy', async () => {
      mockDelegate.findFirst.mockResolvedValue({
        ...fullRack,
        startingUnit: 1,
        heightU: 4,
      });
      mockAssignment.findMany.mockResolvedValue([
        { face: RackFace.FRONT, heightU: 2, position: 2, device: { id: 'dev-1', name: 'server-1' } },
      ]);

      const units = await RackRecord.getElevation('rack-1', RackFace.FRONT);

      expect(units).toHaveLength(4);
      expect(units[0]).toEqual({ unit: 1, face: RackFace.FRONT, occupied: false, device: null });
      expect(units[1]).toMatchObject({ unit: 2, face: RackFace.FRONT, occupied: true });
      expect(units[2]).toMatchObject({ unit: 3, face: RackFace.FRONT, occupied: true });
      expect(units[3]).toMatchObject({ unit: 4, face: RackFace.FRONT, occupied: false });
    });

    it('throws when the rack is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(RackRecord.getElevation('rack-1')).rejects.toThrow(NotFoundException);
    });
  });
});
