import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { CircuitStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitRecord } from '../circuit.record';

describe('CircuitRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockProviderDelegate = { findFirst: vi.fn() };
  const mockCircuitTypeDelegate = { findFirst: vi.fn() };

  const orgId = 'org-1';

  const fullCircuit = {
    id: 'c-1',
    cid: 'CKT-001',
    status: CircuitStatus.ACTIVE,
    installDate: null,
    terminationDate: null,
    commitRate: null,
    description: null,
    comments: null,
    providerId: 'p-1',
    circuitTypeId: 'ct-1',
    organizationId: orgId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const fullProvider = {
    id: 'p-1',
    name: 'Cogent',
    slug: 'cogent',
    description: null,
    comments: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const fullCircuitType = {
    id: 'ct-1',
    name: 'Transit',
    slug: 'transit',
    color: null,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest(
      {
        circuit: mockDelegate,
        provider: mockProviderDelegate,
        circuitType: mockCircuitTypeDelegate,
      },
      () => ({
        organizationId: orgId,
        permissions: new Set(['network:read', 'network:create', 'network:update', 'network:delete']),
      }),
    );
  });

  afterEach(() => vi.resetAllMocks());

  describe('list', () => {
    it('auto-scopes by ctx.organizationId', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await CircuitRecord.list({});
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { organizationId: orgId },
        orderBy: { cid: 'asc' },
      });
    });

    it('layers filter args on top of the tenant scope', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await CircuitRecord.list({ providerId: 'p-1', circuitTypeId: 'ct-1', status: CircuitStatus.OFFLINE });
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: orgId,
          providerId: 'p-1',
          circuitTypeId: 'ct-1',
          status: CircuitStatus.OFFLINE,
        },
        orderBy: { cid: 'asc' },
      });
    });

    it('applies a case-insensitive cid search', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await CircuitRecord.list({ search: 'ACME-42' });
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { organizationId: orgId, cid: { contains: 'ACME-42', mode: 'insensitive' } },
        orderBy: { cid: 'asc' },
      });
    });
  });

  describe('findByIdOrThrow', () => {
    it('finds when the circuit belongs to the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullCircuit);
      const result = await CircuitRecord.findByIdOrThrow('c-1');
      expect(result.data.id).toBe('c-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'c-1', organizationId: orgId },
      });
    });

    it('throws NotFoundException when not in the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(CircuitRecord.findByIdOrThrow('c-1')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a circuit owned by another tenant is invisible to the caller', async () => {
      const foreignCircuit = { ...fullCircuit, organizationId: 'other-tenant' };
      mockDelegate.findFirst.mockImplementation((args: { where: { organizationId?: string } }) =>
        Promise.resolve(args.where.organizationId === 'other-tenant' ? foreignCircuit : null),
      );

      await expect(CircuitRecord.findByIdOrThrow('c-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'c-1', organizationId: orgId },
      });
    });
  });

  describe('create', () => {
    it('stamps organizationId from ctx', async () => {
      mockProviderDelegate.findFirst.mockResolvedValue(fullProvider);
      mockCircuitTypeDelegate.findFirst.mockResolvedValue(fullCircuitType);
      mockDelegate.create.mockResolvedValue(fullCircuit);

      await CircuitRecord.create({ cid: 'CKT-001', providerId: 'p-1', circuitTypeId: 'ct-1' });

      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cid: 'CKT-001',
          providerId: 'p-1',
          circuitTypeId: 'ct-1',
          organizationId: orgId,
        }),
      });
    });

    it('rejects when provider does not exist', async () => {
      mockProviderDelegate.findFirst.mockResolvedValue(null);
      await expect(CircuitRecord.create({ cid: 'x', providerId: 'nope', circuitTypeId: 'ct-1' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects when circuit type does not exist', async () => {
      mockProviderDelegate.findFirst.mockResolvedValue(fullProvider);
      mockCircuitTypeDelegate.findFirst.mockResolvedValue(null);
      await expect(CircuitRecord.create({ cid: 'x', providerId: 'p-1', circuitTypeId: 'nope' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe('updateById', () => {
    it('updates within the scoped org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullCircuit);
      mockDelegate.update.mockResolvedValue({ ...fullCircuit, cid: 'CKT-002' });

      const result = await CircuitRecord.updateById('c-1', { cid: 'CKT-002' });

      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'c-1', organizationId: orgId },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'c-1', organizationId: orgId },
        data: { cid: 'CKT-002' },
      });
      expect(result.data.cid).toBe('CKT-002');
    });

    it('drops any client-supplied organizationId from the update body', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullCircuit);
      mockDelegate.update.mockResolvedValue(fullCircuit);

      await CircuitRecord.updateById('c-1', {
        cid: 'CKT-002',
        organizationId: 'victim-org-uuid',
      } as Parameters<typeof CircuitRecord.updateById>[1]);

      const updateCall = mockDelegate.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('organizationId');
    });
  });

  describe('deleteById', () => {
    it('deletes within the scoped org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullCircuit);
      await CircuitRecord.deleteById('c-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'c-1', organizationId: orgId },
      });
    });
  });
});
