import { Injectable, Logger, NotFoundException, type OnApplicationShutdown } from '@nestjs/common';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';

import { getErrorMessage } from '../common/errors';
import { labRunLogDir } from '../common/lab-state';
import { isSafeRunId } from '../common/run-id';
import { pastOrphanGrace } from './orphan-grace';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const TRUNCATION_MARKER = '\r\n[... further output truncated ...]\r\n';
const LOG_SUFFIX = '.log';

export interface RunLogAccounting {
  bytes: number;
  truncated: boolean;
}

interface OpenLog extends RunLogAccounting {
  stream: WriteStream;
  max: number;
  failed: boolean;
}

// the unified stream route takes its runId from a hand-rolled @Sse param — no ts-rest, no zod — and
// express decodes %2F, so an escape has to 404 here rather than silently resolve to another file
export function runLogPath(runId: string): string {
  if (!isSafeRunId(runId)) throw new NotFoundException(`no retained log for run '${runId}'`);
  return join(labRunLogDir(), `${runId}${LOG_SUFFIX}`);
}

function unlinkLog(path: string, log: Logger): boolean {
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch (error) {
    log.warn(`run log ${path} could not be removed: ${getErrorMessage(error)}`);
    return false;
  }
}

function maxBytes(): number {
  const configured = Number(process.env.LAB_RUN_LOG_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
}

/** One flat file per run, appended as the run produces output. Deliberately not written once at
 *  finalize: a run that dies mid-flight would otherwise persist nothing at all. */
@Injectable()
export class RunLogStore implements OnApplicationShutdown {
  private readonly log = new Logger(RunLogStore.name);
  private readonly open = new Map<string, OpenLog>();
  private readonly unwritable = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly closing = new Set<Promise<void>>();

  append(runId: string, chunk: string): void {
    // a late chunk would open a second stream with bytes back at 0, growing the file past the
    // log_bytes its row already recorded and restarting the cap
    if (this.finished.has(runId)) return;
    const entry = this.streamFor(runId);
    if (!entry || entry.failed || entry.truncated) return;
    entry.stream.write(chunk);
    entry.bytes += Buffer.byteLength(chunk);
    if (entry.bytes <= entry.max) return;
    entry.truncated = true;
    entry.stream.write(TRUNCATION_MARKER);
    entry.bytes += Buffer.byteLength(TRUNCATION_MARKER);
  }

  finish(runId: string): RunLogAccounting {
    this.unwritable.delete(runId);
    this.finished.add(runId);
    const entry = this.open.get(runId);
    if (!entry) return { bytes: 0, truncated: false };
    this.open.delete(runId);
    this.close(entry.stream);
    // an errored stream left an unknown amount on disk, so it accounts as the open failure it is
    if (entry.failed) return { bytes: 0, truncated: false };
    return { bytes: entry.bytes, truncated: entry.truncated };
  }

  /** `null` when nothing is retained — the run predates the ledger, or retention has evicted its log. */
  read(runId: string): string | null {
    const path = runLogPath(runId);
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    } catch (error) {
      this.log.warn(`run log ${path} could not be read: ${getErrorMessage(error)}`);
      return null;
    }
  }

  /** For a run whose finalize never ran: its row still claims zero bytes, so the byte budget cannot
   *  see — and never reclaims — the log the crashed run did write. */
  size(runId: string): number {
    try {
      const path = runLogPath(runId);
      return existsSync(path) ? statSync(path).size : 0;
    } catch (error) {
      this.log.warn(`run log size for '${runId}' is unavailable: ${getErrorMessage(error)}`);
      return 0;
    }
  }

  /** Called only for a run retention has just deleted, so the file never outlives its row. */
  remove(runId: string): boolean {
    this.finished.delete(runId);
    // a sweep must not throw on one odd row id, so probe the guard rather than letting runLogPath reject
    if (!isSafeRunId(runId)) return false;
    return unlinkLog(runLogPath(runId), this.log);
  }

  /** A log whose run has no row. The reverse orphan — a row whose log is gone — is normal and left alone. */
  removeOrphans(known: ReadonlySet<string>, now: number = Date.now()): number {
    const dir = labRunLogDir();
    if (!existsSync(dir)) return 0;
    let removed = 0;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(LOG_SUFFIX)) continue;
      if (known.has(entry.slice(0, -LOG_SUFFIX.length))) continue;
      const path = join(dir, entry);
      try {
        if (!pastOrphanGrace(path, now)) continue;
      } catch (error) {
        this.log.warn(`run log ${path} could not be stat'd: ${getErrorMessage(error)}`);
        continue;
      }
      if (unlinkLog(path, this.log)) removed += 1;
    }
    return removed;
  }

  // awaited by nest, so the userspace buffer of an in-flight run reaches disk before the process exits
  async onApplicationShutdown(): Promise<void> {
    const flushed = [...this.open.values()].map((entry) => this.close(entry.stream));
    this.open.clear();
    this.unwritable.clear();
    this.finished.clear();
    await Promise.all([...flushed, ...this.closing]);
    this.closing.clear();
  }

  /** end() only queues the flush, and nest re-raises the signal as soon as the shutdown hooks resolve,
   *  so a stream closed at finalize has to stay awaitable or its tail dies with the process. */
  private close(stream: WriteStream): Promise<void> {
    const flushed = new Promise<void>((resolve) => stream.end(() => resolve()));
    this.closing.add(flushed);
    void flushed.then(() => this.closing.delete(flushed));
    return flushed;
  }

  private streamFor(runId: string): OpenLog | undefined {
    const existing = this.open.get(runId);
    if (existing) return existing;
    // remembered so an unwritable state dir warns once per run instead of once per output chunk
    if (this.unwritable.has(runId)) return undefined;
    const path = runLogPath(runId);
    try {
      mkdirSync(labRunLogDir(), { recursive: true });
      const stream = createWriteStream(path, { flags: 'a' });
      const entry: OpenLog = { stream, bytes: 0, truncated: false, failed: false, max: maxBytes() };
      // an unhandled 'error' on a write stream is an uncaught exception, which would take the api down
      stream.on('error', (error) => {
        entry.failed = true;
        this.log.warn(`run log ${path} failed: ${getErrorMessage(error)}`);
      });
      this.open.set(runId, entry);
      return entry;
    } catch (error) {
      this.unwritable.add(runId);
      this.log.warn(`run log ${path} could not be opened: ${getErrorMessage(error)}`);
      return undefined;
    }
  }
}
