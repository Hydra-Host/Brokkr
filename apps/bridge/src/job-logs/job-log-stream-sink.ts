import { getErrorMessage } from '../common/error-utils';
import { jobLogs } from '../common/redis/redis-keys';
import type { JobLogSinkPort } from '../logger/job-log-sink-registry';
import { logWarning } from '../logger/logger.service';

export const JOB_LOG_TTL_SECONDS = 2_592_000;
export const JOB_LOG_MAX_STREAM_ENTRIES = 10_000;

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 50;
const MAX_BUFFERED_ENTRIES = 10_000;

export interface JobLogRedis {
  xadd(key: string, fields: Record<string, string>, maxlen?: number, jobId?: string): Promise<unknown>;
  expire(key: string, seconds: number, jobId?: string): Promise<boolean>;
}

export class JobLogStreamSink implements JobLogSinkPort {
  private buffer = new Map<string, Record<string, string>[]>();
  private total = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly redis: JobLogRedis) {}

  enqueue(jobId: string, fields: Record<string, string>): void {
    const entries = this.buffer.get(jobId);
    if (entries) {
      entries.push(fields);
    } else {
      this.buffer.set(jobId, [fields]);
    }
    this.total += 1;
    if (this.total >= MAX_BUFFERED_ENTRIES) {
      this.dropOldest();
    }
    if (this.total >= FLUSH_BATCH_SIZE) {
      void this.flush();
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.inFlight !== null || this.total > 0) {
      await (this.inFlight ?? this.flush());
    }
  }

  async flush(): Promise<void> {
    if (this.inFlight !== null || this.total === 0) return;
    const batches = this.buffer;
    this.buffer = new Map();
    this.total = 0;
    this.inFlight = this.write(batches);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async write(batches: Map<string, Record<string, string>[]>): Promise<void> {
    for (const [jobId, entries] of batches) {
      try {
        const key = jobLogs(jobId);
        for (const fields of entries) {
          await this.redis.xadd(key, fields, JOB_LOG_MAX_STREAM_ENTRIES);
        }
        await this.redis.expire(key, JOB_LOG_TTL_SECONDS);
      } catch (error) {
        void logWarning(`Failed to flush job logs to Redis: ${getErrorMessage(error)}`);
      }
    }
  }

  private dropOldest(): void {
    const oldest = this.buffer.entries().next();
    if (oldest.done) return;
    const [jobId, entries] = oldest.value;
    entries.shift();
    this.total -= 1;
    if (entries.length === 0) {
      this.buffer.delete(jobId);
    }
  }
}
