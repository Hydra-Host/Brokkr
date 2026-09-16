import { NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DhcpLeasesService } from '../dhcp-leases.service';

const ZONE_ID = 'zone-1';
const ORG_ID = 'org-1';

const LEASE = { ip: '10.0.1.5', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'host', expiresAt: 9_999_999_999 };

function makeService(overrides: { requirePermission?: ReturnType<typeof vi.fn> } = {}) {
  const context = {
    requirePermission: overrides.requirePermission ?? vi.fn(),
    organizationId: ORG_ID,
  };
  const prisma = {
    zone: {
      findUnique: vi.fn().mockResolvedValue({ id: ZONE_ID }),
    },
  };
  const leaseReader = {
    listLeasesForZone: vi.fn().mockResolvedValue([LEASE]),
    revokeLease: vi.fn().mockResolvedValue(LEASE),
  };
  const service = new DhcpLeasesService(prisma as never, context as never, leaseReader as never);
  return { service, prisma, context, leaseReader };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('getZoneDhcpLeases', () => {
  it('calls requirePermission with ipam read', async () => {
    const requirePermission = vi.fn();
    const { service } = makeService({ requirePermission });

    await service.getZoneDhcpLeases(ZONE_ID);

    expect(requirePermission).toHaveBeenCalledWith('ipam', 'read');
  });

  it('rejects when ipam:read permission is denied', async () => {
    const requirePermission = vi.fn().mockImplementation(() => {
      throw new Error('Forbidden');
    });
    const { service, leaseReader } = makeService({ requirePermission });

    await expect(service.getZoneDhcpLeases(ZONE_ID)).rejects.toThrow('Forbidden');
    expect(leaseReader.listLeasesForZone).not.toHaveBeenCalled();
  });

  it('scopes the zone lookup to the caller organization so another tenant zone reads as missing', async () => {
    const { service, prisma } = makeService();

    await service.getZoneDhcpLeases(ZONE_ID);

    expect(prisma.zone.findUnique).toHaveBeenCalledWith({
      where: { id: ZONE_ID, organizationId: ORG_ID, deletedAt: null },
      select: { id: true },
    });
  });

  it('throws NotFoundException when the zone does not exist or belongs to another organization', async () => {
    const { service, prisma, leaseReader } = makeService();
    prisma.zone.findUnique.mockResolvedValue(null);

    await expect(service.getZoneDhcpLeases(ZONE_ID)).rejects.toThrow(NotFoundException);
    expect(leaseReader.listLeasesForZone).not.toHaveBeenCalled();
  });

  it('returns the leases the reader reports for the zone', async () => {
    const { service, leaseReader } = makeService();

    const result = await service.getZoneDhcpLeases(ZONE_ID);

    expect(leaseReader.listLeasesForZone).toHaveBeenCalledWith(ZONE_ID);
    expect(result).toEqual([LEASE]);
  });
});

describe('revokeZoneDhcpLease', () => {
  it('calls requirePermission with ipam update, not read', async () => {
    const requirePermission = vi.fn();
    const { service } = makeService({ requirePermission });

    await service.revokeZoneDhcpLease(ZONE_ID, '10.0.1.5');

    expect(requirePermission).toHaveBeenCalledWith('ipam', 'update');
  });

  it('rejects when ipam:update permission is denied, without revoking', async () => {
    const requirePermission = vi.fn().mockImplementation(() => {
      throw new Error('Forbidden');
    });
    const { service, leaseReader } = makeService({ requirePermission });

    await expect(service.revokeZoneDhcpLease(ZONE_ID, '10.0.1.5')).rejects.toThrow('Forbidden');
    expect(leaseReader.revokeLease).not.toHaveBeenCalled();
  });

  it('does not revoke in a zone the caller organization does not own', async () => {
    const { service, prisma, leaseReader } = makeService();
    prisma.zone.findUnique.mockResolvedValue(null);

    await expect(service.revokeZoneDhcpLease(ZONE_ID, '10.0.1.5')).rejects.toThrow(NotFoundException);
    expect(prisma.zone.findUnique).toHaveBeenCalledWith({
      where: { id: ZONE_ID, organizationId: ORG_ID, deletedAt: null },
      select: { id: true },
    });
    expect(leaseReader.revokeLease).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when no lease is held on the address', async () => {
    const { service, leaseReader } = makeService();
    leaseReader.revokeLease.mockResolvedValue(null);

    await expect(service.revokeZoneDhcpLease(ZONE_ID, '10.0.1.5')).rejects.toThrow(NotFoundException);
  });

  it('returns the lease that was removed', async () => {
    const { service, leaseReader } = makeService();

    const result = await service.revokeZoneDhcpLease(ZONE_ID, '10.0.1.5');

    expect(leaseReader.revokeLease).toHaveBeenCalledWith(ZONE_ID, '10.0.1.5');
    expect(result).toEqual(LEASE);
  });
});
