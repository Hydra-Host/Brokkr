import { Test, TestingModule } from '@nestjs/testing';
import { createLoggerMock } from 'src/common/logger-test-utils';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { REDIS_CLIENT } from '../../common/redis';
import { BridgeAlertingService } from '../bridge-alerting.service';
import { HeartbeatMonitorService } from '../heartbeat-monitor.service';
import { ZoneAlertingService } from '../zone-alerting.service';
import { ZoneFlapAlertingService } from '../zone-flap-alerting.service';
import { ZoneFlapDetectionService } from '../zone-flap-detection.service';

const { counterAdd, gaugeCallbacks } = vi.hoisted(() => ({
  counterAdd: vi.fn(),
  gaugeCallbacks: new Map<string, (observable: { observe: Mock }) => unknown>(),
}));
vi.mock('@repo/telemetry', () => ({
  getTelemetryMeter: () => ({
    createCounter: (name: string) => ({
      add: (value: number, attributes?: Record<string, unknown>) => counterAdd(name, value, attributes),
    }),
    createObservableGauge: (name: string) => ({
      addCallback: (callback: (observable: { observe: Mock }) => unknown) => gaugeCallbacks.set(name, callback),
      removeCallback: () => gaugeCallbacks.delete(name),
    }),
  }),
  getBullMqTelemetry: () => undefined,
}));

describe('HeartbeatMonitorService — zone metrics', () => {
  let service: HeartbeatMonitorService;
  let scan: Mock;
  let zoneFindMany: Mock;
  let zoneStatusFindMany: Mock;
  let checkAndAlertIfFlapping: Mock;
  let sendZoneOfflineAlert: Mock;
  let constructionAdds: unknown[][];

  interface SweepState {
    keys?: string[];
    zones?: { id: string; name: string }[];
    prior?: { zoneId: string; isOnline: boolean }[];
    knownOnline?: { zoneId: string; zone: { name: string } | null }[];
  }

  function primeSweep({ keys = [], zones = [], prior = [], knownOnline = [] }: SweepState) {
    scan.mockResolvedValue(['0', keys]);
    zoneFindMany.mockResolvedValue(zones);
    zoneStatusFindMany.mockImplementation(({ where }: { where: { isOnline?: boolean } }) =>
      where.isOnline === true ? knownOnline : prior,
    );
  }

  beforeEach(async () => {
    counterAdd.mockClear();
    gaugeCallbacks.clear();
    scan = vi.fn();
    zoneFindMany = vi.fn();
    zoneStatusFindMany = vi.fn();
    checkAndAlertIfFlapping = vi.fn().mockResolvedValue(false);
    sendZoneOfflineAlert = vi.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HeartbeatMonitorService,
        {
          provide: PrismaClient,
          useValue: {
            zone: { findMany: zoneFindMany },
            zoneStatus: {
              findMany: zoneStatusFindMany,
              upsert: vi.fn().mockResolvedValue({}),
              update: vi.fn().mockResolvedValue({}),
            },
            bridgeHeartbeat: { createMany: vi.fn().mockResolvedValue({}) },
          },
        },
        { provide: REDIS_CLIENT, useValue: { scan, hgetall: vi.fn().mockResolvedValue({}) } },
        { provide: ZoneAlertingService, useValue: { sendZoneOfflineAlert } },
        { provide: ZoneFlapAlertingService, useValue: { checkAndAlertIfFlapping } },
        { provide: BridgeAlertingService, useValue: { reconcileBridgePresence: vi.fn().mockResolvedValue(undefined) } },
        { provide: 'LoggerServiceHeartbeatMonitorService', useValue: createLoggerMock() },
      ],
    }).compile();

    service = module.get(HeartbeatMonitorService);
    constructionAdds = counterAdd.mock.calls.map((call) => [...call]);
    counterAdd.mockClear();
  });

  it('pre-registers every transition series at zero so the offline alert increase() sees the first change', () => {
    expect(constructionAdds).toContainEqual(['brokkr.zone.status_changes', 0, { to: 'online', suppressed: 'false' }]);
    expect(constructionAdds).toContainEqual(['brokkr.zone.status_changes', 0, { to: 'offline', suppressed: 'false' }]);
    expect(constructionAdds).toContainEqual(['brokkr.zone.status_changes', 0, { to: 'offline', suppressed: 'true' }]);
  });

  it('counts a zone coming online only when it was not already online', async () => {
    primeSweep({
      keys: ['zone-a:bridge:instance:i1'],
      zones: [{ id: 'zone-a', name: 'A' }],
      prior: [],
    });

    await service.checkBridgePresence();

    expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.zone.status_changes', 1, {
      to: 'online',
      suppressed: 'false',
    });
  });

  it('does not count a steady-state online re-mark', async () => {
    primeSweep({
      keys: ['zone-a:bridge:instance:i1'],
      zones: [{ id: 'zone-a', name: 'A' }],
      prior: [{ zoneId: 'zone-a', isOnline: true }],
      knownOnline: [{ zoneId: 'zone-a', zone: { name: 'A' } }],
    });

    await service.checkBridgePresence();

    expect(counterAdd).not.toHaveBeenCalled();
  });

  it('counts an unsuppressed offline transition in the sweep, right after the status write', async () => {
    primeSweep({ knownOnline: [{ zoneId: 'zone-b', zone: { name: 'B' } }] });
    checkAndAlertIfFlapping.mockResolvedValue(false);

    await service.checkBridgePresence();

    expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.zone.status_changes', 1, {
      to: 'offline',
      suppressed: 'false',
    });
  });

  it('counts a suppressed offline transition when flap detection suppresses the alert', async () => {
    primeSweep({ knownOnline: [{ zoneId: 'zone-b', zone: { name: 'B' } }] });
    checkAndAlertIfFlapping.mockResolvedValue(true);

    await service.checkBridgePresence();

    expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.zone.status_changes', 1, {
      to: 'offline',
      suppressed: 'true',
    });
  });

  it('publishZoneOfflineEvent does not count — the sweep owns the transition metric', async () => {
    await service.publishZoneOfflineEvent('zone-b', 'B', false);
    await service.publishZoneOfflineEvent('zone-b', 'B', true);

    expect(counterAdd).not.toHaveBeenCalled();
  });

  it('publishZoneOfflineEvent forwards to the offline alert when the zone is not flapping', async () => {
    await service.publishZoneOfflineEvent('zone-b', 'B', false);

    expect(sendZoneOfflineAlert).toHaveBeenCalledExactlyOnceWith('zone-b', expect.any(Date));
  });

  it('publishZoneOfflineEvent suppresses the offline alert when the zone is flapping', async () => {
    await service.publishZoneOfflineEvent('zone-b', 'B', true);

    expect(sendZoneOfflineAlert).not.toHaveBeenCalled();
  });

  describe('brokkr.zones.online gauge', () => {
    it('stays silent before the first sweep', () => {
      const observe = vi.fn();
      gaugeCallbacks.get('brokkr.zones.online')?.({ observe });
      expect(observe).not.toHaveBeenCalled();
    });

    it('reports the latest sweep online count', async () => {
      primeSweep({
        keys: ['zone-a:bridge:instance:i1'],
        zones: [{ id: 'zone-a', name: 'A' }],
        knownOnline: [{ zoneId: 'zone-b', zone: { name: 'B' } }],
      });
      await service.checkBridgePresence();

      const observe = vi.fn();
      gaugeCallbacks.get('brokkr.zones.online')?.({ observe });
      expect(observe).toHaveBeenCalledExactlyOnceWith(1);
    });
  });
});

