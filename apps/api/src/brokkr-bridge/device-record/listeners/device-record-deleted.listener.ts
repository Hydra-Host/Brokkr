import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { DeviceLifecycleEvent, type DeviceSoftDeletedEvent } from 'src/devices/device-lifecycle.events';
import { LoggerService } from 'src/logger/logger.service';
import { DeviceRecordPublisher } from '../device-record-publisher.service';

@Injectable()
export class DeviceRecordDeletedListener {
  constructor(
    private readonly publisher: DeviceRecordPublisher,
    @Logger(DeviceRecordDeletedListener.name) private readonly logger: LoggerService,
  ) {}

  @OnEvent(DeviceLifecycleEvent.SoftDeleted)
  async onSoftDeleted(event: DeviceSoftDeletedEvent): Promise<void> {
    try {
      await this.publisher.delete(event.deviceId);
    } catch (error) {
      this.logger.warn(
        `device_record teardown failed for soft-deleted device ${event.deviceId}: ${getErrorMessage(error)}`,
      );
    }
  }
}
