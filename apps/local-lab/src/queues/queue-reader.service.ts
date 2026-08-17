import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { z } from 'zod';

import { getErrorMessage } from '../common/errors';
import { probe } from '../common/probe';
import type { QueueCounts, QueueRef, QueueSummary } from '../contract';
import { RedisConnectionsService } from '../datastore/redis-connections.service';
import { ZoneRegistryService } from '../datastore/zone-registry.service';
import {
  IN_FLIGHT_LIST_STATES,
  IN_FLIGHT_ZSET_STATES,
  QUEUE_LIST_STATES,
  QUEUE_ZSET_STATES,
  queueKey,
  SAGA_QUEUE_NAMES,
} from './saga-topology';

const SCAN_COUNT = 200;

const COUNTED_STATES = [...QUEUE_LIST_STATES, ...QUEUE_ZSET_STATES];

const ScanReplySchema = z.tuple([z.string(), z.array(z.string())]);

const Count = z.coerce.number().int().nonnegative().catch(0);

const JobCountsReplySchema = z.object({
  wait: Count,
  active: Count,
  paused: Count,
  delayed: Count,
  prioritized: Count,
  'waiting-children': Count,
  completed: Count,
  failed: Count,
});

const WorkersReplySchema = z.array(z.unknown()).catch([]);

export interface ScanResult {
  keys: string[];
  truncated: boolean;
}

function zeroCounts(): QueueCounts {
  return JobCountsReplySchema.parse({});
}

function displayInFlight(counts: QueueCounts): number {
  let total = 0;
  for (const state of IN_FLIGHT_LIST_STATES) total += counts[state];
  for (const state of IN_FLIGHT_ZSET_STATES) total += counts[state];
  return total;
}

@Injectable()
export class QueueReaderService implements OnModuleDestroy {
  private readonly queues = new Map<string, Promise<Queue | null>>();
  private readonly log = new Logger(QueueReaderService.name);

  constructor(
    private readonly zoneRegistry: ZoneRegistryService,
    private readonly connections: RedisConnectionsService,
  ) {}

  private get(): Redis {
    return this.connections.client('view');
  }

  async onModuleDestroy(): Promise<void> {
    const pending = [...this.queues.values()];
    this.queues.clear();
    const open = await Promise.all(pending.map((entry) => entry.catch(() => null)));
    await Promise.all(
      open.map((queue) =>
        queue?.close().catch((error) => this.log.debug(`queue close failed: ${getErrorMessage(error)}`)),
      ),
    );
  }

