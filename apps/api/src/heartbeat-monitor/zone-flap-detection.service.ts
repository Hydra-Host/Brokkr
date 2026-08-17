import { Injectable } from '@nestjs/common';
import { getTelemetryMeter } from '@repo/telemetry';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { formatZone } from './heartbeat-monitor.constants';

export interface FlapDetectionResult {
  isFlapping: boolean;
}

@Injectable()
export class ZoneFlapDetectionService {
  private readonly FLAP_WINDOW_MINUTES = 20;

  private readonly flapEpisodes = getTelemetryMeter('brokkr-hub').createCounter('brokkr.zone.flap_episodes', {
    description: 'Zone flapping episodes detected by the presence sweep',
  });

  // Dedup the episode counter: continuous flapping (bouncing every few minutes)
  // counts once, not per bounce. In-memory is fine — resets with the process.
  private readonly lastFlapDetectedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaClient,
    @Logger(ZoneFlapDetectionService.name) private readonly logger: LoggerService,
  ) {}

  private async detectZoneFlapping(zoneId: string, zoneName?: string | null): Promise<FlapDetectionResult> {
    const zone = formatZone(zoneId, zoneName);
    const windowStart = new Date(Date.now() - this.FLAP_WINDOW_MINUTES * 60 * 1000);

    const zoneStatus = await this.prisma.zoneStatus.findUnique({
      where: { zoneId },
      select: { lastOfflineAt: true, lastOnlineAt: true },
    });

    if (!zoneStatus?.lastOfflineAt || !zoneStatus?.lastOnlineAt) {
      return { isFlapping: false };
    }

    const offlineRecent = zoneStatus.lastOfflineAt >= windowStart;
    const onlineRecent = zoneStatus.lastOnlineAt >= windowStart;
    const isFlapping = offlineRecent && onlineRecent;

    if (isFlapping) {
      this.logger.warn(
        `Zone ${zone} is FLAPPING: both offline and online transitions within last ${this.FLAP_WINDOW_MINUTES} minutes`,
      );
    }

    return { isFlapping };
  }

  async isNewFlappingEpisode(zoneId: string, zoneName?: string | null): Promise<boolean> {
    const result = await this.detectZoneFlapping(zoneId, zoneName);
    if (result.isFlapping) {
      const now = Date.now();
      const last = this.lastFlapDetectedAt.get(zoneId);
      // A detection more than one flap window after the previous one starts a
      // new episode; anything closer is the same episode continuing.
      if (last === undefined || now - last > this.FLAP_WINDOW_MINUTES * 60 * 1000) {
        this.flapEpisodes.add(1);
      }
      this.lastFlapDetectedAt.set(zoneId, now);
    }
    return result.isFlapping;
  }
}
