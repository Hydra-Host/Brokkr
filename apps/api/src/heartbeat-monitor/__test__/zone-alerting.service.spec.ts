import type { PluginEventBus } from '@hydrahost/plugin-sdk';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoggerService } from '../../logger/logger.service';
import type { PrismaClient } from '../../prisma/prisma.client';
import { ZoneAlertingService } from '../zone-alerting.service';

interface ZoneStatusFixture {
  // sendZoneOfflineAlert no longer reads isOnline; optional so fixtures can omit it.
  isOnline?: boolean;
  alertSentAt?: Date | null;
  lastOfflineAt?: Date | null;
}

describe('ZoneAlertingService.sendZoneOfflineAlert', () => {
  function buildService(overrides?: { hhEnv?: string; existingZoneStatus?: ZoneStatusFixture | null }): {
    service: ZoneAlertingService;
    emit: ReturnType<typeof vi.fn>;
    prisma: Record<string, unknown>;
  } {
    const zoneStatus = overrides?.existingZoneStatus === undefined ? null : overrides.existingZoneStatus;

    const prisma = {
      zone: {
        findUnique: vi.fn().mockResolvedValue({ name: 'us-east-1' }),
      },
      zoneStatus: {
        findUnique: vi.fn().mockResolvedValue(zoneStatus),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      device: { count: vi.fn().mockResolvedValue(5) },
      deployment: { count: vi.fn().mockResolvedValue(2) },
    };

    const emit = vi.fn();
    const eventBus: PluginEventBus = {
      emit,
      on: vi.fn().mockReturnValue(() => {}),
      off: vi.fn(),
    };

    const configService = {
      get: vi.fn((key: string) => {
        if (key === 'HH_ENV') return overrides?.hhEnv ?? 'prod';
        if (key === 'BASE_URL') return 'https://example.com';
        return undefined;
      }),
      getOrThrow: vi.fn((key: string) => {
        if (key === 'HH_ENV') return overrides?.hhEnv ?? 'prod';
        if (key === 'BASE_URL') return 'https://example.com';
        throw new Error(`unexpected config key: ${key}`);
      }),
    } as unknown as ConfigService;

    const logger = {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as LoggerService;

    const service = new ZoneAlertingService(prisma as unknown as PrismaClient, eventBus, configService, logger);

    return { service, emit, prisma };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits zone.alert with the gathered alert data when zone is offline in prod', async () => {
    const { service, emit, prisma } = buildService();
    const lastHeartbeat = new Date('2026-05-26T12:00:00Z');

    await service.sendZoneOfflineAlert('zone-uuid-1', lastHeartbeat);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'zone.alert',
      expect.objectContaining({
        zoneId: 'zone-uuid-1',
        zoneName: 'us-east-1',
        lastHeartbeatAt: lastHeartbeat,
        deviceCount: 5,
        activeRentalsCount: 2,
      }),
    );

    expect(prisma.zoneStatus).toBeDefined();
    expect((prisma.zoneStatus as { upsert: ReturnType<typeof vi.fn> }).upsert).toHaveBeenCalled();
    expect((prisma.zoneStatus as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalled();
  });

  it('does not emit zone.alert in non-prod environments', async () => {
    const { service, emit } = buildService({ hhEnv: 'staging' });

    await service.sendZoneOfflineAlert('zone-uuid-1', new Date());

    expect(emit).not.toHaveBeenCalled();
  });

  // Regression: the sweep flips isOnline=false before the cron calls this
  // path, so an offline flag alone must not suppress the first alert.
  it('emits exactly once when the sweep already marked the zone offline this episode', async () => {
    const { service, emit } = buildService({
      existingZoneStatus: { isOnline: false, alertSentAt: null, lastOfflineAt: new Date() },
    });

    await service.sendZoneOfflineAlert('zone-uuid-1', new Date());

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('zone.alert', expect.objectContaining({ zoneId: 'zone-uuid-1' }));
  });

  it('does not re-emit while the zone stays offline after the episode alert was sent', async () => {
    const { service, emit } = buildService({
      existingZoneStatus: {
        isOnline: false,
        lastOfflineAt: new Date('2026-05-26T12:00:00Z'),
        alertSentAt: new Date('2026-05-26T12:00:05Z'),
      },
    });

    await service.sendZoneOfflineAlert('zone-uuid-1', new Date());

    expect(emit).not.toHaveBeenCalled();
  });

  it('re-emits when the zone goes offline again after recovering from an alerted episode', async () => {
    const { service, emit } = buildService({
      existingZoneStatus: {
        isOnline: false,
        alertSentAt: new Date('2026-05-26T10:00:00Z'),
        lastOfflineAt: new Date('2026-05-26T12:00:00Z'),
      },
    });

    await service.sendZoneOfflineAlert('zone-uuid-1', new Date());

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('writes alertSentAt to ZoneStatus regardless of plugin subscriber outcomes', async () => {
    const { service, prisma } = buildService();

    await service.sendZoneOfflineAlert('zone-uuid-1', new Date('2026-05-26T12:00:00Z'));

    const updateCalls = (prisma.zoneStatus as { update: ReturnType<typeof vi.fn> }).update.mock.calls;
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][0]).toMatchObject({
      data: expect.objectContaining({ alertSentAt: expect.any(Date) }),
    });
    expect(updateCalls[0][0].data).not.toHaveProperty('ticketId');
  });
});
