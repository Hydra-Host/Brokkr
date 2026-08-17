import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsnRecord } from '../asn.record';

describe('AsnRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const mockSessionDelegate = { count: vi.fn().mockResolvedValue(0) };

  const orgId = 'org-1';

  const fullAsn = {
    id: 'asn-1',
    asn: 65001,
    description: null,
    organizationId: orgId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockSessionDelegate.count.mockResolvedValue(0);
    ActiveRecordRegistry.configureForTest({ asn: mockDelegate, bgpSession: mockSessionDelegate }, () => ({
      organizationId: orgId,
      permissions: new Set(['network:read', 'network:create', 'network:update', 'network:delete']),
    }));
  });

  afterEach(() => vi.resetAllMocks());

  describe('list', () => {
    it('auto-scopes by ctx.organizationId', async () => {
      mockDelegate.findMany.mockResolvedValue([fullAsn]);
      await AsnRecord.list();
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { organizationId: orgId },
        orderBy: { asn: 'asc' },
      });
    });
  });

  describe('findByIdOrThrow', () => {
    it('scopes by ctx org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullAsn);
      const r = await AsnRecord.findByIdOrThrow('asn-1');
      expect(r.data.id).toBe('asn-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'asn-1', organizationId: orgId },
      });
    });

    it('throws NotFoundException when not in the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(AsnRecord.findByIdOrThrow('asn-1')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: an ASN owned by another tenant is invisible to the caller', async () => {
      const foreignAsn = { ...fullAsn, organizationId: 'other-tenant' };
      mockDelegate.findFirst.mockImplementation((args: { where: { organizationId?: string } }) =>
        Promise.resolve(args.where.organizationId === 'other-tenant' ? foreignAsn : null),
      );

      await expect(AsnRecord.findByIdOrThrow('asn-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'asn-1', organizationId: orgId },
      });
    });
  });

  describe('create', () => {
    it('stamps organizationId from ctx', async () => {
      mockDelegate.create.mockResolvedValue(fullAsn);

      await AsnRecord.create({ asn: 65001, description: 'Primary' });

      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: { asn: 65001, description: 'Primary', organizationId: orgId },
      });
    });
  });

  describe('updateById', () => {
    it('updates within the scoped org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullAsn);
      mockDelegate.update.mockResolvedValue({ ...fullAsn, asn: 65002 });

      const r = await AsnRecord.updateById('asn-1', { asn: 65002 });

      expect(r.data.asn).toBe(65002);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'asn-1', organizationId: orgId },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'asn-1', organizationId: orgId },
        data: { asn: 65002 },
      });
    });
  });

  describe('deleteById', () => {
    it('deletes within the scoped org when no sessions reference it', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullAsn);
      mockSessionDelegate.count.mockResolvedValue(0);
      await AsnRecord.deleteById('asn-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'asn-1', organizationId: orgId },
      });
    });

    it('throws ConflictException when BGP sessions reference the ASN on either side', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullAsn);
      mockSessionDelegate.count.mockResolvedValue(2);

      await expect(AsnRecord.deleteById('asn-1')).rejects.toThrow(ConflictException);
      await expect(AsnRecord.deleteById('asn-1')).rejects.toThrow(/in use by 2 BGP sessions/);
      expect(mockSessionDelegate.count).toHaveBeenCalledWith({
        where: { OR: [{ localAsnId: 'asn-1' }, { remoteAsnId: 'asn-1' }] },
      });
      expect(mockDelegate.delete).not.toHaveBeenCalled();
    });
  });
});
