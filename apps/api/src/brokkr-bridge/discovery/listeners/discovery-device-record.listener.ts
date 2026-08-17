import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { DeviceRecordPublisher } from '../../device-record/device-record-publisher.service';
import { DiscoveryEvent, type DiscoveryRunCompletedEvent } from '../discovery.events';

// Discovery is where identifier fields (MAC, serial, systemUuid) change, so this is the canonical republish hook; errors swallowed — the bridge renders-on-miss.
@Injectable()
export class DiscoveryDeviceRecordListener {
  constructor(
    private readonly publisher: DeviceRecordPublisher,
    @Logger(DiscoveryDeviceRecordListener.name) private readonly logger: LoggerService,
  ) {}

  @OnEvent(DiscoveryEvent.RunCompleted)
  async onRunCompleted(event: DiscoveryRunCompletedEvent): Promise<void> {
    try {
      const result = await this.publisher.writeForDevice(event.deviceId, { requestId: event.jobId });
      DeviceRecordPublisher.warnIfPublishSkipped(
        this.logger,
        result,
        'discoveryCompletion',
        event.deviceId,
        event.jobId,
      );
    } catch (error) {
      this.logger.warn(
        `device_record publish failed for device ${event.deviceId} (runId=${event.runId}): ${getErrorMessage(error)}`,
        event.jobId,
      );
    }
  }
}
