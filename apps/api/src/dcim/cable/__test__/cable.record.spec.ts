import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { CableSide, CableStatus, CableTerminationType, CableType, Prisma } from '@repo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CablePresenter } from '../cable.presenter';
import { CableRecord } from '../cable.record';

describe('CableRecord', () => {
  const mockDelegate = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const portDelegates = {
    interface: { findMany: vi.fn() },
    consolePort: { findMany: vi.fn() },
    consoleServerPort: { findMany: vi.fn() },
    powerPort: { findMany: vi.fn() },
    powerOutlet: { findMany: vi.fn() },
    frontPort: { findMany: vi.fn() },
    rearPort: { findMany: vi.fn() },
    cableTermination: { findMany: vi.fn(), findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  };

  const validTerminations = [
    { cableSide: CableSide.A, terminationType: CableTerminationType.INTERFACE, terminationId: 'if-1' },
    { cableSide: CableSide.B, terminationType: CableTerminationType.INTERFACE, terminationId: 'if-2' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    portDelegates.cableTermination.findFirst.mockResolvedValue(null);
    ActiveRecordRegistry.configureForTest({ cable: mockDelegate, ...portDelegates }, () => ({
      organizationId: 'org-1',
      permissions: new Set(['dcim:read', 'dcim:create', 'dcim:update', 'dcim:delete']),
    }));
  });

  describe('createWithTerminations', () => {
    it('creates a cable with valid terminations', async () => {
      const created = {
        id: 'cable-1',
        type: null,
        status: CableStatus.CONNECTED,
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        terminations: validTerminations,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDelegate.create.mockResolvedValue(created);

      const result = await CableRecord.createWithTerminations({ terminations: validTerminations });
      expect(result.data.id).toBe('cable-1');
      expect(mockDelegate.create).toHaveBeenCalled();
    });

    it('rejects cable with length but no lengthUnit', async () => {
      await expect(
        CableRecord.createWithTerminations({ length: 10, lengthUnit: null, terminations: validTerminations }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        CableRecord.createWithTerminations({ length: 10, lengthUnit: null, terminations: validTerminations }),
      ).rejects.toThrow('Length unit is required when length is set');
    });

    it('rejects self-connection', async () => {
      const selfTerminations = [
        { cableSide: CableSide.A, terminationType: CableTerminationType.INTERFACE, terminationId: 'if-1' },
        { cableSide: CableSide.B, terminationType: CableTerminationType.INTERFACE, terminationId: 'if-1' },
      ];

      await expect(CableRecord.createWithTerminations({ terminations: selfTerminations })).rejects.toThrow(
        'Cannot connect an object to itself',
      );
    });

    it('rejects incompatible termination types', async () => {
      const incompatibleTerminations = [
        { cableSide: CableSide.A, terminationType: CableTerminationType.POWER_PORT, terminationId: 'pp-1' },
        { cableSide: CableSide.B, terminationType: CableTerminationType.CONSOLE_PORT, terminationId: 'cp-1' },
      ];

      await expect(CableRecord.createWithTerminations({ terminations: incompatibleTerminations })).rejects.toThrow(
        /Incompatible termination types/,
      );
    });

    it('allows compatible types (INTERFACE to INTERFACE)', async () => {
      const created = {
        id: 'cable-1',
        type: null,
        status: 'CONNECTED',
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        terminations: validTerminations,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDelegate.create.mockResolvedValue(created);

      const result = await CableRecord.createWithTerminations({ terminations: validTerminations });
      expect(result.data.id).toBe('cable-1');
    });

    it('rejects a port already terminated by another cable (409, no insert)', async () => {
      portDelegates.cableTermination.findFirst.mockResolvedValue({
        terminationType: CableTerminationType.INTERFACE,
        terminationId: 'if-1',
      });

      await expect(CableRecord.createWithTerminations({ terminations: validTerminations })).rejects.toThrow(
        ConflictException,
      );
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('maps a unique-index race (P2002) to a 409', async () => {
      mockDelegate.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(CableRecord.createWithTerminations({ terminations: validTerminations })).rejects.toThrow(
        ConflictException,
      );
    });

    it('allows compatible types (CONSOLE_PORT to CONSOLE_SERVER_PORT)', async () => {
      const consoleTerminations = [
        { cableSide: CableSide.A, terminationType: CableTerminationType.CONSOLE_PORT, terminationId: 'cp-1' },
        { cableSide: CableSide.B, terminationType: CableTerminationType.CONSOLE_SERVER_PORT, terminationId: 'csp-1' },
      ];
      const created = {
        id: 'cable-2',
        type: null,
        status: 'CONNECTED',
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        terminations: consoleTerminations,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDelegate.create.mockResolvedValue(created);

      const result = await CableRecord.createWithTerminations({ terminations: consoleTerminations });
      expect(result.data.id).toBe('cable-2');
    });

    it('rejects missing A or B termination', async () => {
      const onlyASide = [
        { cableSide: CableSide.A, terminationType: CableTerminationType.INTERFACE, terminationId: 'if-1' },
      ];

      await expect(CableRecord.createWithTerminations({ terminations: onlyASide })).rejects.toThrow(
        'Cable must have exactly one A-side and one B-side termination',
      );
    });
  });

  describe('updateById', () => {
    it('updates a cable', async () => {
      mockDelegate.findFirst.mockResolvedValue({
        id: 'cable-1',
        type: null,
        status: 'CONNECTED',
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const updated = {
        id: 'cable-1',
        type: CableType.CAT6A,
        status: CableStatus.CONNECTED,
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        terminations: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDelegate.update.mockResolvedValue(updated);

      const result = await CableRecord.updateById('cable-1', { type: CableType.CAT6A });
      expect(result.data.id).toBe('cable-1');
    });
  });

  describe('permission gating', () => {
    it('rejects updateById for a caller holding only dcim:update (no dcim:read)', async () => {
      ActiveRecordRegistry.configureForTest({ cable: mockDelegate, ...portDelegates }, () => ({
        organizationId: 'org-1',
        permissions: new Set(['dcim:update']),
      }));

      await expect(CableRecord.updateById('cable-1', { type: CableType.CAT6A })).rejects.toThrow(ForbiddenException);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('rejects deleteById for a caller holding only dcim:delete (no dcim:read)', async () => {
      ActiveRecordRegistry.configureForTest({ cable: mockDelegate, ...portDelegates }, () => ({
        organizationId: 'org-1',
        permissions: new Set(['dcim:delete']),
      }));

      await expect(CableRecord.deleteById('cable-1')).rejects.toThrow(ForbiddenException);
      expect(mockDelegate.delete).not.toHaveBeenCalled();
    });
  });

  describe('CablePresenter.toResponse', () => {
    it('converts length to number', () => {
      const record = CableRecord.build({
        id: 'cable-1',
        type: null,
        status: 'CONNECTED',
        label: null,
        color: null,
        length: 10.5,
        lengthUnit: 'METERS',
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const response = CablePresenter.toResponse(record);
      expect(response.length).toBe(10.5);
      expect(typeof response.length).toBe('number');
    });

    it('returns null for null length', () => {
      const record = CableRecord.build({
        id: 'cable-1',
        type: null,
        status: 'CONNECTED',
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const response = CablePresenter.toResponse(record);
      expect(response.length).toBeNull();
    });
  });

  describe('createWithTerminations with supplier scope', () => {
    it('rejects when any termination points to a port outside the supplier org', async () => {
      portDelegates.interface.findMany.mockResolvedValue([{ id: 'if-1' }]);

      await expect(
        CableRecord.createWithTerminations({ terminations: validTerminations }, 'supplier-1'),
      ).rejects.toThrow(ForbiddenException);

      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('creates when all terminations belong to the supplier', async () => {
      portDelegates.interface.findMany.mockResolvedValue([{ id: 'if-1' }, { id: 'if-2' }]);
      mockDelegate.create.mockResolvedValue({
        id: 'cable-1',
        type: null,
        status: CableStatus.CONNECTED,
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await CableRecord.createWithTerminations({ terminations: validTerminations }, 'supplier-1');

      expect(result.data.id).toBe('cable-1');
      expect(portDelegates.interface.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['if-1', 'if-2'] }, device: { supplierId: 'supplier-1' } },
        select: { id: true },
      });
    });
  });

  describe('findByIdOrThrow with supplier scope', () => {
    it('returns NotFound when the cable has a foreign termination', async () => {
      mockDelegate.findFirst.mockResolvedValue({
        id: 'cable-foreign',
        type: null,
        status: 'CONNECTED',
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      portDelegates.cableTermination.findMany.mockResolvedValue([
        { terminationType: CableTerminationType.INTERFACE, terminationId: 'if-foreign' },
        { terminationType: CableTerminationType.INTERFACE, terminationId: 'if-other-foreign' },
      ]);
      portDelegates.interface.findMany.mockResolvedValue([]);

      await expect(CableRecord.findByIdOrThrow('cable-foreign', 'caller-org')).rejects.toThrow(NotFoundException);
    });

    it('returns the cable when every termination is owned by the supplier', async () => {
      mockDelegate.findFirst.mockResolvedValue({
        id: 'cable-1',
        type: null,
        status: 'CONNECTED',
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      portDelegates.cableTermination.findMany.mockResolvedValue([
        { terminationType: CableTerminationType.INTERFACE, terminationId: 'if-1' },
        { terminationType: CableTerminationType.INTERFACE, terminationId: 'if-2' },
      ]);
      portDelegates.interface.findMany.mockResolvedValue([{ id: 'if-1' }, { id: 'if-2' }]);

      const result = await CableRecord.findByIdOrThrow('cable-1', 'caller-org');
      expect(result.data.id).toBe('cable-1');
    });
  });

  describe('listPaginated with supplier scope', () => {
    const row = (id: string) => ({
      id,
      type: null,
      status: CableStatus.CONNECTED,
      label: null,
      color: null,
      length: null,
      lengthUnit: null,
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    it('hydrates the SQL page in page order and reports the SQL total', async () => {
      portDelegates.$queryRaw
        .mockResolvedValueOnce([{ id: 'c-3' }, { id: 'c-1' }])
        .mockResolvedValueOnce([{ count: 31707 }]);
      mockDelegate.findMany.mockResolvedValue([row('c-1'), row('c-3')]);

      const result = await CableRecord.listPaginated({ page: 2, pageSize: 2 }, 'org-1');

      expect(result.data.map((c) => c.data.id)).toEqual(['c-3', 'c-1']);
      expect(result.meta).toEqual({ page: 2, pageSize: 2, totalItems: 31707, totalPages: 15854 });
      expect(mockDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['c-3', 'c-1'] } } }),
      );
      expect(portDelegates.interface.findMany).not.toHaveBeenCalled();
    });
  });

  describe('deleteById with supplier scope', () => {
    it('refuses to delete a cable whose terminations are on another tenant', async () => {
      mockDelegate.findFirst.mockResolvedValue({
        id: 'cable-foreign',
        type: null,
        status: 'CONNECTED',
        label: null,
        color: null,
        length: null,
        lengthUnit: null,
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      portDelegates.cableTermination.findMany.mockResolvedValue([
        { terminationType: CableTerminationType.INTERFACE, terminationId: 'if-foreign' },
      ]);
      portDelegates.interface.findMany.mockResolvedValue([]);

      await expect(CableRecord.deleteById('cable-foreign', 'caller-org')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.delete).not.toHaveBeenCalled();
    });
  });
});
