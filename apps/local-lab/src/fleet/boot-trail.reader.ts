import { Inject, Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import type { BootTrail } from '../contract';
import { RedisConnectionsService } from '../datastore/redis-connections.service';
import {
  ChainHitValueSchema,
  dhcpPxeScanPattern,
  discoveryPendingScanPattern,
  ipxeChainHitScanPattern,
  PxeDecisionHashSchema,
} from '../runtime/runtime-keys';

const SCAN_COUNT = 100;

/** The three commands the trail needs, so a spec can hand in a fake without a cast. */
export interface TrailClient {
  scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', n: number): Promise<[string, string[]]>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface TrailConnections {
  client(target: 'bridge'): TrailClient;
}

async function scanAll(client: TrailClient, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

@Injectable()
export class BootTrailReader {
  private readonly log = new Logger(BootTrailReader.name);

  constructor(@Inject(RedisConnectionsService) private readonly connections: TrailConnections) {}

  async read(mac: string): Promise<BootTrail> {
    try {
      const client = this.connections.client('bridge');
      const [pxeKeys, pendingKeys, chainKeys] = await Promise.all([
        scanAll(client, dhcpPxeScanPattern(mac)),
        scanAll(client, discoveryPendingScanPattern(mac)),
        scanAll(client, ipxeChainHitScanPattern(mac)),
      ]);
      const pxe = pxeKeys.length === 0 ? null : await this.decision(client, pxeKeys[0]);
      const chainAtMs = chainKeys.length === 0 ? null : await this.chainHit(client, chainKeys[0]);
      return { pxe, chainReached: chainKeys.length > 0 || pendingKeys.length > 0, chainAtMs, readError: null };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`boot trail read failed for ${mac}: ${readError}`);
      return { pxe: null, chainReached: null, chainAtMs: null, readError };
    }
  }

  private async chainHit(client: TrailClient, key: string): Promise<number | null> {
    const raw = await client.get(key);
    if (raw === null) return null;
    try {
      return ChainHitValueSchema.parse(JSON.parse(raw)).atMs;
    } catch (error) {
      this.log.debug(`chain hit ${key} did not parse; reporting the hit without a time: ${getErrorMessage(error)}`);
      return null;
    }
  }

  private async decision(client: TrailClient, key: string): Promise<BootTrail['pxe']> {
    const parsed = PxeDecisionHashSchema.safeParse(await client.hgetall(key));
    // a half-written or foreign hash is not a decision; report none rather than invent one
    if (!parsed.success) {
      this.log.debug(`pxe decision ${key} did not parse; reporting no decision`);
      return null;
    }
    return { outcome: parsed.data.outcome, atMs: Number.parseInt(parsed.data.at, 10) };
  }
}
