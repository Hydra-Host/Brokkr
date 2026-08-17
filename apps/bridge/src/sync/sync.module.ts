import { Module, type OnModuleInit } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service';
import { ContextLogger } from '../logger/logger.service';
import { registerSagaDef } from '../saga-framework/saga-registry';

import type { SyncVersionCache } from './discovery-sync';
import { SyncStep } from './steps/sync.step';
import { buildSyncSaga } from './sync.workflow';

const syncVersionCacheAdapter = (redis: RedisService): SyncVersionCache => ({
  get: (key, jobId) => redis.get(key, jobId),
  set: async (key, value, ttl, jobId) => {
    await redis.set(key, value, ttl ?? undefined, jobId);
    return true;
  },
  delete: (key, jobId) => redis.delete(key, jobId),
});

@Module({
  providers: [
    {
      provide: SyncStep,
      useFactory: (redis: RedisService, logger: ContextLogger) => new SyncStep(syncVersionCacheAdapter(redis), logger),
      inject: [RedisService, ContextLogger],
    },
  ],
  exports: [SyncStep],
})
export class SyncModule implements OnModuleInit {
  constructor(private readonly sync: SyncStep) {}

  onModuleInit(): void {
    registerSagaDef(buildSyncSaga({ sync: this.sync }));
  }
}
