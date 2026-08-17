import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { BenchmarkService } from '../../benchmarks/benchmarks.service';
import { DiscoveryEvent, type DiscoveryRunCompletedEvent } from '../discovery.events';

@Injectable()
export class DiscoveryBenchmarksListener {
  constructor(
    private readonly benchmarkService: BenchmarkService,
    @Logger(DiscoveryBenchmarksListener.name) private readonly logger: LoggerService,
  ) {}

  @OnEvent(DiscoveryEvent.RunCompleted)
  async onRunCompleted(event: DiscoveryRunCompletedEvent): Promise<void> {
    try {
      await this.benchmarkService.runBenchmarks(event.deviceId);
    } catch (error) {
      this.logger.error(
        `Benchmark scheduling failed for device ${event.deviceId} (runId=${event.runId}): ${getErrorMessage(error)}`,
        undefined,
        event.jobId,
      );
    }
  }
}
