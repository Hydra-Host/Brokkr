import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getBullMqTelemetry } from '@repo/telemetry';
import { Job } from 'bullmq';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { HeartbeatMonitorService } from './heartbeat-monitor.service';
import { HEARTBEAT_MONITOR_INTERVAL_MS, HEARTBEAT_MONITOR_QUEUE } from './heartbeat-monitor.types';

@Injectable()
@Processor(HEARTBEAT_MONITOR_QUEUE, { telemetry: getBullMqTelemetry('brokkr-hub') })
export class HeartbeatMonitorCron extends WorkerHost implements OnApplicationBootstrap {
  private readonly enabled: boolean;

  constructor(
    private readonly heartbeatMonitorService: HeartbeatMonitorService,
    private readonly configService: ConfigService,
    @Logger(HeartbeatMonitorCron.name) private readonly logger: LoggerService,
  ) {
    super();
    this.enabled = this.configService.get('HEARTBEAT_MONITOR_ENABLED') !== 'false';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) await this.worker.pause();
  }

  async process(_job: Job): Promise<void> {
    if (!this.enabled) throw new Error('Heartbeat monitor is disabled on this instance');

    const startTime = Date.now();
    try {
      const zoneStatuses = await this.heartbeatMonitorService.checkBridgePresence();

      const offlineZones = zoneStatuses.filter((z) => !z.isOnline);
      for (const zone of offlineZones) {
        try {
          await this.heartbeatMonitorService.publishZoneOfflineEvent(
            zone.zoneId,
            zone.zoneName,
            zone.flapSuppressed ?? false,
          );
        } catch (error) {
          this.logger.error(`Failed to publish offline event for zone ${zone.zoneName}: ${getErrorMessage(error)}`);
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Bridge presence check completed in ${duration}ms - ${zoneStatuses.length} zones, ${offlineZones.length} offline`,
      );
      if (duration > HEARTBEAT_MONITOR_INTERVAL_MS) {
        this.logger.warn(
          `Heartbeat monitor sweep took ${duration}ms, exceeding its ${HEARTBEAT_MONITOR_INTERVAL_MS}ms interval`,
        );
      }
    } catch (error) {
      this.logger.error(`Heartbeat monitor sweep failed: ${getErrorMessage(error)}`);
      throw error;
    }
  }
}
