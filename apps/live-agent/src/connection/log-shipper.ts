import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';

import { getErrorMessage } from '../errors';
import { LogBatchSchema, LogEntrySchema } from '../gen/brokkr/agent/v1/agent_pb';
import { setLogSink, type BufferedEntry } from '../logger';
import { hashDeviceId } from './hash';
import type { TransportPool } from './pool';

const CHUNK_SIZE = 900;

function buildDropWarningMessage(overflowDrops: number, reDrops: number, maxBuffer: number): string {
  const reasons: string[] = [];
  if (overflowDrops > 0) reasons.push(`${overflowDrops} from buffer overflow (cap=${maxBuffer}, raise maxBufferSize)`);
  if (reDrops > 0) reasons.push(`${reDrops} from ReportLogs RESOURCE_EXHAUSTED (bridge-side cap)`);
  return `log-shipper dropped ${overflowDrops + reDrops} entries since last delivered drop-warning: ${reasons.join('; ')}`;
}

export interface LogShipperOptions {
  deviceId: string;
  pool: TransportPool;
  flushIntervalMs?: number;
  maxBufferSize?: number;
}

export class LogShipper {
  private buffer: BufferedEntry[] = [];
  private head = 0;
  private readonly max: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private stopped = false;
  private droppedSinceLastFlush = 0;
  private reDropsSinceLastFlush = 0;
  private evictionsDuringFlush = 0;
  private warnFlushScheduled = false;

  constructor(private readonly opts: LogShipperOptions) {
    this.max = opts.maxBufferSize ?? 10_000;
    this.intervalMs = opts.flushIntervalMs ?? 2000;
  }

