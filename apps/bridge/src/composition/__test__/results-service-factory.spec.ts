import { describe, expect, it } from 'vitest';

import { resetBullmqConfigForTests } from '../../bullmq/bullmq.config.js';
import type { BullmqQueue } from '../../bullmq/queue.service.js';
import { ResultsService } from '../../bullmq/results.service.js';
import { getLogger } from '../../logger/logger.service.js';
import { ZoneCryptoService } from '../../zone-crypto/zone-crypto.service.js';
import { buildResultsService } from '../results-service-factory.js';

interface AddCall {
  name: string;
  data: Record<string, unknown>;
  opts: unknown;
}

class FakeBullmqQueue implements BullmqQueue {
  readonly added: AddCall[] = [];

  async add(name: string, data: Record<string, unknown>, opts: unknown): Promise<unknown> {
    this.added.push({ name, data, opts });
    return {};
  }

  async remove(): Promise<void> {}

  async getJobState(): Promise<string | null> {
    return null;
  }

  async close(): Promise<void> {
  }
}

class FakeBullmqQueueService {
  readonly queue = new FakeBullmqQueue();

  async getResultsQueue(): Promise<BullmqQueue | null> {
    return this.queue;
  }

  async resetSharedOpsStateOnConnectionError(): Promise<boolean> {
    return true;
  }
}

class FakeRedisService {
  readonly sets: Array<{ key: string; value: string; ttl?: number }> = [];
  readonly deletes: string[] = [];
  readonly store = new Map<string, string>();

  async set(key: string, value: string, ttl?: number): Promise<unknown> {
    this.sets.push({ key, value, ttl });
    this.store.set(key, value);
    return 'OK';
  }

  async delete(key: string): Promise<number> {
    this.deletes.push(key);
    this.store.delete(key);
    return 1;
  }

  async scan(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, '');
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

describe('buildResultsService', () => {
  it('returns a real ResultsService instance whose methods execute end-to-end', () => {
    const queue = new FakeBullmqQueueService();
    const redis = new FakeRedisService();
    const zoneCrypto = new ZoneCryptoService();

    const svc = buildResultsService(
      queue as unknown as Parameters<typeof buildResultsService>[0],
      redis as unknown as Parameters<typeof buildResultsService>[1],
      zoneCrypto,
      getLogger(),
    );

    expect(svc).toBeInstanceOf(ResultsService);
  });

  it('writeCollectorToResultsCache forwards per-field SETs to RedisService', async () => {
    const queue = new FakeBullmqQueueService();
    const redis = new FakeRedisService();
    const zoneCrypto = new ZoneCryptoService();
    const svc = buildResultsService(
      queue as unknown as Parameters<typeof buildResultsService>[0],
      redis as unknown as Parameters<typeof buildResultsService>[1],
      zoneCrypto,
      getLogger(),
    );

    const [ok, kept] = await svc.writeCollectorToResultsCache({
      deviceId: 'dev-1',
      collector: 'hardware',
      data: { cpu: 'x86_64' },
      ttl: 1800,
    });

    expect(ok).toBe(true);
    expect(kept).toBe(1);
    expect(redis.sets).toHaveLength(1);
    expect(redis.sets[0]?.key).toBe('device:dev-1:discovery:cpu');
    expect(redis.sets[0]?.ttl).toBe(1800);
  });

  it('clearCollectionData removes all tracked discovery keys for the device', async () => {
    const queue = new FakeBullmqQueueService();
    const redis = new FakeRedisService();
    const zoneCrypto = new ZoneCryptoService();
    const svc = buildResultsService(
      queue as unknown as Parameters<typeof buildResultsService>[0],
      redis as unknown as Parameters<typeof buildResultsService>[1],
      zoneCrypto,
      getLogger(),
    );

    await svc.writeCollectorToResultsCache({ deviceId: 'dev-2', collector: 'lscpu', data: { cores: 16, threads: 32 } });
    redis.deletes.length = 0;

    const ok = await svc.clearCollectionData('dev-2');
    expect(ok).toBe(true);
    expect(redis.deletes.sort()).toEqual(['device:dev-2:discovery:cores', 'device:dev-2:discovery:threads']);
  });

  it('getCollectionFieldCount returns the tracked field count', async () => {
    const queue = new FakeBullmqQueueService();
    const redis = new FakeRedisService();
    const zoneCrypto = new ZoneCryptoService();
    const svc = buildResultsService(
      queue as unknown as Parameters<typeof buildResultsService>[0],
      redis as unknown as Parameters<typeof buildResultsService>[1],
      zoneCrypto,
      getLogger(),
    );

    await svc.writeCollectorToResultsCache({ deviceId: 'dev-3', collector: 'a', data: { x: 1 } });
    await svc.writeCollectorToResultsCache({ deviceId: 'dev-3', collector: 'b', data: { y: 2 } });

    expect(svc.getCollectionFieldCount('dev-3')).toBe(2);
  });

  it('enqueueDiscoveryComplete sends the tracked field names on the results queue', async () => {
    resetBullmqConfigForTests();
    try {
      const queue = new FakeBullmqQueueService();
      const redis = new FakeRedisService();
      const zoneCrypto = new ZoneCryptoService();
      zoneCrypto.clear();
      const svc = buildResultsService(
        queue as unknown as Parameters<typeof buildResultsService>[0],
        redis as unknown as Parameters<typeof buildResultsService>[1],
        zoneCrypto,
        getLogger(),
      );

      await svc.writeCollectorToResultsCache({
        deviceId: 'dev-4',
        collector: 'lscpu',
        data: { cores: 16, threads: 32 },
      });

      const sent = await svc.enqueueDiscoveryComplete({ deviceId: 'dev-4', jobId: 'job-1' });
      expect(sent).toBe(true);

      expect(queue.queue.added).toHaveLength(1);
      const call = queue.queue.added[0];
      expect(call?.data.device_id).toBe('dev-4');
      expect(((call?.data.fields as string[]) ?? []).sort()).toEqual(['cores', 'threads']);
    } finally {
      resetBullmqConfigForTests();
    }
  });
});
