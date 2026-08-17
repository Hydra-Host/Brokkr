import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceTuningService } from '../service-tuning.service';

const ZONE_ID = 'zone-1';
const ORG_ID = 'org-1';

const TUNING_ROW = {
  dhcpLeaderPollMs: 2000,
  dhcpPruneIntervalMs: 60000,
  dhcpDeclineBackoffSeconds: 600,
  vrrpGarpCount: 5,
};

const TUNING_BODY = {
  dhcpLeaderPollMs: 3000,
  dhcpPruneIntervalMs: 30000,
  dhcpDeclineBackoffSeconds: 120,
  vrrpGarpCount: 7,
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
      findUnique: vi.fn().mockResolvedValue(TUNING_ROW),
      update: vi.fn().mockResolvedValue(TUNING_ROW),
    },
  };
  const dhcpPublisher = {
    publishZoneOps: vi.fn().mockResolvedValue(true),
  };
  const service = new ServiceTuningService(prisma as never, context as never, dhcpPublisher as never, logger as never);
  return { service, prisma, context, dhcpPublisher, logger };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('getZoneServiceTuning', () => {
  it('calls requirePermission with zone read', async () => {
    const requirePermission = vi.fn();
    const { service } = makeService({ requirePermission });

    await service.getZoneServiceTuning(ZONE_ID);

    expect(requirePermission).toHaveBeenCalledWith('zone', 'read');
  });

  it('rejects when zone:read permission is denied', async () => {
    const requirePermission = vi.fn().mockImplementation(() => {
      throw new Error('Forbidden');
    });
    const { service } = makeService({ requirePermission });

    await expect(service.getZoneServiceTuning(ZONE_ID)).rejects.toThrow('Forbidden');
  });

  it('scopes the lookup to the caller organization and returns the mapped tuning', async () => {
    const { service, prisma } = makeService();

    const result = await service.getZoneServiceTuning(ZONE_ID);

    expect(prisma.zone.findUnique).toHaveBeenCalledWith({
      where: { id: ZONE_ID, organizationId: ORG_ID, deletedAt: null },
      select: {
        dhcpLeaderPollMs: true,
        dhcpPruneIntervalMs: true,
        dhcpDeclineBackoffSeconds: true,
        vrrpGarpCount: true,
      },
    });
    expect(result).toEqual({
      dhcpLeaderPollMs: 2000,
      dhcpPruneIntervalMs: 60000,
      dhcpDeclineBackoffSeconds: 600,
      vrrpGarpCount: 5,
    });
  });

  it('throws NotFoundException when zone does not exist', async () => {
    const { service, prisma } = makeService();
    prisma.zone.findUnique.mockResolvedValue(null);

    await expect(service.getZoneServiceTuning('missing')).rejects.toThrow(NotFoundException);
  });
});

describe('updateZoneServiceTuning', () => {
  it('calls requirePermission, updates the org-scoped zone, and publishes the zone ops atom', async () => {
    const requirePermission = vi.fn();
    const { service, prisma, context, dhcpPublisher } = makeService({ requirePermission });
    prisma.zone.update.mockResolvedValue(TUNING_BODY);

    const result = await service.updateZoneServiceTuning(ZONE_ID, TUNING_BODY);

    expect(requirePermission).toHaveBeenCalledWith('zone', 'update');
    expect(prisma.zone.update).toHaveBeenCalledWith({
      where: { id: ZONE_ID, organizationId: ORG_ID, deletedAt: null },
      data: {
        dhcpLeaderPollMs: 3000,
        dhcpPruneIntervalMs: 30000,
        dhcpDeclineBackoffSeconds: 120,
        vrrpGarpCount: 7,
      },
      select: {
        dhcpLeaderPollMs: true,
        dhcpPruneIntervalMs: true,
        dhcpDeclineBackoffSeconds: true,
        vrrpGarpCount: true,
      },
    });
    expect(context.buildAuditPayload).toHaveBeenCalled();
    expect(dhcpPublisher.publishZoneOps).toHaveBeenCalledWith(ZONE_ID);
    expect(result).toEqual(TUNING_BODY);
  });

  it('throws NotFoundException when zone does not exist', async () => {
    const { service, prisma, dhcpPublisher } = makeService();
    prisma.zone.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: 't' }),
    );

    await expect(service.updateZoneServiceTuning('missing', TUNING_BODY)).rejects.toThrow(NotFoundException);
    expect(dhcpPublisher.publishZoneOps).not.toHaveBeenCalled();
  });

  it('rethrows non-P2025 prisma errors', async () => {
    const { service, prisma } = makeService();
    prisma.zone.update.mockRejectedValue(new Error('connection lost'));

    await expect(service.updateZoneServiceTuning(ZONE_ID, TUNING_BODY)).rejects.toThrow('connection lost');
  });
});
