import { Global, Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';

import { NIL_JOB_ID } from '../../constants';
import { logWarning } from '../../logger/logger.service';
import { getErrorMessage } from '../error-utils';

import { BUFFER_REDIS, buildBufferRedisAdapter, RedisBufferAdapter } from './redis-buffer-adapter';

const bufferRedisProvider: Provider = {
  provide: BUFFER_REDIS,
  useFactory: () => buildBufferRedisAdapter(),
};

// import EARLY in AppModule: Nest tears down in reverse init order, so this must outlive
// ResultPublisherService, whose awaitResult subscribes on this connection.
@Global()
@Module({
  providers: [bufferRedisProvider],
  exports: [BUFFER_REDIS],
})
export class BufferRedisModule implements OnApplicationShutdown {
  constructor(@Inject(BUFFER_REDIS) private readonly buffer: RedisBufferAdapter) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.buffer.close();
    } catch (error) {
      void logWarning(`Buffer Redis close failed during shutdown: ${getErrorMessage(error)}`, { jobId: NIL_JOB_ID });
    }
  }
}
