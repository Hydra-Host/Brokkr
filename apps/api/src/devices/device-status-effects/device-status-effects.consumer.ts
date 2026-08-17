import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { getBullMqTelemetry } from '@repo/telemetry';
import { Job } from 'bullmq';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { DeviceNotificationsService } from '../device-notifications/device-notifications.service';
import {
  DEVICE_STATUS_EFFECTS_QUEUE,
  STATUS_TRANSITION_JOB,
  StatusTransitionJobSchema,
} from './device-status-effects.types';

@Injectable()
@Processor(DEVICE_STATUS_EFFECTS_QUEUE, { telemetry: getBullMqTelemetry('brokkr-hub') })
export class DeviceStatusEffectsConsumer extends WorkerHost {
  constructor(
    private readonly notifications: DeviceNotificationsService,
    @Logger(DeviceStatusEffectsConsumer.name) private readonly logger: LoggerService,
  ) {
    super();
  }

  async process(job: Job<unknown, unknown, string>): Promise<void> {
    if (job.name !== STATUS_TRANSITION_JOB) {
      this.logger.warn(`[device-status-effects] Unknown job name "${job.name}" — skipping.`);
      return;
    }

    const data = StatusTransitionJobSchema.parse(job.data);

    try {
      await this.notifications.handleStatusTransitionNotification(data.transition, data.deviceId);
    } catch (error) {
      this.logger.error(
        `[device-status-effects] Failed to dispatch ${data.transition} for device ${data.deviceId}`,
        getErrorMessage(error),
      );
      throw error;
    }
  }
}
