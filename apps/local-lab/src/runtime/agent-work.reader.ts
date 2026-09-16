import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { getErrorMessage } from '@repo/utils';
import type { ZoneAgentWork } from '../contract';
import { RedisConnectionsService } from '../datastore/redis-connections.service';
import { workDispatchPattern, workProgressPattern } from './runtime-keys';

const SCAN_COUNT = 200;
// exported so the spec pins the real boundary rather than a copy of it that could silently drift
export const WORK_SCAN_CAP = 1000;
export const PROGRESS_READ_CAP = 200;

interface ScanResult {
  keys: string[];
  capped: boolean;
}

@Injectable()
export class AgentWorkReaderService {
  private readonly log = new Logger(AgentWorkReaderService.name);

  constructor(private readonly connections: RedisConnectionsService) {}

  /** Agent gRPC sessions live in each bridge's process memory and are published nowhere, so this
   *  reports the zone's recent agent WORK keys — never read it as session liveness. */
  async read(zoneId: string): Promise<ZoneAgentWork> {
    try {
      const client = this.connections.client('bridge');
      const dispatches = await this.scan(client, workDispatchPattern(zoneId));
      const progress = await this.scan(client, workProgressPattern(zoneId));
      const lastActivityAtMs = await this.latestProgress(client, progress.keys);
      return {
        dispatchesInFlight: dispatches.keys.length,
        lastActivityAtMs,
        // progress.capped is deliberately absent: a capped progress scan holds WORK_SCAN_CAP keys,
        // which always exceeds PROGRESS_READ_CAP, so the read-cap term already covers it.
        scanCapped: dispatches.capped || progress.keys.length > PROGRESS_READ_CAP,
        readError: null,
      };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`agent work read failed for ${zoneId}: ${readError}`);
      return { dispatchesInFlight: null, lastActivityAtMs: null, scanCapped: null, readError };
    }
  }

  private async scan(client: Redis, match: string): Promise<ScanResult> {
    const keys = new Set<string>();
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', match, 'COUNT', SCAN_COUNT);
      cursor = next;
      for (const key of batch) {
        if (keys.size >= WORK_SCAN_CAP) return { keys: [...keys], capped: true };
        keys.add(key);
      }
    } while (cursor !== '0');
    return { keys: [...keys], capped: false };
  }

  private async latestProgress(client: Redis, keys: string[]): Promise<number | null> {
    let latest: number | null = null;
    for (const key of keys.slice(0, PROGRESS_READ_CAP)) {
      // `_ts` is float SECONDS on this hash, unlike the atom envelopes' millisecond written_at.
      const raw = await client.hget(key, '_ts');
      if (raw === null) continue;
      const seconds = Number.parseFloat(raw);
      if (!Number.isFinite(seconds)) continue;
      const ms = Math.round(seconds * 1000);
      if (latest === null || ms > latest) latest = ms;
    }
    return latest;
  }
}
