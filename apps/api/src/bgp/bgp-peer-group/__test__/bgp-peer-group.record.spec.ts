import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BgpPeerGroupRecord } from '../bgp-peer-group.record';

describe('BgpPeerGroupRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const orgId = 'org-1';

  const fullGroup = {
    id: 'pg-1',
    name: 'upstream-transit',
    description: null,
    organizationId: orgId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSessionDelegate = { count: vi.fn().mockResolvedValue(0) };

  beforeEach(() => {
    vi.resetAllMocks();
    mockSessionDelegate.count.mockResolvedValue(0);
    ActiveRecordRegistry.configureForTest({ bgpPeerGroup: mockDelegate, bgpSession: mockSessionDelegate }, () => ({
      organizationId: orgId,
      permissions: new Set(['network:read', 'network:create', 'network:update', 'network:delete']),
    }));
  });

  afterEach(() => vi.resetAllMocks());

  describe('list', () => {
    it('auto-scopes by ctx.organizationId via the policy', async () => {
      mockDelegate.findMany.mockResolvedValue([fullGroup]);
      const result = await BgpPeerGroupRecord.list();
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { organizationId: orgId },
        orderBy: { name: 'asc' },
      });
      expect(result).toHaveLength(1);
    });

    it('applies a case-insensitive name search', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await BgpPeerGroupRecord.list('upstream');
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { organizationId: orgId, name: { contains: 'upstream', mode: 'insensitive' } },
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('findByIdOrThrow', () => {
    it('finds within the scoped org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullGroup);
      const result = await BgpPeerGroupRecord.findByIdOrThrow('pg-1');
      expect(result.data.id).toBe('pg-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'pg-1', organizationId: orgId },
      });
    });

    it('throws NotFoundException when not found in the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(BgpPeerGroupRecord.findByIdOrThrow('pg-1')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a peer group owned by another tenant is invisible to the caller', async () => {
      const foreignGroup = { ...fullGroup, organizationId: 'other-tenant' };
      mockDelegate.findFirst.mockImplementation((args: { where: { organizationId?: string } }) =>
        Promise.resolve(args.where.organizationId === 'other-tenant' ? foreignGroup : null),
      );

      await expect(BgpPeerGroupRecord.findByIdOrThrow('pg-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'pg-1', organizationId: orgId },
      });
    });
  });

  describe('create', () => {
    it('stamps organizationId from ctx', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullGroup);

      await BgpPeerGroupRecord.create({ name: 'upstream-transit' });

      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: { name: 'upstream-transit', organizationId: orgId },
      });
    });

    it('checks name uniqueness within the caller org namespace', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullGroup);

      await BgpPeerGroupRecord.create({ name: 'upstream-transit' });

      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { organizationId: orgId, name: 'upstream-transit' },
      });
    });

    it('rejects duplicate name in the same org', async () => {
      mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(BgpPeerGroupRecord.create({ name: 'upstream-transit' })).rejects.toThrow(ConflictException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe('updateById', () => {
    it('updates within the scoped org', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullGroup).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullGroup, name: 'renamed' });

      const result = await BgpPeerGroupRecord.updateById('pg-1', { name: 'renamed' });
      expect(result.data.name).toBe('renamed');
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'pg-1', organizationId: orgId },
        data: { name: 'renamed' },
      });
    });

    it('uniqueness check on rename uses the existing org', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullGroup).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue(fullGroup);

      await BgpPeerGroupRecord.updateById('pg-1', { name: 'renamed' });

      const uniqCall = mockDelegate.findFirst.mock.calls[1][0];
      expect(uniqCall.where.organizationId).toBe(orgId);
      expect(uniqCall.where.name).toBe('renamed');
      expect(uniqCall.where.id).toEqual({ not: 'pg-1' });
    });

    it('drops any client-supplied organizationId from the update body', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullGroup).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue(fullGroup);

      await BgpPeerGroupRecord.updateById('pg-1', {
        name: 'renamed',
        organizationId: 'victim-org-uuid',
      } as Parameters<typeof BgpPeerGroupRecord.updateById>[1]);

      const updateCall = mockDelegate.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('organizationId');
    });
  });

  describe('deleteById', () => {
    it('deletes within the scoped org when no sessions reference it', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullGroup);
      mockSessionDelegate.count.mockResolvedValue(0);
      await BgpPeerGroupRecord.deleteById('pg-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'pg-1', organizationId: orgId },
      });
    });

    it('throws ConflictException when BGP sessions still reference it', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullGroup);
      mockSessionDelegate.count.mockResolvedValue(3);

      await expect(BgpPeerGroupRecord.deleteById('pg-1')).rejects.toThrow(ConflictException);
      await expect(BgpPeerGroupRecord.deleteById('pg-1')).rejects.toThrow(/in use by 3 sessions/);
      expect(mockDelegate.delete).not.toHaveBeenCalled();
    });
  });
});
