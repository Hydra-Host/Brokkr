import { type Provider, type Type } from '@nestjs/common';

import { getBridgeVersion } from '../bridge-status/bridge.config.js';
import { RedisService } from '../common/redis/redis.service.js';
import type {
  InterfaceEntry,
  InterfaceEnumerator,
  LeaderCache,
  VersionInfo,
} from '../leader-election/leader-election.service.js';
import { OsNetworkInterfaceEnumerator } from '../leader-election/local-interface-enumerator.js';
import { DEFAULT_BROKKR_LIVE_VERSION } from '../sync/sync.config.js';

export const LEADER_CACHE = Symbol('LEADER_CACHE');
export const LEADER_INTERFACE_ENUMERATOR = Symbol('LEADER_INTERFACE_ENUMERATOR');

class RedisServiceLeaderCache implements LeaderCache {
  constructor(private readonly redis: RedisService) {}

  async setNx(key: string, value: string, opts: { ttlSeconds: number }): Promise<boolean> {
    return this.redis.setNxOwned(key, value, opts.ttlSeconds);
  }

  async renewIfOwner(key: string, expectedValue: string, opts: { ttlSeconds: number }): Promise<boolean> {
    return this.redis.renewIfOwner(key, expectedValue, opts.ttlSeconds);
  }

  async deleteIfOwner(key: string, expectedValue: string): Promise<boolean> {
    return this.redis.deleteIfOwner(key, expectedValue);
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async hset(key: string, mapping: Record<string, string>, opts: { ttlSeconds: number }): Promise<number> {
    return this.redis.hset(key, mapping, opts.ttlSeconds);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  async delete(key: string): Promise<number> {
    return this.redis.delete(key);
  }

  async scan(pattern: string): Promise<string[]> {
    return this.redis.scan(pattern);
  }
}

export const leaderCacheProvider: Provider = {
  provide: LEADER_CACHE,
  useFactory: (redis: RedisService): LeaderCache => new RedisServiceLeaderCache(redis),
  inject: [RedisService],
};

export const leaderInterfaceEnumeratorProvider: Provider = {
  provide: LEADER_INTERFACE_ENUMERATOR,
  useFactory: (): InterfaceEnumerator => new OsNetworkInterfaceEnumerator(),
};

export function buildLeaderElectionVersionInfo(env: NodeJS.ProcessEnv = process.env): () => VersionInfo {
  return () => ({
    brokkrWorkerVersion: getBridgeVersion(),
    brokkrLiveVersion: env.BROKKR_LIVE_VERSION ?? DEFAULT_BROKKR_LIVE_VERSION,
  });
}

export interface LeaderElectionCompositionTokens {
  cacheToken: Type<LeaderCache> | symbol | string;
  interfacesToken: Type<InterfaceEnumerator> | symbol | string;
  versionInfo: () => VersionInfo;
}

export function buildLeaderElectionModuleOptions(
  env: NodeJS.ProcessEnv = process.env,
): LeaderElectionCompositionTokens {
  return {
    cacheToken: LEADER_CACHE,
    interfacesToken: LEADER_INTERFACE_ENUMERATOR,
    versionInfo: buildLeaderElectionVersionInfo(env),
  };
}

export type { InterfaceEntry };