describe('ZoneFlapDetectionService — brokkr.zone.flap_episodes', () => {
  let detection: ZoneFlapDetectionService;
  let zoneStatusFindUnique: Mock;

  beforeEach(async () => {
    counterAdd.mockClear();
    zoneStatusFindUnique = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneFlapDetectionService,
        { provide: PrismaClient, useValue: { zoneStatus: { findUnique: zoneStatusFindUnique } } },
        { provide: 'LoggerServiceZoneFlapDetectionService', useValue: createLoggerMock() },
      ],
    }).compile();

    detection = module.get(ZoneFlapDetectionService);
  });

  it('counts a flapping episode', async () => {
    zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });

    await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(true);

    expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.zone.flap_episodes', 1, undefined);
  });

  it('counts one continuous episode once, not once per bounce', async () => {
    vi.useFakeTimers();
    try {
      zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });

      for (let bounce = 0; bounce < 5; bounce++) {
        await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(true);
        vi.advanceTimersByTime(2 * 60 * 1000);
        zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });
      }

      expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.zone.flap_episodes', 1, undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a new episode after a full flap window of quiet', async () => {
    vi.useFakeTimers();
    try {
      zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });
      await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(true);

      vi.advanceTimersByTime(21 * 60 * 1000);
      zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });
      await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(true);

      expect(counterAdd).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps continuous flapping one episode while each detection slides the window forward', async () => {
    vi.useFakeTimers();
    try {
      zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });
      await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(true);

      vi.advanceTimersByTime(19 * 60 * 1000);
      zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });
      await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(true);

      vi.advanceTimersByTime(16 * 60 * 1000);
      zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });
      await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(true);

      expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.zone.flap_episodes', 1, undefined);

      vi.advanceTimersByTime(21 * 60 * 1000);
      zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });
      await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(true);

      expect(counterAdd).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks episodes per zone independently', async () => {
    zoneStatusFindUnique.mockResolvedValue({ lastOfflineAt: new Date(), lastOnlineAt: new Date() });

    await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(true);
    await expect(detection.isNewFlappingEpisode('zone-b', 'B')).resolves.toBe(true);

    expect(counterAdd).toHaveBeenCalledTimes(2);
  });

  it('does not count when the zone is not flapping', async () => {
    zoneStatusFindUnique.mockResolvedValue({
      lastOfflineAt: new Date(Date.now() - 60 * 60 * 1000),
      lastOnlineAt: new Date(),
    });

    await expect(detection.isNewFlappingEpisode('zone-a', 'A')).resolves.toBe(false);

    expect(counterAdd).not.toHaveBeenCalled();
  });
});

describe('ZoneFlapAlertingService — routes through the episode seam', () => {
  it('returns the detection verdict from isNewFlappingEpisode', async () => {
    const isNewFlappingEpisode = vi.fn().mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneFlapAlertingService,
        { provide: ZoneFlapDetectionService, useValue: { isNewFlappingEpisode } },
        { provide: 'LoggerServiceZoneFlapAlertingService', useValue: createLoggerMock() },
      ],
    }).compile();

    const alerting = module.get(ZoneFlapAlertingService);
    await expect(alerting.checkAndAlertIfFlapping('zone-a', 'A')).resolves.toBe(true);
    expect(isNewFlappingEpisode).toHaveBeenCalledExactlyOnceWith('zone-a', 'A');
  });
});
