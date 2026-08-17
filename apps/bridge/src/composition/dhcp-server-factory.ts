import type { DhcpServerDeps } from '../startup/startup-services.js';

import { getPeerClientFacingIpv4, getPeerServerIds } from '../bridge-network/bridge-registry-reader.js';
import { createIoredisDriverFactory } from '../common/redis/redis-client/ioredis-driver.js';
import { RedisClient } from '../common/redis/redis-client/redis.client.js';
import { loadRedisConfig } from '../common/redis/redis-client/redis.config.js';
import { RedisService } from '../common/redis/redis.service.js';
import type { DhcpAtomValue } from '../dhcp/dhcp-atom-value.schema.js';
import { DhcpConfigReaderService } from '../dhcp/dhcp-config-reader.service.js';
import { DhcpServerService } from '../dhcp/dhcp-manager.service.js';
import { defaultDhcpRuntimeConfig, type DhcpRuntimeConfig } from '../dhcp/dhcp.config.js';
import type { LeaseStore } from '../dhcp/lease-store/lease-store.js';
import { RedisLeaseStore, type RedisLeaseCache } from '../dhcp/lease-store/redis-lease-store.js';
import { getLeaderConfig } from '../leader-election/leader-election.config.js';
import { getLeaderService } from '../leader-election/leader-election.service.js';
import { ContextLogger, logInfo, logWarning } from '../logger/logger.service.js';
import { resolveZonePrefix } from './resolve-zone-prefix.js';

import { setAtomServedIps } from './atom-served-ips-holder.js';
import { getDhcpLeaseCacheOrThrow, setDhcpLeaseCache } from './dhcp-lease-cache-holder.js';
import { getDhcpRegistryRedisOrThrow, setDhcpRegistryRedis } from './dhcp-registry-redis-holder.js';
import { setDhcpServerIdGetter } from './dhcp-server-id-holder.js';
import { setDhcpStandbyHealthGetter } from './dhcp-standby-health-holder.js';

export class RedisServiceLeaseCache implements RedisLeaseCache {
  constructor(private readonly redis: RedisService) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<unknown> {
    return this.redis.set(key, value, ttl);
  }

  async delete(key: string): Promise<number> {
    return this.redis.delete(key);
  }

  async scan(pattern: string): Promise<string[]> {
    return this.redis.scan(pattern);
  }
}

export function buildLeaseStore(env: NodeJS.ProcessEnv = process.env): LeaseStore {
  // Defense-in-depth: bindDhcpHoldersForOrchestrator already enforces this in the
  // composition path; guard here too for direct callers.
  if (resolveZonePrefix(env) === '') {
    throw new Error(
      'DHCP requires a non-empty BROKKR_ZONE_ID (zone UUID): the config-atom SCAN and lease keys are ' +
        'zone-scoped by the Redis key prefix, and an empty prefix would cause a cross-zone bleed',
    );
  }
  return new RedisLeaseStore(getDhcpLeaseCacheOrThrow, () => Date.now() / 1000, {
    warn: (message) => void logWarning(message, { jobId: '' }),
  });
}

function buildPeerDnsIpResolver(getServerId: () => string): (jobId: string) => Promise<string | null> {
  return async (jobId) => {
    const selfId = getLeaderService()?.instanceId ?? '';
    const serverId = getServerId();
    const preferClientAddr = serverId !== '' ? serverId : null;
    return getPeerClientFacingIpv4(getDhcpRegistryRedisOrThrow(), selfId, preferClientAddr, { jobId });
  };
}

function buildPeerServerIdResolver(): (jobId: string) => Promise<Set<string>> {
  return async (jobId) =>
    getPeerServerIds(getDhcpRegistryRedisOrThrow(), getLeaderService()?.instanceId ?? '', { jobId });
}

function bindDhcpHoldersForOrchestrator(env: NodeJS.ProcessEnv): RedisClient {
  const redisConfig = loadRedisConfig(env);
  const zonePrefix = resolveZonePrefix(env);
  // Sole zone-scoping guard: the atom SCAN and lease keys are scoped only by the Redis key
  // prefix — an empty prefix would match every zone on a shared Redis, regardless of lease mode.
  if (zonePrefix === '') {
    throw new Error(
      'DHCP requires a non-empty BROKKR_ZONE_ID (zone UUID): the config-atom SCAN is zone-scoped by the ' +
        'Redis key prefix, and an empty prefix would scan every zone. Refusing to start.',
    );
  }
  const resolvedConfig = { ...redisConfig, prefix: zonePrefix };
  void logInfo(`DHCP composition: BROKKR_ZONE_ID resolved to prefix '${zonePrefix}'`);
  const client = new RedisClient(resolvedConfig, createIoredisDriverFactory(resolvedConfig, 'redis:dhcp'));
  setDhcpLeaseCache(client, () => void client.close());
  setDhcpRegistryRedis(client);
  return client;
}

export function buildDhcpServerDeps(env: NodeJS.ProcessEnv = process.env): DhcpServerDeps {
  const config = defaultDhcpRuntimeConfig();
  // Redis/zone-guarded setup is deferred to createService() so buildStartupArgs({}) can
  // compose without a BROKKR_ZONE_ID; the fail-closed guard fires on first createService().
  return {
    config,
    createService: (): DhcpServerService => {
      const redisClient = bindDhcpHoldersForOrchestrator(env);
      const leaseStore = buildLeaseStore(env);
      let service: DhcpServerService | null = null;
      const resolvePeerDnsIp = buildPeerDnsIpResolver(() => service?.getServerId() ?? '');
      const leaderTtlSeconds = getLeaderConfig().leaderTtlSeconds;
      const configReader = new DhcpConfigReaderService(redisClient, new ContextLogger());
      const readAtoms = async (jobId: string): Promise<ReadonlyMap<string, DhcpAtomValue> | null> => {
        const result = await configReader.readAll(jobId);
        if (!result.ok) return null;
        return result.configs;
      };
      const resolvePeerServerIds = buildPeerServerIdResolver();
      service = new DhcpServerService({
        config,
        leaseStore,
        resolvePeerDnsIp,
        resolvePeerServerIds,
        leaderTtlSeconds,
        readAtoms,
        readZoneOps: (jobId) => configReader.readZoneOps(jobId),
        publishAtomServedIps: setAtomServedIps,
        onStop: () => redisClient.close(),
      });
      setDhcpServerIdGetter(() => service?.getServerId() ?? '');
      setDhcpStandbyHealthGetter(() => service?.getStandbyHealth() ?? null);
      return service;
    },
  };
}

export type { DhcpRuntimeConfig };
