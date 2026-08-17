import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

const RETENTION_DAYS = 7;

@Injectable()
export class HeartbeatRetentionCron {
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
    @Logger(HeartbeatRetentionCron.name) private readonly logger: LoggerService,
  ) {
    this.enabled = this.configService.get('HEARTBEAT_MONITOR_ENABLED') !== 'false';
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'heartbeat-retention' })
  async purgeOldHeartbeats() {
    if (!this.enabled) return;

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    try {
      const [heartbeats, healthChecks] = await Promise.all([
        this.prisma.bridgeHeartbeat.deleteMany({ where: { receivedAt: { lt: cutoff } } }),
        this.prisma.deviceHealthCheck.deleteMany({ where: { testedAt: { lt: cutoff } } }),
      ]);

      const total = heartbeats.count + healthChecks.count;
      if (total > 0) {
        this.logger.log(
          `Purged ${heartbeats.count} heartbeats + ${healthChecks.count} health checks older than ${RETENTION_DAYS} days`,
        );
      }
    } catch (error) {
      this.logger.error(`Heartbeat retention cleanup failed: ${getErrorMessage(error)}`);
    }
  }
}
