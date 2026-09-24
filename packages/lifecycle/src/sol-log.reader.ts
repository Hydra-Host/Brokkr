import { SolLogEntrySchema, type JobSolLogEntry, type JobSolLogsResponse, type SolLogEntry } from '@repo/api-client';
import { jobRedisKeys } from './redis-keys';

export interface SolLogsResult {
  entries: SolLogEntry[];
  complete: boolean;
}

export interface DiagnosticsLogger {
  warn(message: string): void;
}

export interface SolLogList {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lindex(key: string, index: number): Promise<string | null>;
}

export const END_SENTINEL = 'END LOG COLLECTION';

export class SolLogReader {
  constructor(
    private readonly redis: SolLogList,
    private readonly logger: DiagnosticsLogger,
  ) {}

  async getLogsForPlan(zonePrefix: string, planId: string): Promise<SolLogsResult> {
    const key = jobRedisKeys.solLogs(zonePrefix, planId);
    const raw = await this.redis.lrange(key, 0, -1);

    const entries: SolLogEntry[] = [];
    for (const item of raw) {
      const parsed = this.safeParse(item);
      if (parsed) entries.push(parsed);
    }

    const last = entries.at(-1);
    return { entries, complete: last?.message === END_SENTINEL };
  }

  async getLogsPage(zonePrefix: string, planId: string, cursor: number, limit: number): Promise<JobSolLogsResponse> {
    const key = jobRedisKeys.solLogs(zonePrefix, planId);
    // the list only grows and the sentinel is last, so probing the tail first keeps complete from outrunning the page
    const tail = await this.redis.lindex(key, -1);
    const raw = await this.redis.lrange(key, cursor, cursor + limit - 1);

    const entries: JobSolLogEntry[] = [];
    raw.forEach((item, position) => {
      const index = cursor + position;
      const parsed = this.safeParse(item);
      if (!parsed) {
        this.logger.warn(`Dropping malformed sol log entry at offset ${index} for plan ${planId}`);
        return;
      }
      if (parsed.message === END_SENTINEL) return;
      entries.push({ index, timestamp: parsed.timestamp, message: parsed.message });
    });

    return {
      entries,
      nextCursor: raw.length === limit ? cursor + limit : null,
      complete: tail !== null && this.safeParse(tail)?.message === END_SENTINEL,
    };
  }

  private safeParse(raw: string): SolLogEntry | null {
    try {
      const result = SolLogEntrySchema.safeParse(JSON.parse(raw));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
