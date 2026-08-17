import { Inject, Injectable } from '@nestjs/common';
import { SolLogEntrySchema, type SolLogEntry } from '@repo/api-client';
import { type Redis } from 'ioredis';
import { REDIS_CLIENT } from 'src/common/redis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';

export interface SolLogsResult {
  entries: SolLogEntry[];
  complete: boolean;
}

const END_SENTINEL = 'END LOG COLLECTION';

@Injectable()
export class SolLogService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async getLogsForPlan(zonePrefix: string, planId: string): Promise<SolLogsResult> {
    const key = REDIS_KEYS.solLogs(zonePrefix, planId);
    const raw = await this.redis.lrange(key, 0, -1);

    const entries: SolLogEntry[] = [];
    for (const item of raw) {
      const parsed = this.safeParse(item);
      if (parsed) entries.push(parsed);
    }

    const last = entries.at(-1);
    return { entries, complete: last?.message === END_SENTINEL };
  }

  private safeParse(raw: string): SolLogEntry | null {
    try {
      const json = JSON.parse(raw) as unknown;
      const result = SolLogEntrySchema.safeParse(json);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
