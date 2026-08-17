import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DnsConfigService } from '../dns-config.service';

const ZONE_ID = 'zone-1';
const ORG_ID = 'org-1';

const ZONE_DNS_ROW = {
  dnsEnabled: true,
  dnsUpstreamResolvers: ['8.8.8.8'],
  dnsTtlSeconds: 60,
  dnsCacheSize: 1000,
  dnsOwnedDomain: 'lan',
  dnsUpstreamTimeoutMs: 1000,
  dnsPollMs: 2000,
  dnsTcpMaxConnections: 20,
  dnsTcpMaxQueriesPerConn: 100,
  dnsTcpIdleTimeoutMs: 5000,
  dnsTcpMaxMessageBytes: 4096,
  dnsMaxTtlSeconds: 0,
  dnsMaxCacheTtlSeconds: 0,
  dnsMinCacheTtlSeconds: 0,
  dnsNegTtlSeconds: 0,
};

function makeService(overrides: { requirePermission?: ReturnType<typeof vi.fn> } = {}) {
  const context = {
    buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'u', triggeredByEmail: 'a@b' }),
    requirePermission: overrides.requirePermission ?? vi.fn(),
    organizationId: ORG_ID,
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const prisma = {
    zone: {
      findUnique: vi.fn().mockResolvedValue(ZONE_DNS_ROW),
      update: vi.fn().mockResolvedValue(ZONE_DNS_ROW),
    },
  };
  const dnsPublisher = {
    publishZoneDnsConfig: vi.fn().mockResolvedValue(true),
  };
  const service = new DnsConfigService(prisma as never, context as never, dnsPublisher as never, logger as never);
  return { service, prisma, context, dnsPublisher, logger };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('getZoneDnsConfig', () => {
  it('calls requirePermission with zone read', async () => {
    const requirePermission = vi.fn();
    const { service } = makeService({ requirePermission });

    await service.getZoneDnsConfig(ZONE_ID);

    expect(requirePermission).toHaveBeenCalledWith('zone', 'read');
  });

  it('rejects when zone:read permission is denied', async () => {
    const requirePermission = vi.fn().mockImplementation(() => {
      throw new Error('Forbidden');
    });
    const { service } = makeService({ requirePermission });

    await expect(service.getZoneDnsConfig(ZONE_ID)).rejects.toThrow('Forbidden');
  });

  it('returns mapped dns config when zone exists', async () => {
    const { service, prisma } = makeService();

    const result = await service.getZoneDnsConfig(ZONE_ID);

    expect(prisma.zone.findUnique).toHaveBeenCalledWith({
      where: { id: ZONE_ID, organizationId: ORG_ID, deletedAt: null },
      select: expect.objectContaining({ dnsEnabled: true, dnsOwnedDomain: true }),
    });
    expect(result).toEqual({
      enabled: true,
      upstreamResolvers: ['8.8.8.8'],
      ttlSeconds: 60,
      cacheSize: 1000,
      ownedDomain: 'lan',
      upstreamTimeoutMs: 1000,
      pollMs: 2000,
      tcpMaxConnections: 20,
      tcpMaxQueriesPerConn: 100,
      tcpIdleTimeoutMs: 5000,
      tcpMaxMessageBytes: 4096,
      maxTtlSeconds: 0,
      maxCacheTtlSeconds: 0,
      minCacheTtlSeconds: 0,
      negTtlSeconds: 0,
    });
  });

  it('throws NotFoundException when zone does not exist', async () => {
    const { service, prisma } = makeService();
    prisma.zone.findUnique.mockResolvedValue(null);

    await expect(service.getZoneDnsConfig('missing')).rejects.toThrow(NotFoundException);
  });

  it('passes through nullable fields from prisma', async () => {
    const { service, prisma } = makeService();
    prisma.zone.findUnique.mockResolvedValue({
      ...ZONE_DNS_ROW,
      dnsTcpMaxConnections: null,
      dnsTcpMaxQueriesPerConn: null,
      dnsTcpIdleTimeoutMs: null,
      dnsTcpMaxMessageBytes: null,
      dnsMaxTtlSeconds: null,
      dnsMaxCacheTtlSeconds: null,
      dnsMinCacheTtlSeconds: null,
      dnsNegTtlSeconds: null,
    });

    const result = await service.getZoneDnsConfig(ZONE_ID);

    expect(result.tcpMaxConnections).toBeNull();
    expect(result.tcpMaxQueriesPerConn).toBeNull();
    expect(result.tcpIdleTimeoutMs).toBeNull();
    expect(result.tcpMaxMessageBytes).toBeNull();
    expect(result.maxTtlSeconds).toBeNull();
    expect(result.maxCacheTtlSeconds).toBeNull();
    expect(result.minCacheTtlSeconds).toBeNull();
    expect(result.negTtlSeconds).toBeNull();
  });
});

