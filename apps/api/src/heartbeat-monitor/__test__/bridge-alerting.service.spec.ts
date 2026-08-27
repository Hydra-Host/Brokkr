import type { PluginEventBus } from '@hydrahost/plugin-sdk';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoggerService } from '../../logger/logger.service';
import type { PrismaClient } from '../../prisma/prisma.client';
import { BridgeAlertingService } from '../bridge-alerting.service';
import { BRIDGE_OFFLINE_ALERT_AFTER_MS } from '../heartbeat-monitor.constants';

const MINUTE = 60 * 1000;

interface BridgeRowOverrides {
  isOnline?: boolean;
  lastSeenAt?: Date | null;
  lastOfflineAt?: Date | null;
  offlineAlertSentAt?: Date | null;
  bridgeVersion?: string | null;
}

function deviceRow(bridge: BridgeRowOverrides = {}, overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-1',
    name: 'spoke-1',
    zoneId: 'zone-a',
    zone: { name: 'us-east-1' },
    bridge: {
      isOnline: true,
      lastSeenAt: new Date(Date.now() - MINUTE),
      lastOfflineAt: null,
      offlineAlertSentAt: null,
      bridgeVersion: '1.2.3',
      ...bridge,
    },
    ...overrides,
  };
}

function buildService(devices: unknown[], overrides?: { hhEnv?: string }) {
  const deviceFindMany = vi.fn().mockResolvedValue(devices);
  const bridgeUpdate = vi.fn().mockResolvedValue({});
  const prisma = {
    device: { findMany: deviceFindMany },
    bridge: { update: bridgeUpdate },
  };

  const emit = vi.fn();
  const eventBus: PluginEventBus = { emit, on: vi.fn().mockReturnValue(() => {}), off: vi.fn() };

  const configService = {
    get: vi.fn((key: string) => (key === 'HH_ENV' ? (overrides?.hhEnv ?? 'prod') : undefined)),
  } as unknown as ConfigService;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as LoggerService;

  const service = new BridgeAlertingService(prisma as unknown as PrismaClient, eventBus, configService, logger);
  return { service, emit, deviceFindMany, bridgeUpdate, logger };
}

const present = (zoneId: string, instanceIds: string[]) => new Map([[zoneId, new Set(instanceIds)]]);

