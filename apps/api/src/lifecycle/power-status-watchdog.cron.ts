import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TRANSITIONAL_SERVER_POWER_STATUSES } from '@repo/device-domain';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

const STALE_AFTER_MS = 15 * 60 * 1000;

@Injectable()
export class PowerStatusWatchdogCron {
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    @Logger(PowerStatusWatchdogCron.name) private readonly logger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'power-status-watchdog' })
  async handleCron(): Promise<void> {
    if (this.running) {
      this.logger.warn('Skipping the power status watchdog because the previous run is still active');
      return;
    }

    this.running = true;
    try {
      await this.clearStaleStatuses();
    } catch (error) {
      this.logger.error(`The power status watchdog query failed: ${getErrorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async clearStaleStatuses(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);
    await this.prisma.server.updateMany({
      where: {
        powerStatus: { in: [...TRANSITIONAL_SERVER_POWER_STATUSES] },
        updatedAt: { lt: cutoff },
        device: { deletedAt: null },
      },
      data: { powerStatus: null },
    });
  }
}