describe('updateZoneDnsConfig', () => {
  it('calls requirePermission and updates zone', async () => {
    const requirePermission = vi.fn();
    const { service, prisma, context, dnsPublisher } = makeService({ requirePermission });

    const body = {
      enabled: true,
      upstreamResolvers: ['8.8.8.8'],
      ttlSeconds: 60,
      cacheSize: 1000,
      ownedDomain: 'lan',
      upstreamTimeoutMs: 1000,
      pollMs: 2000,
      tcpMaxConnections: 20,
      tcpMaxQueriesPerConn: 100,
      tcpIdleTimeoutMs: 5000,
      tcpMaxMessageBytes: 4096,
      maxTtlSeconds: 0,
      maxCacheTtlSeconds: 0,
      minCacheTtlSeconds: 0,
      negTtlSeconds: 0,
    };

    await service.updateZoneDnsConfig(ZONE_ID, body);

    expect(requirePermission).toHaveBeenCalledWith('zone', 'update');
    expect(prisma.zone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ZONE_ID, organizationId: ORG_ID, deletedAt: null },
        data: expect.objectContaining({ dnsEnabled: true, dnsOwnedDomain: 'lan' }),
      }),
    );
    expect(context.buildAuditPayload).toHaveBeenCalled();
    expect(dnsPublisher.publishZoneDnsConfig).toHaveBeenCalledWith(ZONE_ID);
  });

  it('throws NotFoundException when zone does not exist', async () => {
    const { service, prisma } = makeService();
    prisma.zone.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: 't' }),
    );

    await expect(
      service.updateZoneDnsConfig('missing', {
        enabled: false,
        upstreamResolvers: [],
        ttlSeconds: 60,
        cacheSize: 1000,
        ownedDomain: 'lan',
        upstreamTimeoutMs: 1000,
        pollMs: 2000,
        tcpMaxConnections: 20,
        tcpMaxQueriesPerConn: 100,
        tcpIdleTimeoutMs: 5000,
        tcpMaxMessageBytes: 4096,
        maxTtlSeconds: 0,
        maxCacheTtlSeconds: 0,
        minCacheTtlSeconds: 0,
        negTtlSeconds: 0,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('passes tcpIdleTimeoutMs through to prisma', async () => {
    const { service, prisma } = makeService();

    await service.updateZoneDnsConfig(ZONE_ID, {
      enabled: true,
      upstreamResolvers: ['8.8.8.8'],
      ttlSeconds: 60,
      cacheSize: 1000,
      ownedDomain: 'lan',
      upstreamTimeoutMs: 1000,
      pollMs: 2000,
      tcpMaxConnections: 20,
      tcpMaxQueriesPerConn: 100,
      tcpIdleTimeoutMs: 7000,
      tcpMaxMessageBytes: 4096,
      maxTtlSeconds: 0,
      maxCacheTtlSeconds: 0,
      minCacheTtlSeconds: 0,
      negTtlSeconds: 0,
    });

    const updateCall = prisma.zone.update.mock.calls[0]?.[0];
    expect(updateCall?.data?.dnsTcpIdleTimeoutMs).toBe(7000);
  });
});