describe('BridgeAlertingService.reconcileBridgePresence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bumps lastSeenAt and keeps isOnline for a present bridge (sweep-fresh lastSeenAt)', async () => {
    const { service, bridgeUpdate, emit } = buildService([deviceRow()]);

    await service.reconcileBridgePresence(present('zone-a', ['spoke-1']));

    expect(bridgeUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { deviceId: 'device-1' },
      data: { isOnline: true, lastSeenAt: expect.any(Date) },
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('marks a newly absent bridge offline without alerting yet', async () => {
    const { service, bridgeUpdate, emit, logger } = buildService([deviceRow()]);

    await service.reconcileBridgePresence(present('zone-a', ['other-spoke']));

    expect(bridgeUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { deviceId: 'device-1' },
      data: { isOnline: false, lastOfflineAt: expect.any(Date) },
    });
    expect(emit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('marking offline'));
  });

  it('emits bridge.alert once the offline episode exceeds the threshold in an online zone', async () => {
    const offlineSince = new Date(Date.now() - BRIDGE_OFFLINE_ALERT_AFTER_MS - MINUTE);
    const { service, emit, bridgeUpdate } = buildService([
      deviceRow({ isOnline: false, lastOfflineAt: offlineSince, lastSeenAt: offlineSince }),
    ]);

    await service.reconcileBridgePresence(present('zone-a', ['other-spoke']));

    expect(emit).toHaveBeenCalledExactlyOnceWith(
      'bridge.alert',
      expect.objectContaining({
        deviceId: 'device-1',
        instanceId: 'spoke-1',
        zoneId: 'zone-a',
        zoneName: 'us-east-1',
        offlineSince,
        bridgeVersion: '1.2.3',
      }),
    );
    expect(bridgeUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { deviceId: 'device-1' },
      data: { offlineAlertSentAt: expect.any(Date) },
    });
  });

  it('does not alert before the offline threshold elapses', async () => {
    const offlineSince = new Date(Date.now() - BRIDGE_OFFLINE_ALERT_AFTER_MS + MINUTE);
    const { service, emit } = buildService([deviceRow({ isOnline: false, lastOfflineAt: offlineSince })]);

    await service.reconcileBridgePresence(present('zone-a', ['other-spoke']));

    expect(emit).not.toHaveBeenCalled();
  });

  it('suppresses bridge.alert when the whole zone is offline (zone.alert owns that)', async () => {
    const offlineSince = new Date(Date.now() - BRIDGE_OFFLINE_ALERT_AFTER_MS - MINUTE);
    const { service, emit } = buildService([deviceRow({ isOnline: false, lastOfflineAt: offlineSince })]);

    await service.reconcileBridgePresence(new Map());

    expect(emit).not.toHaveBeenCalled();
  });

  it('dedupes: a stamp at/after this episode start means already alerted', async () => {
    const offlineSince = new Date(Date.now() - BRIDGE_OFFLINE_ALERT_AFTER_MS - 2 * MINUTE);
    const { service, emit } = buildService([
      deviceRow({
        isOnline: false,
        lastOfflineAt: offlineSince,
        offlineAlertSentAt: new Date(offlineSince.getTime() + MINUTE),
      }),
    ]);

    await service.reconcileBridgePresence(present('zone-a', ['other-spoke']));

    expect(emit).not.toHaveBeenCalled();
  });

  it('re-alerts for a NEW episode (stamp predates the latest offline transition)', async () => {
    const offlineSince = new Date(Date.now() - BRIDGE_OFFLINE_ALERT_AFTER_MS - MINUTE);
    const { service, emit } = buildService([
      deviceRow({
        isOnline: false,
        lastOfflineAt: offlineSince,
        offlineAlertSentAt: new Date(offlineSince.getTime() - 60 * MINUTE),
      }),
    ]);

    await service.reconcileBridgePresence(present('zone-a', ['other-spoke']));

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does not emit bridge.alert in non-prod environments but stamps offlineAlertSentAt', async () => {
    const offlineSince = new Date(Date.now() - BRIDGE_OFFLINE_ALERT_AFTER_MS - MINUTE);
    const { service, emit, logger, bridgeUpdate } = buildService(
      [deviceRow({ isOnline: false, lastOfflineAt: offlineSince })],
      { hhEnv: 'staging' },
    );

    await service.reconcileBridgePresence(present('zone-a', ['other-spoke']));

    expect(emit).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Skipping bridge offline alert'));
    expect(bridgeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { offlineAlertSentAt: expect.any(Date) } }),
    );
  });

  it('logs recovery and re-marks online when an offline bridge reappears', async () => {
    const { service, bridgeUpdate, logger } = buildService([
      deviceRow({ isOnline: false, lastOfflineAt: new Date(Date.now() - 5 * MINUTE) }),
    ]);

    await service.reconcileBridgePresence(present('zone-a', ['spoke-1']));

    expect(bridgeUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { deviceId: 'device-1' },
      data: { isOnline: true, lastSeenAt: expect.any(Date) },
    });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('back online'));
  });

  it('only considers ever-seen bridges (query pins lastSeenAt non-null)', async () => {
    const { service, deviceFindMany } = buildService([]);

    await service.reconcileBridgePresence(new Map());

    expect(deviceFindMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: expect.objectContaining({ bridge: { is: { lastSeenAt: { not: null } } } }),
      }),
    );
  });

  it('isolates per-bridge failures so the rest of the fleet still reconciles', async () => {
    const offlineSince = new Date(Date.now() - BRIDGE_OFFLINE_ALERT_AFTER_MS - MINUTE);
    const { service, bridgeUpdate, emit, logger } = buildService([
      deviceRow(),
      deviceRow({ isOnline: false, lastOfflineAt: offlineSince, lastSeenAt: offlineSince }, {
        id: 'device-2',
        name: 'spoke-2',
      }),
    ]);
    bridgeUpdate.mockRejectedValueOnce(new Error('db down'));

    await service.reconcileBridgePresence(present('zone-a', ['spoke-1']));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('spoke-1'));
    expect(emit).toHaveBeenCalledExactlyOnceWith('bridge.alert', expect.objectContaining({ deviceId: 'device-2' }));
  });
});
