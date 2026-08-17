import { NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { BgpSessionStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BgpSessionRecord } from '../bgp-session.record';

describe('BgpSessionRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const orgId = 'org-1';

  const fullSession = {
    id: 's-1',
    name: 'upstream-cogent',
    status: BgpSessionStatus.ACTIVE,
    description: null,
    deviceId: null,
    localAsnId: null,
    remoteAsnId: null,
    localAddressId: null,
    remoteAddressId: null,
    peerGroupId: null,
    prefixListInId: null,
    prefixListOutId: null,
    organizationId: orgId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockBgpPeerGroupDelegate = { findUnique: vi.fn() };
  const mockPrefixListDelegate = { findUnique: vi.fn() };
  const mockAsnDelegate = { findUnique: vi.fn() };
  const mockIpAddressDelegate = { findUnique: vi.fn() };
  const mockDeviceDelegate = { findUnique: vi.fn() };

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest(
      {
        bgpSession: mockDelegate,
        bgpPeerGroup: mockBgpPeerGroupDelegate,
        prefixList: mockPrefixListDelegate,
        asn: mockAsnDelegate,
        ipAddress: mockIpAddressDelegate,
        device: mockDeviceDelegate,
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
      mockDelegate.findMany.mockResolvedValue([fullSession]);
      await BgpSessionRecord.list({});
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { organizationId: orgId },
        orderBy: { name: 'asc' },
      });
    });

    it('layers filter args on top of the tenant scope', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await BgpSessionRecord.list({ deviceId: 'd-1', peerGroupId: 'pg-1', status: BgpSessionStatus.OFFLINE });
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: orgId,
          deviceId: 'd-1',
          peerGroupId: 'pg-1',
          status: BgpSessionStatus.OFFLINE,
        },
        orderBy: { name: 'asc' },
      });
    });

    it('applies a case-insensitive name search', async () => {
      mockDelegate.findMany.mockResolvedValue([]);
      await BgpSessionRecord.list({ search: 'core' });
      expect(mockDelegate.findMany).toHaveBeenCalledWith({
        where: { organizationId: orgId, name: { contains: 'core', mode: 'insensitive' } },
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('findByIdOrThrow', () => {
    it('scopes by ctx org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullSession);
      const r = await BgpSessionRecord.findByIdOrThrow('s-1');
      expect(r.data.id).toBe('s-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 's-1', organizationId: orgId },
      });
    });

    it('throws NotFoundException when not found in the caller org', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await expect(BgpSessionRecord.findByIdOrThrow('s-1')).rejects.toThrow(NotFoundException);
    });

    it('cross-tenant isolation: a session owned by another tenant is invisible to the caller', async () => {
      const foreignSession = { ...fullSession, organizationId: 'other-tenant' };
      mockDelegate.findFirst.mockImplementation((args: { where: { organizationId?: string } }) =>
        Promise.resolve(args.where.organizationId === 'other-tenant' ? foreignSession : null),
      );

      await expect(BgpSessionRecord.findByIdOrThrow('s-1')).rejects.toThrow(NotFoundException);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 's-1', organizationId: orgId },
      });
    });
  });

  describe('create', () => {
    it('stamps organizationId from ctx and defaults status to ACTIVE', async () => {
      mockDelegate.create.mockResolvedValue(fullSession);

      await BgpSessionRecord.create({ name: 'upstream-cogent' });

      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'upstream-cogent',
          status: BgpSessionStatus.ACTIVE,
          organizationId: orgId,
        }),
      });
    });

    it('passes all FK refs through when every target is reachable', async () => {
      mockBgpPeerGroupDelegate.findUnique.mockResolvedValue({ id: 'pg-1' });
      mockPrefixListDelegate.findUnique.mockResolvedValue({ id: 'pl-any' });
      mockAsnDelegate.findUnique.mockResolvedValue({ id: 'a-any' });
      mockIpAddressDelegate.findUnique.mockResolvedValue({ id: 'ip-any' });
      mockDeviceDelegate.findUnique.mockResolvedValue({ id: 'd-1' });
      mockDelegate.create.mockResolvedValue(fullSession);

      await BgpSessionRecord.create({
        name: 'x',
        deviceId: 'd-1',
        localAsnId: 'a-1',
        remoteAsnId: 'a-2',
        localAddressId: 'ip-1',
        remoteAddressId: 'ip-2',
        peerGroupId: 'pg-1',
        prefixListInId: 'pl-in',
        prefixListOutId: 'pl-out',
      });

      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deviceId: 'd-1',
          localAsnId: 'a-1',
          remoteAsnId: 'a-2',
          localAddressId: 'ip-1',
          remoteAddressId: 'ip-2',
          peerGroupId: 'pg-1',
          prefixListInId: 'pl-in',
          prefixListOutId: 'pl-out',
        }),
      });
      expect(mockDeviceDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'd-1', supplierId: orgId, deletedAt: null },
        select: { id: true },
      });
    });

    it('rejects a deviceId the caller does not supply', async () => {
      mockDeviceDelegate.findUnique.mockResolvedValue(null);
      await expect(BgpSessionRecord.create({ name: 'x', deviceId: 'foreign-device' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant peerGroupId (strict same-org reachability)', async () => {
      mockBgpPeerGroupDelegate.findUnique.mockResolvedValue(null);
      await expect(BgpSessionRecord.create({ name: 'x', peerGroupId: 'other-tenant-pg' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockBgpPeerGroupDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'other-tenant-pg', organizationId: orgId },
        select: { id: true },
      });
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant prefixListInId / prefixListOutId / ASN ids', async () => {
      mockPrefixListDelegate.findUnique.mockResolvedValue(null);
      await expect(BgpSessionRecord.create({ name: 'x', prefixListInId: 'other-tenant-pl' })).rejects.toThrow(
        NotFoundException,
      );

      mockPrefixListDelegate.findUnique.mockResolvedValue(null);
      await expect(BgpSessionRecord.create({ name: 'x', prefixListOutId: 'other-tenant-pl' })).rejects.toThrow(
        NotFoundException,
      );

      mockAsnDelegate.findUnique.mockResolvedValue(null);
      await expect(BgpSessionRecord.create({ name: 'x', localAsnId: 'other-tenant-asn' })).rejects.toThrow(
        NotFoundException,
      );

      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant IP address ids (strict same-org)', async () => {
      mockIpAddressDelegate.findUnique.mockResolvedValue(null);
      await expect(BgpSessionRecord.create({ name: 'x', localAddressId: 'other-tenant-ip' })).rejects.toThrow(
        NotFoundException,
      );

      expect(mockIpAddressDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'other-tenant-ip', organizationId: orgId },
        select: { id: true },
      });
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('rejects a null-org (platform) parent on the tenant write path', async () => {
      mockBgpPeerGroupDelegate.findUnique.mockImplementation((args: { where: { organizationId?: unknown } }) =>
        Promise.resolve(args.where.organizationId === null ? { id: 'platform-pg' } : null),
      );

      await expect(BgpSessionRecord.create({ name: 'x', peerGroupId: 'platform-pg' })).rejects.toThrow(
        NotFoundException,
      );

      expect(mockBgpPeerGroupDelegate.findUnique).toHaveBeenCalledWith({
        where: { id: 'platform-pg', organizationId: orgId },
        select: { id: true },
      });
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe('updateById', () => {
    it('updates within the scoped org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullSession);
      mockDelegate.update.mockResolvedValue({ ...fullSession, status: BgpSessionStatus.OFFLINE });

      const r = await BgpSessionRecord.updateById('s-1', { status: BgpSessionStatus.OFFLINE });
      expect(r.data.status).toBe(BgpSessionStatus.OFFLINE);
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 's-1', organizationId: orgId },
      });
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 's-1', organizationId: orgId },
        data: { status: BgpSessionStatus.OFFLINE },
      });
    });

    it('rejects cross-tenant FK reassignment via update body', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullSession);
      mockBgpPeerGroupDelegate.findUnique.mockResolvedValue(null);

      await expect(BgpSessionRecord.updateById('s-1', { peerGroupId: 'other-tenant-pg' })).rejects.toThrow(
        NotFoundException,
      );

      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('drops any client-supplied organizationId from the update body', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullSession);
      mockDelegate.update.mockResolvedValue(fullSession);

      await BgpSessionRecord.updateById('s-1', {
        status: BgpSessionStatus.OFFLINE,
        organizationId: 'victim-org-uuid',
      } as Parameters<typeof BgpSessionRecord.updateById>[1]);

      const updateCall = mockDelegate.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('organizationId');
    });
  });

  describe('deleteById', () => {
    it('deletes within the scoped org', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullSession);
      await BgpSessionRecord.deleteById('s-1');
      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: 's-1', organizationId: orgId },
      });
    });
  });
});