  async scanKeys(match: string, cap = Number.POSITIVE_INFINITY): Promise<ScanResult> {
    const client = this.get();
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = ScanReplySchema.parse(await client.scan(cursor, 'MATCH', match, 'COUNT', SCAN_COUNT));
      cursor = next;
      for (const key of keys) {
        if (found.length >= cap) return { keys: found, truncated: true };
        found.push(key);
      }
    } while (cursor !== '0');
    return { keys: found, truncated: false };
  }

  async scanMetaKeys(match: string): Promise<string[]> {
    return (await this.scanKeys(match)).keys;
  }

  // the only route to a Queue outside this service, so the meta gate and the open-cache still hold:
  // null means the gate found no such queue, never that the callback returned nothing.
  async withQueue<T>(ref: QueueRef, fn: (queue: Queue) => Promise<T>): Promise<T | null> {
    const queue = await this.queueFor(ref);
    return queue ? fn(queue) : null;
  }

  async queueExists(prefix: string, name: string): Promise<boolean> {
    return (await this.get().exists(queueKey(prefix, name, 'meta'))) === 1;
  }

  async counts(ref: QueueRef): Promise<QueueCounts> {
    const queue = await this.queueFor(ref);
    if (!queue) return zeroCounts();
    return JobCountsReplySchema.parse(await queue.getJobCounts(...COUNTED_STATES));
  }

  async stalledCount(ref: QueueRef): Promise<number> {
    return Count.parse(await this.get().scard(queueKey(ref.prefix, ref.name, 'stalled')));
  }

  async paused(ref: QueueRef): Promise<boolean> {
    const queue = await this.queueFor(ref);
    return queue ? queue.isPaused() : false;
  }

  async workerCount(ref: QueueRef): Promise<number> {
    const queue = await this.queueFor(ref);
    if (!queue) return 0;
    return WorkersReplySchema.parse(await queue.getWorkers()).length;
  }

  async summary(ref: QueueRef): Promise<QueueSummary> {
    const zeros = { ...ref, counts: zeroCounts(), stalled: 0, inFlight: 0 };
    try {
      // an absent queue reads as a real zero on every field; only a failed read carries readError.
      if (!(await this.queueFor(ref))) return { ...zeros, paused: false, workers: 0, readError: null };
      // paused/workers are auxiliary probes and degrade to null on their own, so a CLIENT LIST hiccup
      // never discards counts that were read.
      const [counts, stalled, paused, workers] = await Promise.all([
        this.counts(ref),
        this.stalledCount(ref),
        this.probe(ref, 'paused', () => this.paused(ref)),
        this.probe(ref, 'workers', () => this.workerCount(ref)),
      ]);
      return { ...ref, counts, stalled, paused, workers, inFlight: displayInFlight(counts), readError: null };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`queue read failed for ${ref.prefix}:${ref.name}: ${readError}`);
      return { ...zeros, paused: null, workers: null, readError };
    }
  }

  private probe<T>(ref: QueueRef, label: string, read: () => Promise<T>): Promise<T | null> {
    return probe(read, (message) =>
      this.log.debug(`queue ${label} probe failed for ${ref.prefix}:${ref.name}: ${message}`),
    );
  }

  /** The fleet-mode-flip guard: a positive total blocks the flip, so an under-count strands in-flight sagas. */
  async inFlightCount(): Promise<number> {
    const zoneIds = await this.zoneRegistry.listZoneIds();
    if (zoneIds.length === 0) return 0;

    // deliberately blind LLEN/ZCARD, not getJobCounts: bullmq's wait/paused job types do not match a raw
    // read of those lists, and a Queue would gate on the meta key — either way risks the under-count.
    let r: Redis | null = null;
    try {
      // the guard must always count the bridge's redis, where sagas actually live — never wherever the
      // datastore view happens to be pointed, or a mid-saga mode flip proceeds on someone else's counts.
      const url = this.connections.url('bridge');
      r = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2, connectTimeout: 5_000 });
      r.on('error', (error) => this.log.debug(`saga guard redis error: ${getErrorMessage(error)}`));
      const pipe = r.multi();
      for (const zoneId of zoneIds) {
        for (const queue of SAGA_QUEUE_NAMES) {
          for (const state of IN_FLIGHT_LIST_STATES) pipe.llen(queueKey(zoneId, queue, state));
          for (const state of IN_FLIGHT_ZSET_STATES) pipe.zcard(queueKey(zoneId, queue, state));
        }
      }
      const results = await pipe.exec();
      if (!results) return 0;
      let total = 0;
      for (const entry of results) {
        if (!entry) continue;
        const [err, reply] = entry;
        if (err) continue;
        const n = typeof reply === 'number' ? reply : Number(reply);
        if (Number.isFinite(n) && n > 0) total += n;
      }
      return total;
    } finally {
      r?.disconnect();
    }
  }

  // caches the in-flight open, not just the result: two concurrent reads of one ref must not each
  // build a Queue, or the loser is overwritten in the map and its connection never gets closed.
  private queueFor(ref: QueueRef): Promise<Queue | null> {
    const cacheKey = `${ref.prefix}:${ref.name}`;
    const cached = this.queues.get(cacheKey);
    if (cached) return cached;
    const opening = this.open(ref).then(
      (queue) => {
        // an absent queue is never cached, so one created later is still picked up
        if (!queue) this.queues.delete(cacheKey);
        return queue;
      },
      (error) => {
        this.queues.delete(cacheKey);
        throw error;
      },
    );
    this.queues.set(cacheKey, opening);
    return opening;
  }

  private async open(ref: QueueRef): Promise<Queue | null> {
    // constructing a Queue upserts its meta key, so only ever build one Redis already knows about.
    if (!(await this.queueExists(ref.prefix, ref.name))) return null;
    // bullmq pins its own ioredis copy, so it gets connection options rather than the shared client.
    return new Queue(ref.name, {
      connection: { url: this.connections.url('view'), maxRetriesPerRequest: 2, connectTimeout: 5_000 },
      prefix: ref.prefix,
      skipMetasUpdate: true,
    });
  }
}
