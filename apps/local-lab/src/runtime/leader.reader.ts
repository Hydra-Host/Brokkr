import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '../common/errors';
import type { ZoneLeader } from '../contract';
import { RedisConnectionsService } from '../datastore/redis-connections.service';
import {
  type BridgePresenceHash,
  BridgePresenceHashSchema,
  instanceIdFromKey,
  instanceScanPattern,
  leaderKey,
} from './runtime-keys';

const SCAN_COUNT = 200;
const INSTANCE_SCAN_CAP = 200;

export interface PresenceRecord {
  instanceId: string;
  hash: BridgePresenceHash;
}

@Injectable()
export class LeaderReaderService {
  private readonly log = new Logger(LeaderReaderService.name);

  constructor(private readonly connections: RedisConnectionsService) {}

  async leader(zoneId: string): Promise<ZoneLeader> {
    try {
      const client = this.connections.client('bridge');
      const key = leaderKey(zoneId);
      const holder = await client.get(key);
      if (holder === null || holder.length === 0) return { holder: null, ttlSeconds: null, readError: null };
      const ttl = await client.ttl(key);
      // redis answers -1 for a key with no expiry and -2 for one that vanished mid-read; neither is a
      // countdown, so report the lease as held with an undetermined ttl rather than inventing one.
      return { holder, ttlSeconds: ttl >= 0 ? ttl : null, readError: null };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`leader read failed for ${zoneId}: ${readError}`);
      return { holder: null, ttlSeconds: null, readError };
    }
  }

  async presence(zoneId: string): Promise<PresenceRecord[]> {
    const client = this.connections.client('bridge');
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', instanceScanPattern(zoneId), 'COUNT', SCAN_COUNT);
      cursor = next;
      for (const key of batch) if (keys.length < INSTANCE_SCAN_CAP) keys.push(key);
    } while (cursor !== '0' && keys.length < INSTANCE_SCAN_CAP);

    const records: PresenceRecord[] = [];
    for (const key of [...new Set(keys)]) {
      const instanceId = instanceIdFromKey(key);
      if (!instanceId) continue;
      const parsed = BridgePresenceHashSchema.safeParse(await client.hgetall(key));
      // a hash that does not carry an instance_id is a half-written or foreign record; keeping it
      // would invent a bridge row, so drop it and say so rather than reporting a nameless bridge.
      if (!parsed.success) {
        this.log.debug(`presence record ${key} did not parse; skipping`);
        continue;
      }
      records.push({ instanceId, hash: parsed.data });
    }
    return records;
  }
}
