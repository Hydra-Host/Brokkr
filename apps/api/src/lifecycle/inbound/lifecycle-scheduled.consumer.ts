import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  LIFECYCLE_SCHEDULED_QUEUE,
  START_LINKED_PROVISION_JOB,
  scheduledJobDataSchema,
  type ScheduledJobData,
} from '@repo/lifecycle';
import { getBullMqTelemetry } from '@repo/telemetry';
import { Job } from 'bullmq';
import { Logger } from '../../common/decorators/logger.decorator';
import { getErrorMessage } from '../../common/error-utils';
import { LoggerService } from '../../logger/logger.service';
import { LifecycleService } from '../lifecycle.service';

@Processor(LIFECYCLE_SCHEDULED_QUEUE, { telemetry: getBullMqTelemetry('brokkr-hub') })
export class LifecycleScheduledConsumer extends WorkerHost {
  constructor(
    private readonly lifecycle: LifecycleService,
    @Logger(LifecycleScheduledConsumer.name) private readonly logger: LoggerService,
  ) {
    super();
  }

  async process(bullJob: Job<ScheduledJobData, void, string>): Promise<void> {
    const { jobId } = scheduledJobDataSchema.parse(bullJob.data);
    try {
      if (bullJob.name === START_LINKED_PROVISION_JOB) {
        await this.lifecycle.startLinkedProvision(jobId);
      } else {
        await this.lifecycle.resumeScheduled(jobId);
      }
    } catch (error) {
      this.logger.error(`Failed scheduled lifecycle job ${bullJob.name} ${jobId}: ${getErrorMessage(error)}`);
      throw error;
    }
  }
}