  start(): void {
    setLogSink((entry) => this.push(entry));
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    setLogSink(null);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private get liveCount(): number {
    return this.buffer.length - this.head;
  }

  private push(entry: BufferedEntry): void {
    if (this.liveCount >= this.max) {
      this.head += 1;
      if (this.flushing) {
        this.evictionsDuringFlush += 1;
      } else {
        this.droppedSinceLastFlush += 1;
      }
      if (this.head >= this.max) {
        this.buffer.splice(0, this.head);
        this.head = 0;
      }
    }
    this.buffer.push(entry);
    if (entry.log_level === 'warn' || entry.log_level === 'error') {
      this.scheduleWarnFlush();
    }
  }

  private scheduleWarnFlush(): void {
    if (this.warnFlushScheduled) return;
    this.warnFlushScheduled = true;
    setImmediate(() => {
      this.warnFlushScheduled = false;
      this.flush().catch((err) => {
        process.stderr.write(`[log-shipper] flush after warn failed: ${getErrorMessage(err)}\n`);
      });
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        await this.flush();
      } catch (err) {
        process.stderr.write(`[log-shipper] scheduled flush failed: ${getErrorMessage(err)}\n`);
      } finally {
        this.schedule();
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.flushing) return;
    if (this.liveCount === 0 && this.droppedSinceLastFlush === 0 && this.reDropsSinceLastFlush === 0) return;
    const addresses = [...this.opts.pool.listAddresses()].sort();
    if (addresses.length === 0) return;

    const startIdx = hashDeviceId(this.opts.deviceId) % addresses.length;

    try {
      this.flushing = true;
      const batchSize = this.liveCount;
      const snapshotEntries = this.buffer.slice(this.head, this.head + batchSize);

      const overflowDropsThisFlush = this.droppedSinceLastFlush;
      const reDropsThisFlush = this.reDropsSinceLastFlush;
      const totalDropsThisFlush = overflowDropsThisFlush + reDropsThisFlush;
      const dropWarningEntry =
        totalDropsThisFlush > 0
          ? create(LogEntrySchema, {
              timestamp: timestampFromDate(new Date()),
              level: 'warn',
              message: buildDropWarningMessage(overflowDropsThisFlush, reDropsThisFlush, this.max),
              fieldsJson: JSON.stringify({ app_class_name: 'log-shipper', job_id: '', work_id: '' }),
            })
          : null;

      type ChunkStatus = 'pending' | 'shipped' | 'dropped';
      interface Chunk {
        buffered: BufferedEntry[];
        hasDropWarning: boolean;
        status: ChunkStatus;
      }
      const chunks: Chunk[] = [];
      for (let i = 0; i < snapshotEntries.length; i += CHUNK_SIZE) {
        chunks.push({
          buffered: snapshotEntries.slice(i, i + CHUNK_SIZE),
          hasDropWarning: false,
          status: 'pending',
        });
      }
      if (dropWarningEntry !== null) {
        if (chunks.length === 0) {
          chunks.push({ buffered: [], hasDropWarning: true, status: 'pending' });
        } else {
          const last = chunks[chunks.length - 1]!;
          if (last.buffered.length < CHUNK_SIZE) {
            last.hasDropWarning = true;
          } else {
            chunks.push({ buffered: [], hasDropWarning: true, status: 'pending' });
          }
        }
      }

      const shipped: BufferedEntry[] = [];
      let unrecoverableDrops = 0;
      let chunkIdx = 0;

      for (let i = 0; i < addresses.length && chunkIdx < chunks.length; i++) {
        const address = addresses[(startIdx + i) % addresses.length]!;
        let bridgeAlive = true;
        while (bridgeAlive && chunkIdx < chunks.length) {
          const chunk = chunks[chunkIdx]!;
          const chunkPayloadEntries = chunk.buffered.map((e) =>
            create(LogEntrySchema, {
              timestamp: timestampFromDate(new Date(e.timestamp)),
              level: e.log_level,
              message: e.message,
              fieldsJson: JSON.stringify({
                app_class_name: e.app_class_name,
                job_id: e.job_id,
                ...(e.work_id ? { work_id: e.work_id } : {}),
                ...(e.trace_id ? { trace_id: e.trace_id } : {}),
                ...(e.span_id ? { span_id: e.span_id } : {}),
              }),
            }),
          );
          if (chunk.hasDropWarning && dropWarningEntry !== null) {
            chunkPayloadEntries.push(dropWarningEntry);
          }
          const payload = create(LogBatchSchema, {
            deviceId: this.opts.deviceId,
            entries: chunkPayloadEntries,
          });
          try {
            await this.opts.pool.getClient(address).reportLogs(payload);
            chunk.status = 'shipped';
            shipped.push(...chunk.buffered);
            chunkIdx++;
          } catch (err) {
            if (err instanceof ConnectError && err.code === Code.ResourceExhausted) {
              chunk.status = 'dropped';
              unrecoverableDrops += chunk.buffered.length;
              shipped.push(...chunk.buffered);
              chunkIdx++;
              continue;
            }
            bridgeAlive = false;
          }
        }
      }

      if (shipped.length > 0) {
        const shippedSet = new Set(shipped);
        this.buffer = this.buffer.filter((e, idx) => idx >= this.head && !shippedSet.has(e));
        this.head = 0;
      }

      const postSnapshotDrops = Math.max(0, this.evictionsDuringFlush - shipped.length);
      this.evictionsDuringFlush = 0;
      // Warning-only chunk RE'd means bridge cap=0; clear counters to avoid livelock.
      const warningOnlyDroppedByRE =
        chunks.length === 1 &&
        chunks[0]!.buffered.length === 0 &&
        chunks[0]!.hasDropWarning &&
        chunks[0]!.status === 'dropped';
      const dropWarningReported =
        totalDropsThisFlush > 0 &&
        (chunks.some((c) => c.hasDropWarning && c.status === 'shipped') || warningOnlyDroppedByRE);
      if (dropWarningReported) {
        this.droppedSinceLastFlush -= overflowDropsThisFlush;
        this.reDropsSinceLastFlush -= reDropsThisFlush;
      }
      this.droppedSinceLastFlush += postSnapshotDrops;
      this.reDropsSinceLastFlush += unrecoverableDrops;

      const allChunksHandled = chunkIdx === chunks.length;
      if (allChunksHandled) {
        if (unrecoverableDrops > 0) {
          process.stderr.write(
            `[log-shipper] dropped ${unrecoverableDrops} entries due to bridge RESOURCE_EXHAUSTED\n`,
          );
        }
        return;
      }
      process.stderr.write(
        `[log-shipper] partial ReportLogs flush: shipped ${chunkIdx}/${chunks.length} chunks ` +
          `(retained ${chunks.length - chunkIdx} for next attempt; tried ${addresses.length} bridges)\n`,
      );
    } finally {
      this.flushing = false;
    }
  }
}
