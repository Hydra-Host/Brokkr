import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { getErrorMessage } from '@repo/utils';
import type { ZoneVip, ZoneVrrp } from '../contract';
import { RedisConnectionsService } from '../datastore/redis-connections.service';
import { readAtom } from './atom-envelope';
import { prefixIdFromVrrpKey, vrrpScanPattern } from './runtime-keys';
import { deriveObservedHolders, type ShimBinding } from './vrrp-desired';
import { VrrpShimReaderService } from './vrrp-shim.reader';

const SCAN_COUNT = 200;
const VIP_SCAN_CAP = 200;

const VrrpValueSchema = z.object({
  vip: z.string(),
  ifaceByBridge: z.record(z.string()),
  garpCount: z.number().int().optional(),
});

@Injectable()
export class VrrpReaderService {
  private readonly log = new Logger(VrrpReaderService.name);

  constructor(
    private readonly connections: RedisConnectionsService,
    private readonly shim: VrrpShimReaderService,
  ) {}

  async read(zoneId: string): Promise<ZoneVrrp> {
    const bindings = await this.shim.bindings();
    const observability = bindings === null ? ('unavailable' as const) : ('shim' as const);
    try {
      const vips = await this.vips(zoneId, bindings);
      return { observability, vips, readError: null };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`vrrp atom read failed for ${zoneId}: ${readError}`);
      return { observability, vips: [], readError };
    }
  }

  private async vips(zoneId: string, bindings: ShimBinding[] | null): Promise<ZoneVip[]> {
    const client = this.connections.client('bridge');
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', vrrpScanPattern(zoneId), 'COUNT', SCAN_COUNT);
      cursor = next;
      for (const key of batch) if (keys.length < VIP_SCAN_CAP) keys.push(key);
    } while (cursor !== '0' && keys.length < VIP_SCAN_CAP);

    const vips: ZoneVip[] = [];
    for (const key of [...new Set(keys)]) {
      const prefixId = prefixIdFromVrrpKey(key);
      if (!prefixId) continue;
      vips.push(this.toVip(prefixId, await client.get(key), bindings));
    }
    return vips.sort((a, b) => a.prefixId.localeCompare(b.prefixId));
  }

  private toVip(prefixId: string, raw: string | null, bindings: ShimBinding[] | null): ZoneVip {
    const atom = readAtom(raw, VrrpValueSchema);
    if (!atom.ok) {
      // a malformed or hub-failed atom keeps its row: dropping it would report the zone as having one
      // fewer VIP configured, which is a different and wrong answer from "this VIP is unreadable".
      return {
        prefixId,
        vip: null,
        ifaceByBridge: {},
        garpCount: null,
        writtenAtMs: atom.writtenAtMs,
        requestId: atom.requestId,
        desiredHolder: null,
        observedHolders: null,
        atomError: atom.error,
      };
    }
    return {
      prefixId,
      vip: atom.value.vip,
      ifaceByBridge: atom.value.ifaceByBridge,
      garpCount: atom.value.garpCount ?? null,
      writtenAtMs: atom.writtenAtMs,
      requestId: atom.requestId,
      // the leader is not known here; the service applies deriveDesiredHolder once it has both.
      desiredHolder: null,
      observedHolders: deriveObservedHolders(bindings, atom.value.vip),
      atomError: null,
    };
  }
}
