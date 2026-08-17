import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LIFECYCLE_STUCK_SWEEP_QUEUE } from '@repo/lifecycle';
import { getBullMqTelemetry, getTelemetryMeter } from '@repo/telemetry';
import { Job } from 'bullmq';
import { Logger } from '../../common/decorators/logger.decorator';
import { getErrorMessage } from '../../common/error-utils';
import { LoggerService } from '../../logger/logger.service';
import { LifecycleInboundService } from './lifecycle-inbound.service';

@Injectable()
@Processor(LIFECYCLE_STUCK_SWEEP_QUEUE, { telemetry: getBullMqTelemetry('brokkr-hub') })
export class LifecycleStuckSweepCron extends WorkerHost implements OnApplicationBootstrap {
  private readonly enabled: boolean;

  private readonly stuckSwept = getTelemetryMeter('brokkr-hub').createCounter('brokkr.lifecycle.stuck_swept', {
    description: 'Lifecycle jobs terminalized by the stuck-job backstop sweep',
  });

  constructor(
    private readonly inbound: LifecycleInboundService,
    private readonly configService: ConfigService,
    @Logger(LifecycleStuckSweepCron.name) private readonly logger: LoggerService,
  ) {
    super();
    this.enabled = this.configService.get('LIFECYCLE_STUCK_SWEEP_ENABLED') !== 'false';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) await this.worker.pause();
  }

  async process(_job: Job): Promise<void> {
    if (!this.enabled) throw new Error('Lifecycle stuck sweep is disabled on this instance');

    try {
      const swept = await this.inbound.sweepStuckJobs();
      if (swept > 0) {
        this.stuckSwept.add(swept);
        this.logger.warn(`Terminalized ${swept} stuck lifecycle job(s)`);
      }
    } catch (error) {
      this.logger.error(`Stuck-job sweep failed: ${getErrorMessage(error)}`);
      throw error;
    }
  }
}
