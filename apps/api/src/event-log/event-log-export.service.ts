import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EVENT_LOG_CSV_COLUMNS,
  EventLogExportQuerySchema,
  type EventLogCursorExpired,
  type EventLogEntry,
  type EventLogExportPage,
  type EventLogExportQuery,
} from '@repo/api-client';
import { csvRow } from '@repo/utils';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { z } from 'zod';
import {
  CursorFormatError,
  advanceCursor,
  cursorAt,
  decodeCursor,
  encodeCursor,
  isCursorExpired,
  type CursorState,
  type EventKey,
} from './event-log-cursor';
import { resolveRetentionDays } from './event-log-retention.cron';
import { toEventLogFilter, type EventLogFilter } from './event-log.filters';
import { EventLogRepository } from './event-log.repository';
import { EventLogService } from './event-log.service';

export const CSV_ROW_LIMIT = 50_000;

/** The overlap an incremental pull re-scans so a row committing out of `createdAt` order is still
 *  delivered. Not a limit on visible history — that is retention (EVENT_LOG_RETENTION_DAYS). */
export const LOOKBACK_MS = 60 * 60 * 1000;

export const CSV_TRAILER_PREFIX = '#';

const CSV_FETCH_BATCH = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** No lower bound: a CSV download is the filtered slice a human is looking at, not a tail follow. */
const BEGINNING: EventKey = { createdAt: new Date(0), id: '' };

/** Narrow port over the HTTP response, so the streaming path never reaches for Express types. */
export interface EventLogExportSink {
  readonly headersSent: boolean;
  readonly destroyed: boolean;
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
  write(chunk: string): boolean;
  drain(): Promise<void>;
  end(): unknown;
  destroy(error?: Error): unknown;
}

@Injectable()
export class EventLogExportService {
  private readonly retentionDays: number;

  constructor(
    private readonly repository: EventLogRepository,
    private readonly eventLog: EventLogService,
    private readonly contextService: ContextService,
    configService: ConfigService,
    @Logger(EventLogExportService.name) private readonly logger: LoggerService,
  ) {
    this.retentionDays = resolveRetentionDays(configService);
  }

  /** Owns the whole response because `@Res()` bypasses the global exception filters: an error escaping
   *  here would leave a truncated 200 that reads as a complete file. */
  async export(rawQuery: unknown, sink: EventLogExportSink): Promise<void> {
    try {
      const query = EventLogExportQuerySchema.parse(rawQuery);
      if (query.format === 'csv') {
        await this.streamCsv(query, sink);
        return;
      }

      const page = await this.exportPage(query);
      sink.status(HttpStatus.OK);
      sink.json(page);
    } catch (error) {
      this.failResponse(error, sink);
    }
  }

  private async exportPage(query: EventLogExportQuery): Promise<EventLogExportPage> {
    const filter = this.authorizedFilter(query);
    const state = await this.openCursor(query, filter.organizationId);

    const data = await this.repository.findAfterKey(filter, state.scanAfter, query.pageSize);
    const pageWasFull = data.length === query.pageSize;
    const next = advanceCursor(state, lastKeyOf(data), pageWasFull, LOOKBACK_MS);

    return { data, cursor: encodeCursor(next), hasMore: pageWasFull };
  }

  private async streamCsv(query: EventLogExportQuery, sink: EventLogExportSink): Promise<void> {
    const filter = this.authorizedFilter(query);
    const start = query.cursor ? (await this.openCursor(query, filter.organizationId)).scanAfter : BEGINNING;

    // Before the probe, not merely before the first byte: a disclosure that failed halfway still
    // happened, and the export records itself, so probing first would undercount by that row.
    await this.eventLog.recordExport();
    const truncated = (await this.repository.countAfterKey(filter, start, CSV_ROW_LIMIT + 1)) > CSV_ROW_LIMIT;

    sink.status(HttpStatus.OK);
    sink.setHeader('Content-Type', 'text/csv; charset=utf-8');
    sink.setHeader('Content-Disposition', `attachment; filename="${csvFilename(filter.organizationId)}"`);
    sink.setHeader('X-Event-Log-Truncated', String(truncated));

    let written = 0;
    try {
      await writeChunk(sink, `${csvRow([...EVENT_LOG_CSV_COLUMNS])}\n`);
      let cursor = start;
      while (written < CSV_ROW_LIMIT && !sink.destroyed) {
        const batch = await this.repository.findAfterKey(
          filter,
          cursor,
          Math.min(CSV_FETCH_BATCH, CSV_ROW_LIMIT - written),
        );
        if (batch.length === 0) break;

        await writeChunk(sink, batch.map((entry) => `${csvRow(toCsvCells(entry))}\n`).join(''));
        written += batch.length;
        cursor = lastKeyOf(batch) ?? cursor;
      }
      // Same guard as the loop: the trailer is the one write that would otherwise land on a client
      // that disconnected, and a client cannot read a trailer it is no longer there for.
      if (!sink.destroyed) {
        await writeChunk(sink, `${CSV_TRAILER_PREFIX} rows=${written} truncated=${truncated} limit=${CSV_ROW_LIMIT}\n`);
      }
    } catch (error) {
      this.abortStream(error, written, sink);
      return;
    }

    sink.end();
  }

