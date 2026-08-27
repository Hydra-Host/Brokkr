import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeviceRole } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { BRIDGE_OFFLINE_ALERT_AFTER_MS, formatZone } from './heartbeat-monitor.constants';

interface BridgePresenceRow {
  isOnline: boolean;
  lastSeenAt: Date | null;
  lastOfflineAt: Date | null;
  offlineAlertSentAt: Date | null;
  bridgeVersion: string | null;
}

interface BridgeDeviceRow {
  id: string;
  name: string | null;
  zoneId: string | null;
  zone: { name: string } | null;
  bridge: BridgePresenceRow | null;
}

// Bridge-level companion to ZoneAlertingService: materializes per-bridge presence
// (Bridge.isOnline/lastSeenAt/lastOfflineAt) from the sweep and emits bridge.alert.
@Injectable()
export class BridgeAlertingService {
  private readonly hydraHostEnv: string;

  constructor(
    private readonly prisma: PrismaClient,
    @Inject(PLUGIN_EVENT_BUS)
    private readonly eventBus: PluginEventBus,
    private readonly configService: ConfigService,
    @Logger(BridgeAlertingService.name) private readonly logger: LoggerService,
  ) {
    // Same non-prod alert gate as ZoneAlertingService (HH_ENV unset on self-hosted BOSS).
    this.hydraHostEnv = this.configService.get<string>('HH_ENV') ?? 'local';
  }

  // `present` is the sweep's live view: zoneId -> instanceIds with a presence key this tick.
  // Only ever-seen bridges (lastSeenAt set) participate — CRUD-only rows never alert.
  async reconcileBridgePresence(present: Map<string, Set<string>>): Promise<void> {
    const devices: BridgeDeviceRow[] = await this.prisma.device.findMany({
      where: {
        role: DeviceRole.Bridge,
        deletedAt: null,
        zoneId: { not: null },
        bridge: { is: { lastSeenAt: { not: null } } },
      },
      select: {
        id: true,
        name: true,
        zoneId: true,
        zone: { select: { name: true } },
        bridge: {
          select: {
            isOnline: true,
            lastSeenAt: true,
            lastOfflineAt: true,
            offlineAlertSentAt: true,
            bridgeVersion: true,
          },
        },
      },
    });

    const now = new Date();
    for (const device of devices) {
      const { bridge, zoneId, name } = device;
      if (!bridge || !zoneId || !name) continue;
      const zoneInstances = present.get(zoneId);
      // Per-bridge isolation: one failed status write must not starve the rest of the fleet.
      try {
        if (zoneInstances?.has(name)) {
          await this.markSeen(device, bridge, now);
        } else {
          await this.handleAbsent(device, bridge, (zoneInstances?.size ?? 0) > 0, now);
        }
      } catch (error) {
        this.logger.error(`Bridge presence reconcile failed for ${name} (${device.id}): ${getErrorMessage(error)}`);
      }
    }
  }

  // Present bridges get lastSeenAt bumped every sweep, so DB freshness is sweep-granular
  // (60s) rather than the reconciler's write-on-change semantics.
  private async markSeen(device: BridgeDeviceRow, bridge: BridgePresenceRow, now: Date): Promise<void> {
    if (!bridge.isOnline) {
      const downtime = bridge.lastOfflineAt ? Math.floor((now.getTime() - bridge.lastOfflineAt.getTime()) / 1000) : 0;
      this.logger.log(
        `Bridge ${device.name} (zone ${formatZone(device.zoneId ?? '', device.zone?.name)}) back online ` +
          `(downtime: ${Math.floor(downtime / 60)}m)`,
      );
    }
    await this.prisma.bridge.update({
      where: { deviceId: device.id },
      data: { isOnline: true, lastSeenAt: now },
    });
  }

  private async handleAbsent(
    device: BridgeDeviceRow,
    bridge: BridgePresenceRow,
    zoneOnline: boolean,
    now: Date,
  ): Promise<void> {
    const zone = formatZone(device.zoneId ?? '', device.zone?.name);

    if (bridge.isOnline) {
      this.logger.warn(`Bridge ${device.name} (zone ${zone}) missing from presence — marking offline`);
      await this.prisma.bridge.update({
        where: { deviceId: device.id },
        data: { isOnline: false, lastOfflineAt: now },
      });
      return;
    }

    const offlineSince = bridge.lastOfflineAt ?? bridge.lastSeenAt;
    if (!offlineSince) return;
    if (now.getTime() - offlineSince.getTime() < BRIDGE_OFFLINE_ALERT_AFTER_MS) return;
    // Whole-zone outages are zone.alert's job — bridge.alert only covers partial outages.
    if (!zoneOnline) return;
    // Episode dedupe: a stamp at/after this episode's offline transition means already alerted.
    if (bridge.offlineAlertSentAt && bridge.offlineAlertSentAt >= offlineSince) return;

    await this.sendBridgeOfflineAlert(device, bridge, offlineSince);
  }

  private async sendBridgeOfflineAlert(
    device: BridgeDeviceRow,
    bridge: BridgePresenceRow,
    offlineSince: Date,
  ): Promise<void> {
    const zone = formatZone(device.zoneId ?? '', device.zone?.name);

    try {
      await this.prisma.bridge.update({
        where: { deviceId: device.id },
        data: { offlineAlertSentAt: new Date() },
      });
    } catch (error) {
      this.logger.error(
        `Failed to stamp offlineAlertSentAt for bridge ${device.name} (${device.id})`,
        getErrorMessage(error),
      );
    }

    if (this.hydraHostEnv !== 'prod') {
      this.logger.log(
        `Skipping bridge offline alert in ${this.hydraHostEnv} environment for bridge ${device.name} (zone ${zone})`,
      );
      return;
    }

    const lastSeenAt = bridge.lastSeenAt ?? offlineSince;
    this.logger.warn(`[EVENT] Bridge offline: ${device.name} (zone ${zone})`);

    this.eventBus.emit('bridge.alert', {
      deviceId: device.id,
      instanceId: device.name ?? device.id,
      zoneId: device.zoneId ?? '',
      zoneName: device.zone?.name ?? device.zoneId ?? '',
      lastSeenAt,
      offlineSince,
      timeSinceLastSeenSeconds: Math.floor((Date.now() - lastSeenAt.getTime()) / 1000),
      bridgeVersion: bridge.bridgeVersion,
    });
  }
}
