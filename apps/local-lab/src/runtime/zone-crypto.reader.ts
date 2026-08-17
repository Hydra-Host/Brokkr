import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '../common/errors';
import type { ZoneCrypto } from '../contract';
import { RedisConnectionsService } from '../datastore/redis-connections.service';
import { bootstrapLockKey, zoneCryptoKey } from './runtime-keys';

@Injectable()
export class ZoneCryptoReaderService {
  private readonly log = new Logger(ZoneCryptoReaderService.name);

  constructor(private readonly connections: RedisConnectionsService) {}

  /** EXISTS and TTL only. The zone-crypto value is AEAD ciphertext wrapping the zone private key, so
   *  it is never fetched, never logged and never returned — presence alone answers the question. */
  async read(zoneId: string): Promise<ZoneCrypto> {
    try {
      const client = this.connections.client('bridge');
      const enrolled = (await client.exists(zoneCryptoKey(zoneId))) === 1;
      if (enrolled) return { state: 'enrolled', bootstrapLockTtlSeconds: null, readError: null };

      const lockTtl = await client.ttl(bootstrapLockKey(zoneId));
      // -2 is "no such key", -1 is "no expiry"; only -2 means the lock is genuinely not held.
      if (lockTtl === -2) return { state: 'not-enrolled', bootstrapLockTtlSeconds: null, readError: null };
      return { state: 'bootstrapping', bootstrapLockTtlSeconds: lockTtl >= 0 ? lockTtl : null, readError: null };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`zone crypto probe failed for ${zoneId}: ${readError}`);
      return { state: 'unknown', bootstrapLockTtlSeconds: null, readError };
    }
  }
}