  /** Gate first, then pin the organization from context: the export must never read it from the query. */
  private authorizedFilter(query: EventLogExportQuery): EventLogFilter {
    this.contextService.requirePermission('event-log', 'access');
    return toEventLogFilter(this.contextService.organizationId, query);
  }

  private async openCursor(query: EventLogExportQuery, organizationId: string): Promise<CursorState> {
    if (!query.cursor) {
      return cursorAt(query.from ?? new Date(Date.now() - LOOKBACK_MS));
    }

    const state = decodeCursor(query.cursor);
    if (isCursorExpired(state, new Date(Date.now() - this.retentionDays * DAY_MS))) {
      throw new CursorExpiredError(await this.repository.findOldestKey(organizationId), this.retentionDays);
    }

    return state;
  }

  /** Reached only before the first byte, so the client still gets a status it can act on. */
  private failResponse(error: unknown, sink: EventLogExportSink): void {
    if (sink.headersSent) {
      this.logger.error(`Event log export failed after the response began: ${getErrorMessage(error)}`);
      sink.write(`${CSV_TRAILER_PREFIX} error=stream-failed\n`);
      sink.destroy();
      return;
    }

    if (error instanceof CursorExpiredError) {
      sink.status(HttpStatus.CONFLICT);
      sink.json(error.toBody());
      return;
    }

    const status = resolveStatus(error);
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`Event log export failed: ${getErrorMessage(error)}`);
    }
    sink.status(status);
    sink.json({ statusCode: status, message: describe(error, status) });
  }

  /** The status line is already sent, so the only honest signals left are an explicit marker and an
   *  aborted chunked body — a client reading to EOF cannot mistake a partial file for a whole one. */
  private abortStream(error: unknown, written: number, sink: EventLogExportSink): void {
    this.logger.error(`Event log export failed after ${written} rows: ${getErrorMessage(error)}`);
    sink.write(`${CSV_TRAILER_PREFIX} error=stream-failed rows=${written}\n`);
    sink.destroy();
  }
}

class CursorExpiredError extends Error {
  constructor(
    private readonly oldestAvailable: EventKey | null,
    private readonly retentionDays: number,
  ) {
    super('Event log export cursor has expired');
    this.name = 'CursorExpiredError';
  }

  toBody(): EventLogCursorExpired {
    return {
      statusCode: HttpStatus.CONFLICT,
      error: 'cursor_expired',
      message: `Cursor predates the ${this.retentionDays}-day retention window. Events older than the oldest available key are gone, not skipped.`,
      oldestAvailable: this.oldestAvailable,
      // `id: ''` sorts before every real row sharing the instant, so the oldest row itself is returned.
      cursor: encodeCursor(cursorAt(this.oldestAvailable?.createdAt ?? new Date())),
    };
  }
}

async function writeChunk(sink: EventLogExportSink, chunk: string): Promise<void> {
  if (!sink.write(chunk)) {
    await sink.drain();
  }
}

function resolveStatus(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  if (error instanceof CursorFormatError || error instanceof z.ZodError) return HttpStatus.BAD_REQUEST;
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function describe(error: unknown, status: number): string {
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return 'Event log export failed';
  return error instanceof Error ? error.message : 'Event log export failed';
}

function csvFilename(organizationId: string): string {
  return `event-log-${organizationId}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
}

function toCsvCells(entry: EventLogEntry): string[] {
  return EVENT_LOG_CSV_COLUMNS.map((column) => {
    const value = entry[column];
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

function lastKeyOf(entries: readonly EventLogEntry[]): EventKey | undefined {
  const last = entries.at(-1);
  return last ? { createdAt: last.createdAt, id: last.id } : undefined;
}
