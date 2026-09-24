import { type JobLogEntry, type JobLogsResponse } from '@repo/api-client';
import { z } from 'zod';
import { jobRedisKeys } from './redis-keys';
import { type DiagnosticsLogger } from './sol-log.reader';

export const jobLogStreamEntrySchema = z.object({
  timestamp: z.string(),
  log_level: z.string(),
  message: z.string(),
  app_name: z.string(),
  app_class_name: z.string(),
});

export interface JobLogStream {
  xrange(key: string, start: string, end: string, count: 'COUNT', limit: number): Promise<Array<[string, string[]]>>;
}

export class JobLogStreamReader {
  constructor(
    private readonly redis: JobLogStream,
    private readonly logger: DiagnosticsLogger,
  ) {}

  async readPage(
    zonePrefix: string,
    planId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<JobLogsResponse> {
    const key = jobRedisKeys.jobLogs(zonePrefix, planId);
    const start = cursor ? `(${cursor}` : '-';
    const raw = await this.redis.xrange(key, start, '+', 'COUNT', limit);

    const entries = raw.flatMap(([id, fields]): JobLogEntry[] => {
      const parsed = jobLogStreamEntrySchema.safeParse(fieldArrayToRecord(fields));
      if (!parsed.success) {
        this.logger.warn(`Dropping malformed job log entry ${id} for job ${planId}: ${parsed.error.message}`);
        return [];
      }
      return [
        {
          id,
          timestamp: parsed.data.timestamp,
          logLevel: parsed.data.log_level,
          message: parsed.data.message,
          appName: parsed.data.app_name,
          appClassName: parsed.data.app_class_name,
        },
      ];
    });

    const nextCursor = raw.length === limit ? raw[raw.length - 1][0] : null;
    return { entries, nextCursor };
  }
}

function fieldArrayToRecord(fields: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    record[fields[i]] = fields[i + 1];
  }
  return record;
}
