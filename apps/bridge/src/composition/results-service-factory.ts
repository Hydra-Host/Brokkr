import { getBullmqConfig } from '../bullmq/bullmq.config.js';
import { BullmqQueueService } from '../bullmq/queue.service.js';
import {
  ResultsService,
  type ResultsQueue,
  type ResultsQueueProvider,
  type ResultsRedisClient,
  type ResultsRedisProvider,
} from '../bullmq/results.service.js';
import { RedisService } from '../common/redis/redis.service.js';
import { ContextLogger } from '../logger/logger.service.js';
import { ZoneCryptoService } from '../zone-crypto/zone-crypto.service.js';

export function buildResultsQueueProviderForResults(queueService: BullmqQueueService): ResultsQueueProvider {
  return {
    async getResultsQueue(): Promise<ResultsQueue | null> {
      const queue = await queueService.getResultsQueue();
      if (queue === null) return null;
      return {
        name: getBullmqConfig().resultsQueueName,
        add: (name, data, opts) =>
          queue.add(name, data as Record<string, unknown>, opts as unknown as Parameters<typeof queue.add>[2]),
      };
    },
    resetSharedOpsStateOnConnectionError: (exc) => queueService.resetSharedOpsStateOnConnectionError(exc),
  };
}

export function buildResultsRedisProviderForResults(
  redis: RedisService,
  queueService: BullmqQueueService,
): ResultsRedisProvider {
  const client: ResultsRedisClient = {
    get(key) {
      return redis.get(key);
    },
    async set(key, value, ttl) {
      await redis.set(key, value, ttl);
    },
    async delete(keys) {
      for (const key of keys) {
        await redis.delete(key);
      }
    },
    async scan(pattern) {
      return redis.scan(pattern);
    },
  };
  return {
    getResultsRedis: async () => client,
    // BullmqQueueService owns the shared ops client, so a drop on the results-cache path must reset through it.
    resetSharedOpsStateOnConnectionError: (exc) => queueService.resetSharedOpsStateOnConnectionError(exc),
  };
}

export function buildResultsService(
  queueService: BullmqQueueService,
  redis: RedisService,
  zoneCrypto: ZoneCryptoService,
  logger: ContextLogger,
  env: NodeJS.ProcessEnv = process.env,
): ResultsService {
  return new ResultsService(
    buildResultsQueueProviderForResults(queueService),
    buildResultsRedisProviderForResults(redis, queueService),
    { get: () => zoneCrypto.get() },
    { getZoneId: () => (env.BROKKR_ZONE_ID ?? '').trim() },
    logger,
  );
}
