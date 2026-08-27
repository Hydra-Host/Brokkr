import { Inject, Injectable } from '@nestjs/common';
import { getTelemetryMeter } from '@repo/telemetry';
import Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { REDIS_CLIENT, scanKeys } from 'src/common/redis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { BridgeAlertingService } from './bridge-alerting.service';
import { formatZone } from './heartbeat-monitor.constants';
import { ZoneAlertingService } from './zone-alerting.service';
import { ZoneFlapAlertingService } from './zone-flap-alerting.service';

interface ZonePresenceStatus {
  zoneId: string;
  zoneName: string;
  isOnline: boolean;
  bridgeCount: number;
  /** Offline zones only: whether flap detection suppressed the human alert. */
  flapSuppressed?: boolean;
}

@Injectable()
export class HeartbeatMonitorService {
  private readonly zoneStatusChanges = getTelemetryMeter('brokkr-hub').createCounter('brokkr.zone.status_changes', {
    description: 'Zone online/offline transitions observed by the presence sweep, by target state',
  });
  private readonly zonesOnline = getTelemetryMeter('brokkr-hub').createObservableGauge('brokkr.zones.online', {
    description: 'Zones currently online per the latest presence sweep',
  });
  // null until the first sweep completes — the gauge stays silent rather than
  // reporting a false zero.
  private latestOnlineZoneCount: number | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly zoneAlertingService: ZoneAlertingService,
    private readonly zoneFlapAlertingService: ZoneFlapAlertingService,
    private readonly bridgeAlertingService: BridgeAlertingService,
    @Logger(HeartbeatMonitorService.name) private readonly logger: LoggerService,
  ) {
    this.zonesOnline.addCallback((observable) => {
      if (this.latestOnlineZoneCount !== null) observable.observe(this.latestOnlineZoneCount);
    });
    // Pre-register at zero: increase() can't see a series' birth, so the first
    // offline transition post-restart would never fire the (suppressed="false") alert.
    this.zoneStatusChanges.add(0, { to: 'online', suppressed: 'false' });
    this.zoneStatusChanges.add(0, { to: 'offline', suppressed: 'false' });
    this.zoneStatusChanges.add(0, { to: 'offline', suppressed: 'true' });
  }

  async checkBridgePresence(): Promise<ZonePresenceStatus[]> {
    this.logger.debug('Checking bridge presence via Redis keys');

    try {
      const allKeys = await scanKeys(this.redis, REDIS_KEYS.bridgeInstanceScanAll);

      const zoneSet = new Set<string>();
      // Live per-zone instance view for the bridge-level presence reconcile below.
      const presentByZone = new Map<string, Set<string>>();
      for (const key of allKeys) {
        const [prefix, instanceId] = key.split(':bridge:instance:');
        if (!prefix) continue;
        zoneSet.add(prefix);
        if (!instanceId) continue;
        const instances = presentByZone.get(prefix);
        if (instances) instances.add(instanceId);
        else presentByZone.set(prefix, new Set([instanceId]));
      }

      const results: ZonePresenceStatus[] = [];
      const seenZoneIds = new Set<string>();

      const zoneIds = [...zoneSet];
      const zones = await this.prisma.zone.findMany({
        where: { id: { in: zoneIds } },
        select: { id: true, name: true },
      });

      const zoneMap = new Map(zones.map((z) => [z.id, z]));

      // Prior state so the transition counter records actual changes only —
      // the upsert below re-marks online unconditionally every tick.
      const priorStatuses = await this.prisma.zoneStatus.findMany({
        where: { zoneId: { in: zoneIds } },
        select: { zoneId: true, isOnline: true },
      });
      const wasOnline = new Map(priorStatuses.map((s) => [s.zoneId, s.isOnline]));

      await Promise.all(
        zoneIds.map(async (zoneId) => {
          const keys = allKeys.filter((k) => k.startsWith(`${zoneId}:bridge:instance:`));
          const zone = zoneMap.get(zoneId);

          if (!zone) {
            this.logger.warn(`Zone ${zoneId} not found — skipping presence check`);
            return;
          }

          seenZoneIds.add(zoneId);
          const zoneName = zone.name;

          results.push({
            zoneId,
            zoneName,
            isOnline: keys.length > 0,
            bridgeCount: keys.length,
          });

          if (keys.length > 0) {
            try {
              const heartbeatRecords = await Promise.all(
                keys.map(async (key) => {
                  const data = await this.redis.hgetall(key);
                  return {
                    zoneId,
                    instanceId: data.instance_id || key.split(':bridge:instance:')[1] || 'unknown',
                    isLeader: data.is_leader === 'True',
                    netbirdIp: data.netbird_ip || '',
                    brokkrWorkerVersion: data.brokkr_worker_version || '',
                    brokkrLiveVersion: data.brokkr_live_version || '',
                    osImageVersion: data.os_image_version || '',
                  };
                }),
              );

              await this.prisma.bridgeHeartbeat.createMany({ data: heartbeatRecords });
            } catch (error) {
              this.logger.error(`Failed to write heartbeat records for zone ${zoneId}: ${getErrorMessage(error)}`);
            }
          }

          const zoneStr = formatZone(zoneId, zoneName);
          await this.prisma.zoneStatus.upsert({
            where: { zoneId },
            create: {
              zoneId,
              isOnline: true,
              lastHeartbeatAt: new Date(),
              lastOnlineAt: new Date(),
            },
            update: {
              isOnline: true,
              lastHeartbeatAt: new Date(),
              lastOnlineAt: new Date(),
            },
          });
          // Online transitions are never flap-suppressed, but carry the label so
          // the metric's series all share one label set.
          if (wasOnline.get(zoneId) !== true) this.zoneStatusChanges.add(1, { to: 'online', suppressed: 'false' });

          this.logger.debug(`Zone ${zoneStr} (${zoneId}) online (${keys.length} bridges)`);
        }),
      );

      const knownZones = await this.prisma.zoneStatus.findMany({
        where: { isOnline: true },
        select: { zoneId: true, zone: { select: { name: true } } },
      });

      for (const zone of knownZones) {
        if (!seenZoneIds.has(zone.zoneId)) {
          const zoneStr = formatZone(zone.zoneId, zone.zone?.name);
          this.logger.warn(`Zone ${zoneStr} has no active bridges — marking offline`);

          await this.prisma.zoneStatus.update({
            where: { zoneId: zone.zoneId },
            data: { isOnline: false, lastOfflineAt: new Date() },
          });
          // Count the transition here, right after the status write: a later failure would
          // lose it forever (later sweeps see none). checkAndAlertIfFlapping fails closed.
          const flapSuppressed = await this.zoneFlapAlertingService.checkAndAlertIfFlapping(
            zone.zoneId,
            zone.zone?.name,
          );
          this.zoneStatusChanges.add(1, { to: 'offline', suppressed: flapSuppressed ? 'true' : 'false' });

          results.push({
            zoneId: zone.zoneId,
            zoneName: zone.zone?.name ?? zone.zoneId,
            isOnline: false,
            bridgeCount: 0,
            flapSuppressed,
          });
        }
      }

      // Bridge-level granularity rides the same sweep; isolated so a failure
      // here can't break zone status handling or the offline-event publishing.
      try {
        await this.bridgeAlertingService.reconcileBridgePresence(presentByZone);
      } catch (error) {
        this.logger.error(`Bridge-level presence reconcile failed: ${getErrorMessage(error)}`);
      }

      this.latestOnlineZoneCount = results.filter((z) => z.isOnline).length;

      const offlineZones = results.filter((z) => !z.isOnline);
      if (offlineZones.length > 0) {
        this.logger.warn(
          `${offlineZones.length} zones offline: ${offlineZones.map((z) => formatZone(z.zoneId, z.zoneName)).join(', ')}`,
        );
      } else {
        this.logger.log(`All ${results.length} zones online`);
      }

      return results;
    } catch (error) {
      this.logger.error(`Failed to check bridge presence: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  // The suppression decision is passed in (not recomputed) so the flap-episode
  // counter can't double-fire; the sweep already counted the transition.
  async publishZoneOfflineEvent(
    zoneId: string,
    zoneName: string | null | undefined,
    isFlapping: boolean,
  ): Promise<void> {
    const zone = formatZone(zoneId, zoneName);

    if (isFlapping) {
      this.logger.log(`Zone ${zone} is flapping, flapping alert sent instead of offline alert`);
      return;
    }

    this.logger.warn(`[EVENT] Zone offline: ${zone}`);

    await this.zoneAlertingService.sendZoneOfflineAlert(zoneId, new Date());
  }
}
