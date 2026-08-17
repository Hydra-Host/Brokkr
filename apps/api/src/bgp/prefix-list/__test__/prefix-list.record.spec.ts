import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefixListRecord } from '../prefix-list.record';

describe('PrefixListRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const orgId = 'org-1';

  const fullList = {
    id: 'pl-1',
    name: 'customer-prefixes',
    description: null,
    family: 'ipv4',
    organizationId: orgId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSessionDelegate = { count: vi.fn().mockResolvedValue(0) };

  beforeEach(() => {
    vi.resetAllMocks();
    mockSessionDelegate.count.mockResolvedValue(0);
    ActiveRecordRegistry.configureForTest({ prefixList: mockDelegate, bgpSession: mockSessionDelegate }, () => ({
      organizationId: orgId,
      permissions: new Set(['network:read', 'network:create', 'network:update', 'network:delete']),
    }));
  });

  afterEach(() => vi.resetAllMocks());

  describe('list', () => {
    it('auto-scopes by ctx.organizationId', async () => {
      mockDelegate.findMany.mockResolvedValue([fullList]);
      await PrefixListRecord.list();
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { organizationId: orgId },
        orderBy: { name: 'asc' },
      });
    });

    it('applies family (equals) and search (contains) filters case-insensitively', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await PrefixListRecord.list({ family: 'ipv6', search: 'transit' });
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: orgId,
          family: { equals: 'ipv6', mode: 'insensitive' },
          name: { contains: 'transit', mode: 'insensitive' },
        },
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('findByIdOrThrow', () => {
    it('scopes by ctx org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullList);
      const r = await PrefixListRecord.findByIdOrThrow('pl-1');
      expect(r.data.id).toBe('pl-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'pl-1', organizationId: orgId },
      });
    });

    it('throws NotFoundException when not found in the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PrefixListRecord.findByIdOrThrow('pl-1')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a prefix list owned by another tenant is invisible to the caller', async () => {
      const foreignList = { ...fullList, organizationId: 'other-tenant' };
      mockDelegate.findFirst.mockImplementation((args: { where: { organizationId?: string } }) =>
        Promise.resolve(args.where.organizationId === 'other-tenant' ? foreignList : null),
      );

      await expect(PrefixListRecord.findByIdOrThrow('pl-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'pl-1', organizationId: orgId },
      });
    });
  });

  describe('create', () => {
    it('stamps organizationId from ctx', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullList);

      await PrefixListRecord.create({ name: 'x', family: 'ipv4' });

      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: { name: 'x', family: 'ipv4', organizationId: orgId },
      });
    });

    it('rejects duplicate name in the same org', async () => {
      mockDelegate.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(PrefixListRecord.create({ name: 'x' })).rejects.toThrow(ConflictException);
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe('updateById', () => {
    it('updates within the scoped org', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullList).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullList, name: 'renamed' });

      const r = await PrefixListRecord.updateById('pl-1', { name: 'renamed' });
      expect(r.data.name).toBe('renamed');
      expect(mockDelegate.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'pl-1', organizationId: orgId },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'pl-1', organizationId: orgId },
        data: { name: 'renamed' },
      });
    });

    it('drops any client-supplied organizationId from the update body', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullList).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue(fullList);

      await PrefixListRecord.updateById('pl-1', {
        name: 'renamed',
        organizationId: 'victim-org-uuid',
      } as Parameters<typeof PrefixListRecord.updateById>[1]);

      const updateCall = mockDelegate.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('organizationId');
    });
  });

  describe('deleteById', () => {
    it('deletes within the scoped org when no sessions reference it', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullList);
      mockSessionDelegate.count.mockResolvedValue(0);
      await PrefixListRecord.deleteById('pl-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'pl-1', organizationId: orgId },
      });
    });

    it('throws ConflictException when BGP sessions reference the list on either side', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullList);
      mockSessionDelegate.count.mockResolvedValue(2);

      await expect(PrefixListRecord.deleteById('pl-1')).rejects.toThrow(ConflictException);
      await expect(PrefixListRecord.deleteById('pl-1')).rejects.toThrow(/in use by 2 BGP sessions/);
      expect(mockSessionDelegate.count).toHaveBeenCalledWith({
        where: { OR: [{ prefixListInId: 'pl-1' }, { prefixListOutId: 'pl-1' }] },
      });
      expect(mockDelegate.delete).not.toHaveBeenCalled();
    });
  });
});
