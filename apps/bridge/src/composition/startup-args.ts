import { getBridgeVersion } from '../bridge-status/bridge.config.js';
import { createIoredisDriverFactory } from '../common/redis/redis-client/ioredis-driver.js';
import { RedisClient } from '../common/redis/redis-client/redis.client.js';
import { loadRedisConfig } from '../common/redis/redis-client/redis.config.js';
import { logError, logInfo, logWarning } from '../logger/logger.service.js';
import { resolveListenHost } from '../startup/listen-target.js';
import type { RunStartupArgs } from '../startup/run-startup.js';
import type { StartupLogger } from '../startup/startup-deps.types.js';
import type { ZoneCryptoCache } from '../startup/zone-crypto-bootstrap.js';
import { syncDiscoveryImages as runDiscoverySync, type SyncVersionCache } from '../sync/discovery-sync.js';
import { buildAgentUnitRenderStartupFactory } from './agent-unit-render-startup-factory.js';
import { getBmcCacheOrThrow } from './bmc-cache-holder.js';
import { buildDeviceCredentialResolverFactory } from './device-cred-resolver-factory.js';
import { buildDhcpServerDeps } from './dhcp-server-factory.js';
import { buildDnsServerDeps } from './dns-server-factory.js';
import { buildZoneCryptoBootstrapFactory } from './zone-crypto-bootstrap-factory.js';

const discoverySyncVersionCache: SyncVersionCache = (() => {
  const store = new Map<string, string>();
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
      return true;
    },
    delete: async (k) => (store.delete(k) ? 1 : 0),
  };
})();

const startupLogger: StartupLogger = {
  info: (message, context) => {
    void logInfo(message, { jobId: context?.jobId ?? '', appClassName: context?.appClassName });
  },
  warn: (message, context) => {
    void logWarning(message, { jobId: context?.jobId ?? '', appClassName: context?.appClassName });
  },
  error: (message, context) => {
    void logError(message, { jobId: context?.jobId ?? '', appClassName: context?.appClassName });
  },
  debug: () => undefined,
};

let zoneCryptoBootstrapCache: RedisClient | undefined;
function getZoneCryptoBootstrapCache(): ZoneCryptoCache {
  if (zoneCryptoBootstrapCache === undefined) {
    const redisConfig = loadRedisConfig();
    zoneCryptoBootstrapCache = new RedisClient(
      redisConfig,
      createIoredisDriverFactory(redisConfig, 'redis:zone-crypto-bootstrap'),
    );
  }
  return zoneCryptoBootstrapCache;
}

export async function closeZoneCryptoBootstrapCache(): Promise<void> {
  const cache = zoneCryptoBootstrapCache;
  zoneCryptoBootstrapCache = undefined;
  if (cache !== undefined) await cache.close();
}

function orchestratorEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.BRIDGE_ORCHESTRATOR_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === 'true';
}

export function buildStartupArgs(env: NodeJS.ProcessEnv = process.env): RunStartupArgs {
  const bridgeSyncEnabled = parseBoolEnv(env.BRIDGE_SYNC_ENABLED, true);

  const dhcpServer = buildDhcpServerDeps(env);

  return {
    logger: startupLogger,
    agentUnitRenderStartup: buildAgentUnitRenderStartupFactory({
      env,
      logger: {
        info: async (message, context) => {
          await logInfo(message, { jobId: context?.jobId ?? '', appClassName: 'agent-unit-render' });
        },
        warning: async (message, context) => {
          await logWarning(message, { jobId: context?.jobId ?? '', appClassName: 'agent-unit-render' });
        },
      },
    }),
    sync: {
      syncConfig: { osLayerUrl: env.OS_LAYER_URL ?? '' },
      validateHttpsConfig: () => undefined,
      appConfig: {
        analyticsEnabled: parseBoolEnv(env.ANALYTICS_ENABLED, false),
        bridgeSyncEnabled,
        environment: env.ENVIRONMENT ?? 'prod',
        host: resolveListenHost(env),
        port: parseIntEnv(env.PORT, 8080),
        version: getBridgeVersion(),
        zoneId: (env.BROKKR_ZONE_ID ?? '').trim(),
      },
      syncDiscoveryImages: (jobId: string) => runDiscoverySync(discoverySyncVersionCache, jobId),
    },
    zoneCryptoBootstrap: buildZoneCryptoBootstrapFactory({
      cacheFactory: getZoneCryptoBootstrapCache,
      cacheCloser: closeZoneCryptoBootstrapCache,
      zoneId: (env.BROKKR_ZONE_ID ?? '').trim(),
      logger: startupLogger,
    }),
    deviceCredentialResolver: {
      builder: buildDeviceCredentialResolverFactory({
        env,
        cacheFactory: orchestratorEnabled(env) ? getBmcCacheOrThrow : undefined,
      }),
    },
    dnsServer: buildDnsServerDeps(env),
    dhcpServer,
  };
}
