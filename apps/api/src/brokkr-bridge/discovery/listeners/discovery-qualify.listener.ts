import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { QualifyOrchestrationService } from '../../lifecycle/qualify-orchestration.service';
import type { StorageLayoutData } from '../../types/discovery-processors.types';
import { DiscoveryEvent, type DiscoveryRunCompletedEvent, type DiscoveryRunFailedEvent } from '../discovery.events';

@Injectable()
export class DiscoveryQualifyListener {
  constructor(
    private readonly qualify: QualifyOrchestrationService,
    @Logger(DiscoveryQualifyListener.name) private readonly logger: LoggerService,
  ) {}

  @OnEvent(DiscoveryEvent.RunCompleted)
  async onRunCompleted(event: DiscoveryRunCompletedEvent): Promise<void> {
    try {
      await this.qualify.handleDiscoveryCompleteForCommission(
        event.deviceId,
        event.zonePrefix,
        event.jobId,
        event.storageLayouts as StorageLayoutData | null,
      );
    } catch (error) {
      this.logger.error(
        `Qualify trigger failed for device ${event.deviceId} (runId=${event.runId}): ${getErrorMessage(error)}`,
        undefined,
        event.jobId,
      );
    }
  }

  @OnEvent(DiscoveryEvent.RunFailed)
  async onRunFailed(event: DiscoveryRunFailedEvent): Promise<void> {
    try {
      await this.qualify.handleDiscoveryRunFailure(
        event.deviceId,
        `Discovery processing failed in phase=${event.phase}: ${event.error}`,
      );
    } catch (error) {
      this.logger.error(
        `Qualify failure hook errored for device ${event.deviceId} (runId=${event.runId}): ${getErrorMessage(error)}`,
        undefined,
        event.jobId,
      );
    }
  }
}
