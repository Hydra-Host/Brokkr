import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { CircuitTerminationSide } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitTerminationRecord } from '../circuit-termination.record';

describe('CircuitTerminationRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockCircuitDelegate = { findUnique: vi.fn() };
  const mockZoneDelegate = { findUnique: vi.fn() };

  const orgId = 'org-1';

  const fullTermination = {
    id: 'ct-1',
    termSide: CircuitTerminationSide.A,
    portSpeed: 1_000_000,
    upstreamSpeed: null,
    xconnectId: null,
    description: null,
    circuitId: 'circuit-1',
    zoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest(
      { circuitTermination: mockDelegate, circuit: mockCircuitDelegate, zone: mockZoneDelegate },
      () => ({
        organizationId: orgId,
        permissions: new Set(['network:read', 'network:create', 'network:update', 'network:delete']),
      }),
    );
  });

  afterEach(() => vi.resetAllMocks());

  describe('list', () => {
    it('auto-scopes via nested where on parent circuit.organizationId', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await CircuitTerminationRecord.list({});

      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { circuit: { organizationId: orgId } },
      });
    });

    it('layers circuitId + zoneId filters alongside the auto-injected parent scope', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await CircuitTerminationRecord.list({ circuitId: 'c-1', zoneId: 'z-1' });

      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: {
          circuitId: 'c-1',
          zoneId: 'z-1',
          circuit: { organizationId: orgId },
        },
      });
    });

    it('searches xconnectId OR description case-insensitively', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await CircuitTerminationRecord.list({ search: 'XC-9' });
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: {
          circuit: { organizationId: orgId },
          OR: [
            { xconnectId: { contains: 'XC-9', mode: 'insensitive' } },
            { description: { contains: 'XC-9', mode: 'insensitive' } },
          ],
        },
      });
    });
  });

  describe('findByIdOrThrow', () => {
    it('auto-scopes via parent', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullTermination);
      const result = await CircuitTerminationRecord.findByIdOrThrow('ct-1');

      expect(result.data.id).toBe('ct-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'ct-1', circuit: { organizationId: orgId } },
      });
    });

    it('throws NotFoundException for a foreign-tenant termination', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(CircuitTerminationRecord.findByIdOrThrow('ct-1')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a termination whose parent circuit is owned by another tenant is invisible to the caller', async () => {
      const foreignTermination = { ...fullTermination, circuitId: 'foreign-circuit' };
      mockDelegate.findFirst.mockImplementation((args: { where: { circuit?: { organizationId?: string } } }) =>
        Promise.resolve(args.where.circuit?.organizationId === 'other-tenant' ? foreignTermination : null),
      );

      await expect(CircuitTerminationRecord.findByIdOrThrow('ct-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'ct-1', circuit: { organizationId: orgId } },
      });
    });
  });

  describe('create', () => {
    it('proceeds when the parent circuit belongs to the caller org', async () => {
      mockCircuitDelegate.findUnique.mockResolvedValue({ id: 'circuit-1' });
      mockDelegate.create.mockResolvedValue(fullTermination);

      await CircuitTerminationRecord.create({ termSide: CircuitTerminationSide.A, circuitId: 'circuit-1' });

      expect(mockCircuitDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'circuit-1', organizationId: orgId },
        select: { id: true },
      });
      expect(mockDelegate.create).toHaveBeenCalled();
    });

    it('rejects when the parent circuit does not exist OR belongs to another tenant', async () => {
      mockCircuitDelegate.findUnique.mockResolvedValue(null);

      await expect(
        CircuitTerminationRecord.create({ termSide: CircuitTerminationSide.A, circuitId: 'foreign-circuit' }),
      ).rejects.toThrow(NotFoundException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects a null-org (platform) parent on the tenant write path', async () => {
      mockCircuitDelegate.findUnique.mockImplementation((args: { where: { organizationId?: unknown } }) =>
        Promise.resolve(args.where.organizationId === null ? { id: 'platform-circuit' } : null),
      );

      await expect(
        CircuitTerminationRecord.create({ termSide: CircuitTerminationSide.A, circuitId: 'platform-circuit' }),
      ).rejects.toThrow(NotFoundException);

      expect(mockCircuitDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'platform-circuit', organizationId: orgId },
        select: { id: true },
      });
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects a foreign-org or soft-deleted zoneId', async () => {
      mockCircuitDelegate.findUnique.mockResolvedValue({ id: 'circuit-1' });
      mockZoneDelegate.findUnique.mockResolvedValue(null);

      await expect(
        CircuitTerminationRecord.create({
          termSide: CircuitTerminationSide.A,
          circuitId: 'circuit-1',
          zoneId: 'foreign-zone',
        }),
      ).rejects.toThrow(NotFoundException);

      expect(mockZoneDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'foreign-zone', organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('accepts a same-org zoneId', async () => {
      mockCircuitDelegate.findUnique.mockResolvedValue({ id: 'circuit-1' });
      mockZoneDelegate.findUnique.mockResolvedValue({ id: 'zone-1' });
      mockDelegate.create.mockResolvedValue({ ...fullTermination, zoneId: 'zone-1' });

      const result = await CircuitTerminationRecord.create({
        termSide: CircuitTerminationSide.A,
        circuitId: 'circuit-1',
        zoneId: 'zone-1',
      });

      expect(result.data.zoneId).toBe('zone-1');
      expect(mockDelegate.create).toHaveBeenCalled();
    });
  });

  describe('updateById', () => {
    it('updates within the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullTermination);
      mockDelegate.update.mockResolvedValue({ ...fullTermination, portSpeed: 10_000_000 });

      const result = await CircuitTerminationRecord.updateById('ct-1', { portSpeed: 10_000_000 });

      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'ct-1', circuit: { organizationId: orgId } },
      });
      expect(result.data.portSpeed).toBe(10_000_000);
      expect(mockCircuitDelegate.findUnique).not.toHaveBeenCalled();
      expect(mockDelegate.update.mock.calls[0][0].where).toMatchObject({ circuit: { organizationId: orgId } });
    });

    it('rejects reparenting to a foreign-tenant circuit', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullTermination);
      mockCircuitDelegate.findUnique.mockResolvedValue(null);

      await expect(CircuitTerminationRecord.updateById('ct-1', { circuitId: 'foreign-circuit' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('allows reparenting within the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullTermination);
      mockCircuitDelegate.findUnique.mockResolvedValue({ id: 'circuit-2' });
      mockDelegate.update.mockResolvedValue({ ...fullTermination, circuitId: 'circuit-2' });

      const result = await CircuitTerminationRecord.updateById('ct-1', { circuitId: 'circuit-2' });
      expect(result.data.circuitId).toBe('circuit-2');
    });

    it('throws NotFoundException when the termination is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(CircuitTerminationRecord.updateById('ct-1', { portSpeed: 1 })).rejects.toThrow(NotFoundException);
    });

    it('rejects updating to a foreign-org zoneId', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullTermination);
      mockZoneDelegate.findUnique.mockResolvedValue(null);

      await expect(CircuitTerminationRecord.updateById('ct-1', { zoneId: 'foreign-zone' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteById', () => {
    it('pins the delete WHERE to the parent-circuit tenant filter (not id-only)', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullTermination);
      await CircuitTerminationRecord.deleteById('ct-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'ct-1', circuit: { organizationId: orgId } },
      });
    });

    it('throws NotFoundException for a foreign-tenant termination', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(CircuitTerminationRecord.deleteById('ct-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.delete).not.toHaveBeenCalled();
    });
  });
});
