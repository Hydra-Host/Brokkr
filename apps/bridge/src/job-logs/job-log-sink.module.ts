import { Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import { getErrorMessage } from '../common/error-utils.js';
import { RedisModule } from '../common/redis/redis.module.js';
import { RedisService } from '../common/redis/redis.service.js';
import { setJobLogSink } from '../logger/job-log-sink-registry.js';
import { logWarning } from '../logger/logger.service.js';

import { JobLogStreamSink } from './job-log-stream-sink.js';

@Module({ imports: [RedisModule] })
export class JobLogSinkModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private sink: JobLogStreamSink | null = null;

  constructor(private readonly redis: RedisService) {}

  onApplicationBootstrap(): void {
    this.sink = new JobLogStreamSink(this.redis);
    this.sink.start();
    setJobLogSink(this.sink);
  }

  async onApplicationShutdown(): Promise<void> {
    setJobLogSink(null);
    try {
      await this.sink?.stop();
    } catch (error) {
      void logWarning(`Job log sink stop failed during shutdown: ${getErrorMessage(error)}`);
    }
  }
}
