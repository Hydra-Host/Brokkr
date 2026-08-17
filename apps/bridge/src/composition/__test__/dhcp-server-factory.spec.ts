import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withEnv } from '../../__test__/env-guard.js';
import { RedisClient } from '../../common/redis/redis-client/redis.client.js';
import { resetLeaderConfigForTests } from '../../leader-election/leader-election.config.js';
import { setAtomServedIps } from '../atom-served-ips-holder.js';
import * as holder from '../dhcp-lease-cache-holder.js';
import * as registryHolder from '../dhcp-registry-redis-holder.js';
import { buildDhcpServerDeps } from '../dhcp-server-factory.js';
import * as serverIdHolder from '../dhcp-server-id-holder.js';

const ZONE_UUID = '11111111-2222-3333-4444-555555555555';
withEnv('BROKKR_ZONE_ID', ZONE_UUID);
const TEST_AT_REST_KEY = Buffer.alloc(32, 0x42).toString('base64');
withEnv('BRIDGE_AT_REST_KEY', TEST_AT_REST_KEY);

const { capturedDeps } = vi.hoisted(() => ({
  capturedDeps: [] as import('../../dhcp/dhcp-manager.service.js').DhcpServerDeps[],
}));

vi.mock('../../dhcp/dhcp-manager.service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../dhcp/dhcp-manager.service.js')>();
  class CapturingDhcpServerService extends actual.DhcpServerService {
    constructor(deps: import('../../dhcp/dhcp-manager.service.js').DhcpServerDeps) {
      super(deps);
      capturedDeps.push(deps);
    }
  }
  return { ...actual, DhcpServerService: CapturingDhcpServerService };
});

describe('buildDhcpServerDeps — runtime config', () => {
  afterEach(() => {
    holder.resetDhcpLeaseCacheForTests();
    vi.restoreAllMocks();
  });

  it('returns a DhcpRuntimeConfig with default values', () => {
    const deps = buildDhcpServerDeps({});
    expect(deps.config.leaderPollMs).toBe(2000);
    expect(deps.config.pruneIntervalMs).toBe(60000);
    expect(deps.config.declineBackoffSeconds).toBe(600);
  });
});

describe('buildDhcpServerDeps — holder binding at createService time', () => {
  afterEach(() => {
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();
    serverIdHolder.resetDhcpServerIdGetterForTests();
    vi.restoreAllMocks();
  });

  it('binds the lease-cache and registry-redis holders when createService is invoked', () => {
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();
    expect(() => holder.getDhcpLeaseCacheOrThrow()).toThrow();
    expect(() => registryHolder.getDhcpRegistryRedisOrThrow()).toThrow();

    buildDhcpServerDeps(process.env).createService();

    expect(() => holder.getDhcpLeaseCacheOrThrow()).not.toThrow();
    expect(() => registryHolder.getDhcpRegistryRedisOrThrow()).not.toThrow();
  });
});

describe('DHCP holder binding — single composition Redis client', () => {
  afterEach(() => {
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();
    serverIdHolder.resetDhcpServerIdGetterForTests();
    vi.restoreAllMocks();
  });

  it('the bound-state predicates report unbound before createService and bound after', () => {
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();
    expect(holder.isDhcpLeaseCacheBound()).toBe(false);
    expect(registryHolder.isDhcpRegistryRedisBound()).toBe(false);

    buildDhcpServerDeps(process.env).createService();

    expect(holder.isDhcpLeaseCacheBound()).toBe(true);
    expect(registryHolder.isDhcpRegistryRedisBound()).toBe(true);
  });

  it('binds ONE client into both holders', () => {
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();

    buildDhcpServerDeps(process.env).createService();

    const leaseCacheClient = holder.getDhcpLeaseCacheOrThrow();
    const registryClient = registryHolder.getDhcpRegistryRedisOrThrow();
    expect(leaseCacheClient).toBe(registryClient);

    const wouldRebindLeaseCache = !holder.isDhcpLeaseCacheBound();
    const wouldRebindRegistry = !registryHolder.isDhcpRegistryRedisBound();
    expect(wouldRebindLeaseCache).toBe(false);
    expect(wouldRebindRegistry).toBe(false);
    expect(holder.getDhcpLeaseCacheOrThrow()).toBe(leaseCacheClient);
    expect(registryHolder.getDhcpRegistryRedisOrThrow()).toBe(registryClient);
  });

  it('disposes the orchestrator redis client on resetDhcpLeaseCacheForTests', () => {
    const closeSpy = vi.spyOn(RedisClient.prototype, 'close').mockResolvedValue(undefined);

    buildDhcpServerDeps(process.env).createService();
    holder.resetDhcpLeaseCacheForTests();

    expect(closeSpy).toHaveBeenCalled();
  });
});

