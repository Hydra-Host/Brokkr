import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { Prisma } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefixListRuleRecord } from '../prefix-list-rule.record';

describe('PrefixListRuleRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockPrefixListDelegate = { findUnique: vi.fn() };

  const orgId = 'org-1';

  const fullRule = {
    id: 'plr-1',
    action: 'permit',
    prefix: '10.0.0.0/8',
    ge: 24,
    le: 32,
    sequence: 10,
    prefixListId: 'pl-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest({ prefixListRule: mockDelegate, prefixList: mockPrefixListDelegate }, () => ({
      organizationId: orgId,
      permissions: new Set(['network:read', 'network:create', 'network:update', 'network:delete']),
    }));
  });

  afterEach(() => vi.resetAllMocks());

  describe('list', () => {
    it('auto-scopes via nested where on parent prefixList.organizationId', async () => {
      mockDelegate.findMany.mockResolvedValue([fullRule]);
      await PrefixListRuleRecord.list({});

      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { prefixList: { organizationId: orgId } },
        orderBy: { sequence: 'asc' },
      });
    });

    it('layers prefixListId filter alongside the auto-injected parent scope', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await PrefixListRuleRecord.list({ prefixListId: 'pl-1' });

      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { prefixListId: 'pl-1', prefixList: { organizationId: orgId } },
        orderBy: { sequence: 'asc' },
      });
    });

    it('searches prefix OR action case-insensitively', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await PrefixListRuleRecord.list({ search: '10.0' });
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: {
          prefixList: { organizationId: orgId },
          OR: [
            { prefix: { contains: '10.0', mode: 'insensitive' } },
            { action: { contains: '10.0', mode: 'insensitive' } },
          ],
        },
        orderBy: { sequence: 'asc' },
      });
    });
  });

  describe('findByIdOrThrow', () => {
    it('auto-scopes via parent', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRule);
      const r = await PrefixListRuleRecord.findByIdOrThrow('plr-1');

      expect(r.data.id).toBe('plr-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'plr-1', prefixList: { organizationId: orgId } },
      });
    });

    it('throws NotFoundException for a foreign-tenant rule (invisible via scope)', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PrefixListRuleRecord.findByIdOrThrow('plr-1')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a rule whose parent prefix list is owned by another tenant is invisible to the caller', async () => {
      const foreignRule = { ...fullRule, prefixListId: 'foreign-pl' };
      mockDelegate.findFirst.mockImplementation((args: { where: { prefixList?: { organizationId?: string } } }) =>
        Promise.resolve(args.where.prefixList?.organizationId === 'other-tenant' ? foreignRule : null),
      );

      await expect(PrefixListRuleRecord.findByIdOrThrow('plr-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'plr-1', prefixList: { organizationId: orgId } },
      });
    });
  });

  describe('create', () => {
    it('proceeds when the parent prefix list belongs to the caller org', async () => {
      mockPrefixListDelegate.findUnique.mockResolvedValue({ id: 'pl-1' });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockResolvedValue(fullRule);

      await PrefixListRuleRecord.create({ action: 'permit', sequence: 10, prefixListId: 'pl-1' });

      expect(mockPrefixListDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'pl-1', organizationId: orgId },
        select: { id: true },
      });
      expect(mockDelegate.create).toHaveBeenCalled();
    });

    it('rejects with 404 when parent does not exist OR belongs to another tenant', async () => {
      mockPrefixListDelegate.findUnique.mockResolvedValue(null);

      await expect(
        PrefixListRuleRecord.create({ action: 'permit', sequence: 10, prefixListId: 'foreign-pl' }),
      ).rejects.toThrow(NotFoundException);

      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects a null-org (platform) parent on the tenant write path', async () => {
      mockPrefixListDelegate.findUnique.mockImplementation((args: { where: { organizationId?: unknown } }) =>
        Promise.resolve(args.where.organizationId === null ? { id: 'platform-pl' } : null),
      );

      await expect(
        PrefixListRuleRecord.create({ action: 'permit', sequence: 10, prefixListId: 'platform-pl' }),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrefixListDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'platform-pl', organizationId: orgId },
        select: { id: true },
      });
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('maps concurrent duplicate sequences to ConflictException', async () => {
      mockPrefixListDelegate.findUnique.mockResolvedValue({ id: 'pl-1' });
      mockDelegate.findFirst.mockResolvedValue(null);
      mockDelegate.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }),
      );

      await expect(
        PrefixListRuleRecord.create({ action: 'permit', sequence: 10, prefixListId: 'pl-1' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updateById', () => {
    it('updates within the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullRule).mockResolvedValueOnce(null);
      mockDelegate.update.mockResolvedValue({ ...fullRule, sequence: 20 });

      const r = await PrefixListRuleRecord.updateById('plr-1', { sequence: 20 });

      expect(r.data.sequence).toBe(20);
      expect(mockPrefixListDelegate.findUnique).not.toHaveBeenCalled();
    });

    it('rejects reparenting to a foreign-tenant prefix list', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRule);
      mockPrefixListDelegate.findUnique.mockResolvedValue(null);

      await expect(PrefixListRuleRecord.updateById('plr-1', { prefixListId: 'foreign-pl' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('allows reparenting within the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRule);
      mockPrefixListDelegate.findUnique.mockResolvedValue({ id: 'pl-2' });
      mockDelegate.update.mockResolvedValue({ ...fullRule, prefixListId: 'pl-2' });

      const r = await PrefixListRuleRecord.updateById('plr-1', { prefixListId: 'pl-2' });
      expect(r.data.prefixListId).toBe('pl-2');
    });

    it('throws NotFoundException when the rule is not visible to the caller', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PrefixListRuleRecord.updateById('plr-1', { sequence: 1 })).rejects.toThrow(NotFoundException);
    });

    it('maps concurrent duplicate sequences to ConflictException', async () => {
      mockDelegate.findFirst.mockResolvedValueOnce(fullRule).mockResolvedValueOnce(null);
      mockDelegate.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }),
      );

      await expect(PrefixListRuleRecord.updateById('plr-1', { sequence: 20 })).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteById', () => {
    it('deletes when the rule is in the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRule);
      await PrefixListRuleRecord.deleteById('plr-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({ where: { id: 'plr-1' } });
    });

    it('throws NotFoundException for a foreign-tenant rule', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(PrefixListRuleRecord.deleteById('plr-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.delete).not.toHaveBeenCalled();
    });
  });
});
