import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { getErrorMessage } from '@repo/utils';
import { URLS } from '../ports';

/** `view` follows the datastore browser, which an operator can re-point at any instance; `bridge` is
 *  always the spoke's, where sagas, leader election and the config atoms live. Asking wrong reads wrong. */
export type RedisTarget = 'view' | 'bridge';

const CLIENT_OPTIONS = {
  lazyConnect: false,
  maxRetriesPerRequest: 2,
  connectTimeout: 5_000,
  enableReadyCheck: true,
} as const;

@Injectable()
export class RedisConnectionsService implements OnModuleDestroy {
  private readonly clients = new Map<RedisTarget, Redis>();
  private readonly log = new Logger(RedisConnectionsService.name);

  // `||`, not `??`: these arrive from the devenv/secretspec env, where an unset knob is an empty
  // string rather than undefined, and `new Redis('')` would resolve somewhere other than the spoke.
  url(target: RedisTarget): string {
    if (target === 'bridge') return process.env.BRIDGE_REDIS_URL || URLS.redis;
    return process.env.DATASTORE_REDIS_URL || process.env.BRIDGE_REDIS_URL || URLS.redis;
  }

  client(target: RedisTarget): Redis {
    const existing = this.clients.get(target);
    if (existing) return existing;
    const client = new Redis(this.url(target), CLIENT_OPTIONS);
    // a down redis is normal mid-nuke and these reads ride the status poll, so log at debug, not warn.
    client.on('error', (error) => this.log.debug(`${target} redis error: ${getErrorMessage(error)}`));
    this.clients.set(target, client);
    return client;
  }

  onModuleDestroy(): void {
    for (const client of this.clients.values()) client.disconnect();
    this.clients.clear();
  }
}
