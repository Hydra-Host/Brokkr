import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  LIFECYCLE_WATCHDOG_QUEUE,
  PHONE_HOME_WATCHDOG_JOB,
  POWER_WATCHDOG_JOB,
  scheduledJobDataSchema,
  type ScheduledJobData,
} from '@repo/lifecycle';
import { getBullMqTelemetry } from '@repo/telemetry';
import { Job } from 'bullmq';
import { Logger } from '../../common/decorators/logger.decorator';
import { getErrorMessage } from '../../common/error-utils';
import { LoggerService } from '../../logger/logger.service';
import { LifecycleInboundService } from './lifecycle-inbound.service';

@Processor(LIFECYCLE_WATCHDOG_QUEUE, { telemetry: getBullMqTelemetry('brokkr-hub') })
export class LifecycleWatchdogConsumer extends WorkerHost {
  constructor(
    private readonly inbound: LifecycleInboundService,
    @Logger(LifecycleWatchdogConsumer.name) private readonly logger: LoggerService,
  ) {
    super();
  }

  async process(bullJob: Job<ScheduledJobData, void, string>): Promise<void> {
    const { jobId } = scheduledJobDataSchema.parse(bullJob.data);
    try {
      switch (bullJob.name) {
        case PHONE_HOME_WATCHDOG_JOB:
          return await this.inbound.checkPhoneHomeDeadline(jobId);
        case POWER_WATCHDOG_JOB:
          return await this.inbound.checkPowerSagaDeadline(jobId);
        default:
          this.logger.warn(`Unknown watchdog job '${bullJob.name}' for lifecycle job ${jobId}`);
      }
    } catch (error) {
      this.logger.error(`Watchdog '${bullJob.name}' failed for lifecycle job ${jobId}: ${getErrorMessage(error)}`);
      throw error;
    }
  }
}
