import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage } from '../../common/error-utils';

import { dispatchMetaKey, partialKey, progressKey, resultChannel, resultKey } from './result-publisher.keys';

const RESULT_TTL_S = 24 * 60 * 60;
const PROGRESS_TTL_S = 60 * 60;
const PARTIAL_TTL_S = 24 * 60 * 60;
const DISPATCH_META_MIN_TTL_S = 60;
const PUBSUB_CLEANUP_TIMEOUT_MS = 5_000;

export interface DispatchMeta {
  device_id: string;
  operation: string;
  input_hash?: string;
}

export type ProgressSnapshot = Record<string, string>;

export interface RedisPipeline {
  set(key: string, value: string | Buffer, exSeconds: number): RedisPipeline;
  publish(channel: string, message: string): RedisPipeline;
  hset(key: string, fields: Record<string, string>): RedisPipeline;
  expire(key: string, seconds: number): RedisPipeline;
  rpush(key: string, value: string | Buffer): RedisPipeline;
  exec(): Promise<unknown[]>;
}

export interface ResultPubSubMessage {
  data: string | Buffer | null | undefined;
}

export const RESULT_PUBSUB_TIMEOUT = Symbol('result-pubsub-timeout');
export type ResultPubSubTimeout = typeof RESULT_PUBSUB_TIMEOUT;

export interface ResultPubSub {
  subscribe(channel: string): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
  /** innerTimeoutMs caps a single poll (elapsing returns null); outerTimeoutMs is the overall deadline — a hang past it returns RESULT_PUBSUB_TIMEOUT, on which the caller re-checks the result key. */
  getMessage(innerTimeoutMs: number, outerTimeoutMs: number): Promise<ResultPubSubMessage | null | ResultPubSubTimeout>;
}

export interface ResultPublisherRedis {
  set(key: string, value: string | Buffer, exSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | Buffer | null>;
  del(key: string): Promise<unknown>;
  hgetall(key: string): Promise<ProgressSnapshot>;
  pipeline(): RedisPipeline;
  subscribePubSub(): ResultPubSub;
}

@Injectable()
export class ResultPublisherService {
  private readonly logger = new Logger(ResultPublisherService.name);
  private readonly resultChannelKey: string;

  constructor(
    private readonly redis: ResultPublisherRedis,
    private readonly zonePrefix: string = '',
  ) {
    this.resultChannelKey = resultChannel(zonePrefix);
  }

  private resultKey(workId: string): string {
    return resultKey(this.zonePrefix, workId);
  }

  private progressKey(workId: string): string {
    return progressKey(this.zonePrefix, workId);
  }

  private partialKey(workId: string): string {
    return partialKey(this.zonePrefix, workId);
  }

  private dispatchMetaKey(workId: string): string {
    return dispatchMetaKey(this.zonePrefix, workId);
  }

  async publishDispatchMeta(args: {
    workId: string;
    deviceId: string;
    operation: string;
    ttl: number;
    inputHash?: string;
  }): Promise<void> {
    const meta: DispatchMeta = {
      device_id: String(args.deviceId),
      operation: args.operation,
    };
    if (args.inputHash !== undefined) meta.input_hash = args.inputHash;
    const ex = Math.max(args.ttl, DISPATCH_META_MIN_TTL_S);
    await this.redis.set(this.dispatchMetaKey(args.workId), JSON.stringify(meta), ex);
  }

  async getDispatchMeta(workId: string): Promise<DispatchMeta | null> {
    const raw = await this.redis.get(this.dispatchMetaKey(workId));
    if (raw === null) return null;
    const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
    try {
      return JSON.parse(text) as DispatchMeta;
    } catch {
      return null;
    }
  }

  async tryGetTerminalResult(workId: string): Promise<Buffer | null> {
    const raw = await this.redis.get(this.resultKey(workId));
    return toBuffer(raw);
  }

  async deleteTerminalResult(workId: string): Promise<void> {
    await this.redis.del(this.resultKey(workId));
  }

  async publishResult(workId: string, responseBytes: Buffer): Promise<void> {
    const key = this.resultKey(workId);
    await this.redis.pipeline().set(key, responseBytes, RESULT_TTL_S).publish(this.resultChannelKey, workId).exec();
  }

  async publishProgress(workId: string, progress: number, message: string): Promise<void> {
    const key = this.progressKey(workId);
    await this.redis
      .pipeline()
      .hset(key, { progress: String(progress), message, _ts: String(Date.now() / 1000) })
      .expire(key, PROGRESS_TTL_S)
      .exec();
  }

  async getProgress(workId: string): Promise<ProgressSnapshot | null> {
    const snapshot = await this.redis.hgetall(this.progressKey(workId));
    return Object.keys(snapshot).length === 0 ? null : snapshot;
  }

  async publishPartial(workId: string, partialBytes: Buffer): Promise<void> {
    const key = this.partialKey(workId);
    await this.redis.pipeline().rpush(key, partialBytes).expire(key, PARTIAL_TTL_S).exec();
  }

  async awaitResult(workId: string, timeoutMs: number): Promise<Buffer> {
    const key = this.resultKey(workId);
    const pubsub = this.redis.subscribePubSub();
    try {
      await pubsub.subscribe(this.resultChannelKey);

      const existing = await this.redis.get(key);
      const buf = toBuffer(existing);
      if (buf !== null) return buf;

      const deadline = performance.now() + timeoutMs;
      while (true) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new ResultPublisherTimeoutError(`await_result(${workId}) deadline exceeded`);
        }
        const msg = await pubsub.getMessage(Math.min(remaining, 1_000), remaining);
        if (msg === null || msg === RESULT_PUBSUB_TIMEOUT) {
          const recheck = await this.redis.get(key);
          const recheckBuf = toBuffer(recheck);
          if (recheckBuf !== null) return recheckBuf;
          continue;
        }
        const data = msg.data;
        if (data === null || data === undefined) continue;
        const decoded = typeof data === 'string' ? data : data.toString('utf-8');
        if (decoded === workId) {
          const found = await this.redis.get(key);
          const foundBuf = toBuffer(found);
          if (foundBuf !== null) return foundBuf;
          this.logger.warn(`awaitResult saw pubsub notification for ${workId} but key missing; continuing to wait`);
        }
      }
    } finally {
      await this.cleanupPubSub(pubsub, workId);
    }
  }

  private async cleanupPubSub(pubsub: ResultPubSub, workId: string): Promise<void> {
    try {
      await withTimeout(
        (async () => {
          await pubsub.unsubscribe(this.resultChannelKey);
          await pubsub.close();
        })(),
        PUBSUB_CLEANUP_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof ResultPublisherTimeoutError) {
        this.logger.warn(`pubsub cleanup timed out for workId=${workId}; leaking connection`);
      } else {
        this.logger.debug(`pubsub cleanup failed (ignored): ${getErrorMessage(error)}`);
      }
    }
  }
}

export class ResultPublisherTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultPublisherTimeoutError';
  }
}

function toBuffer(value: string | Buffer | null | undefined): Buffer | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value, 'utf-8');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ResultPublisherTimeoutError(`operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
