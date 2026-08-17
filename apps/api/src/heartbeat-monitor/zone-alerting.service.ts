import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { formatZone } from './heartbeat-monitor.constants';

export interface ZoneOfflineAlert {
  zoneId: string;
  zoneName: string;
  lastHeartbeat: Date;
  timeSinceHeartbeat: number;
  deviceCount: number;
  activeRentalsCount: number;
}

@Injectable()
export class ZoneAlertingService {
  private readonly hydraHostEnv: string;

  constructor(
    private readonly prisma: PrismaClient,
    @Inject(PLUGIN_EVENT_BUS)
    private readonly eventBus: PluginEventBus,
    private readonly configService: ConfigService,
    @Logger(ZoneAlertingService.name) private readonly logger: LoggerService,
  ) {
    // HH_ENV is unset on self-hosted BOSS; default (not getOrThrow) so boot can't crash, and non-'prod' skips alerting.
    this.hydraHostEnv = this.configService.get<string>('HH_ENV') ?? 'local';
  }

  async sendZoneOfflineAlert(zoneId: string, lastHeartbeat: Date): Promise<void> {
    const zoneRecord = await this.prisma.zone.findUnique({
      where: { id: zoneId },
      select: { name: true },
    });
    const zone = formatZone(zoneId, zoneRecord?.name);

    if (this.hydraHostEnv !== 'prod') {
      this.logger.log(`Skipping zone offline alert in ${this.hydraHostEnv} environment for zone ${zone}`);
      return;
    }

    try {
      const zoneStatus = await this.prisma.zoneStatus.findUnique({
        where: { zoneId },
      });

      // The sweep flips isOnline=false before this runs, so the flag can't dedupe;
      // compare alertSentAt against the episode start (lastOfflineAt) instead.
      const alertedThisEpisode =
        zoneStatus?.alertSentAt != null &&
        (zoneStatus.lastOfflineAt == null || zoneStatus.alertSentAt >= zoneStatus.lastOfflineAt);
      if (alertedThisEpisode) {
        this.logger.log(`Zone ${zone} already alerted for this offline episode, skipping duplicate alert`);
        return;
      }

      const alertData = await this.gatherZoneAlertData(zoneId, zoneRecord?.name ?? zoneId, lastHeartbeat);

      await this.prisma.zoneStatus.upsert({
        where: { zoneId },
        create: {
          zoneId,
          isOnline: false,
          lastOfflineAt: new Date(),
          lastHeartbeatAt: lastHeartbeat,
        },
        update: {
          isOnline: false,
          lastOfflineAt: new Date(),
          lastHeartbeatAt: lastHeartbeat,
        },
      });

      this.eventBus.emit('zone.alert', {
        zoneId,
        zoneName: alertData.zoneName,
        lastHeartbeatAt: alertData.lastHeartbeat,
        timeSinceHeartbeatSeconds: alertData.timeSinceHeartbeat,
        deviceCount: alertData.deviceCount,
        activeRentalsCount: alertData.activeRentalsCount,
      });

      try {
        await this.prisma.zoneStatus.update({
          where: { zoneId },
          data: { alertSentAt: new Date() },
        });
      } catch (error) {
        this.logger.error(`Failed to update zone status alertSentAt for zone ${zone}`, getErrorMessage(error));
      }

      this.logger.log(`Zone offline alert processing completed for zone: ${zone}`);
    } catch (error) {
      this.logger.error(`Failed to send zone offline alert for zone ${zone}`, getErrorMessage(error));
      throw error;
    }
  }

  private async gatherZoneAlertData(zoneId: string, zoneName: string, lastHeartbeat: Date): Promise<ZoneOfflineAlert> {
    const timeSinceHeartbeat = Math.floor((Date.now() - lastHeartbeat.getTime()) / 1000);

    const [deviceCount, activeRentalsCount] = await Promise.all([
      this.prisma.device.count({ where: { zoneId } }),
      this.prisma.deployment.count({
        where: { endDate: null, server: { device: { zoneId } } },
      }),
    ]);

    return { zoneId, zoneName, lastHeartbeat, timeSinceHeartbeat, deviceCount, activeRentalsCount };
  }

  async sendZoneOnlineAlert(zoneId: string): Promise<void> {
    const zoneRecord = await this.prisma.zone.findUnique({
      where: { id: zoneId },
      select: { name: true },
    });
    const zone = formatZone(zoneId, zoneRecord?.name);

    try {
      const zoneStatus = await this.prisma.zoneStatus.findUnique({
        where: { zoneId },
      });

      if (!zoneStatus || zoneStatus.isOnline) {
        this.logger.log(`Zone ${zone} is already marked as online, skipping recovery alert`);
        return;
      }

      await this.prisma.zoneStatus.update({
        where: { zoneId },
        data: { isOnline: true, lastOnlineAt: new Date() },
      });

      const downtime = zoneStatus.lastOfflineAt
        ? Math.floor((Date.now() - zoneStatus.lastOfflineAt.getTime()) / 1000)
        : 0;
      const downtimeMinutes = Math.floor(downtime / 60);

      this.logger.log(`Zone ${zone} back online (downtime: ${downtimeMinutes}m)`);
    } catch (error) {
      this.logger.error(`Failed to send zone online alert for zone ${zone}`, getErrorMessage(error));
    }
  }

  async updateZoneHeartbeat(zoneId: string, heartbeatTime: Date): Promise<void> {
    const zoneRecord = await this.prisma.zone.findUnique({
      where: { id: zoneId },
      select: { name: true },
    });
    const zone = formatZone(zoneId, zoneRecord?.name);

    try {
      const zoneStatus = await this.prisma.zoneStatus.upsert({
        where: { zoneId },
        create: {
          zoneId,
          isOnline: true,
          lastOnlineAt: new Date(),
          lastHeartbeatAt: heartbeatTime,
        },
        update: { lastHeartbeatAt: heartbeatTime },
      });

      if (!zoneStatus.isOnline) {
        await this.sendZoneOnlineAlert(zoneId);
      }
    } catch (error) {
      this.logger.error(`Failed to update zone heartbeat for zone ${zone}`, getErrorMessage(error));
    }
  }
}