describe('buildDhcpServerDeps — leaderTtlSeconds threaded from leader-config', () => {
  let prevTtl: string | undefined;

  function buildAndCaptureTtl(): number | undefined {
    resetLeaderConfigForTests();
    capturedDeps.length = 0;
    buildDhcpServerDeps(process.env).createService();
    return capturedDeps.at(-1)?.leaderTtlSeconds;
  }

  beforeEach(() => {
    prevTtl = process.env.LEADER_TTL_SECONDS;
  });

  afterEach(() => {
    if (prevTtl === undefined) delete process.env.LEADER_TTL_SECONDS;
    else process.env.LEADER_TTL_SECONDS = prevTtl;
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();
    serverIdHolder.resetDhcpServerIdGetterForTests();
    resetLeaderConfigForTests();
    vi.restoreAllMocks();
  });

  it('threads an overridden LEADER_TTL_SECONDS=60 into the DHCP service ctor', () => {
    process.env.LEADER_TTL_SECONDS = '60';
    expect(buildAndCaptureTtl()).toBe(60);
  });

  it('threads the leader-config default (30s) when LEADER_TTL_SECONDS is unset', () => {
    delete process.env.LEADER_TTL_SECONDS;
    expect(buildAndCaptureTtl()).toBe(30);
  });
});

describe('buildDhcpServerDeps — readAtoms and publishAtomServedIps wiring', () => {
  afterEach(() => {
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();
    serverIdHolder.resetDhcpServerIdGetterForTests();
    vi.restoreAllMocks();
  });

  it('wires readAtoms and publishAtomServedIps into DhcpServerService', () => {
    capturedDeps.length = 0;
    buildDhcpServerDeps(process.env).createService();
    const deps = capturedDeps.at(-1);
    expect(typeof deps?.readAtoms).toBe('function');
    expect(deps?.publishAtomServedIps).toBe(setAtomServedIps);
  });
});

describe('buildDhcpServerDeps — zone-prefix guard (no global config-atom scan)', () => {
  let prevZone: string | undefined;

  beforeEach(() => {
    prevZone = process.env.BROKKR_ZONE_ID;
    delete process.env.BROKKR_ZONE_ID;
  });

  afterEach(() => {
    if (prevZone === undefined) delete process.env.BROKKR_ZONE_ID;
    else process.env.BROKKR_ZONE_ID = prevZone;
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();
    vi.restoreAllMocks();
  });

  it('refuses to start with an empty BROKKR_ZONE_ID', () => {
    const deps = buildDhcpServerDeps({});
    expect(() => deps.createService()).toThrow(/BROKKR_ZONE_ID/);
  });
});

describe('buildDhcpServerDeps — composition redis release on stop', () => {
  afterEach(() => {
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();
    serverIdHolder.resetDhcpServerIdGetterForTests();
    vi.restoreAllMocks();
  });

  it('registers no process exit listener', () => {
    const before = process.listenerCount('exit');

    buildDhcpServerDeps(process.env).createService();

    expect(process.listenerCount('exit')).toBe(before);
  });

  it('closes the composition redis client when the service stops', async () => {
    const closeSpy = vi.spyOn(RedisClient.prototype, 'close').mockResolvedValue(undefined);
    const service = buildDhcpServerDeps(process.env).createService();

    expect(closeSpy).not.toHaveBeenCalled();

    await service.stop('job-1');

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('buildDhcpServerDeps — startup info log', () => {
  afterEach(() => {
    holder.resetDhcpLeaseCacheForTests();
    registryHolder.resetDhcpRegistryRedisForTests();
    serverIdHolder.resetDhcpServerIdGetterForTests();
    vi.restoreAllMocks();
  });

  it('logs the resolved BROKKR_ZONE_ID prefix at createService time', async () => {
    const logger = await import('../../logger/logger.service.js');
    const logInfoSpy = vi.spyOn(logger, 'logInfo').mockResolvedValue(undefined);

    buildDhcpServerDeps(process.env).createService();

    expect(logInfoSpy).toHaveBeenCalledWith(expect.stringContaining(ZONE_UUID));
  });
});
