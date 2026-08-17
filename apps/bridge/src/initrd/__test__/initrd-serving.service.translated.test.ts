import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import { NIL_DEVICE_ID } from '../../common/redis/redis-keys.js';
import type { InitrdServingDeps } from '../initrd-serving.service.js';
import { createInitrdServingService, InitrdServingService } from '../initrd-serving.service.js';
import { resetInitrdConfigForTests } from '../initrd.config.js';

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ['PERSISTENT_STORAGE_PATH', 'BROKKR_ZONE_ID']) {
    savedEnv[key] = process.env[key];
  }
  process.env.BROKKR_ZONE_ID = '00000000-0000-4000-8000-000000000001';
  resetInitrdConfigForTests();
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetInitrdConfigForTests();
});

interface FakeCache {
  get: Mock<(...args: any[]) => any>;
  set: Mock<(...args: any[]) => any>;
  hgetall: Mock<(...args: any[]) => any>;
  acquireLock: Mock<(...args: any[]) => any>;
  releaseLock: Mock<(...args: any[]) => any>;
  waitForLockRelease: Mock<(...args: any[]) => any>;
}

function makeCache(overrides: Partial<FakeCache> = {}): FakeCache {
  return {
    get: overrides.get ?? vi.fn(async () => null),
    set: overrides.set ?? vi.fn(async () => 'OK'),
    hgetall: overrides.hgetall ?? vi.fn(async () => ({})),
    acquireLock: overrides.acquireLock ?? vi.fn(async () => 'lock-token'),
    releaseLock: overrides.releaseLock ?? vi.fn(async () => true),
    waitForLockRelease: overrides.waitForLockRelease ?? vi.fn(async () => true),
  };
}

function makeDeps(overrides: Partial<InitrdServingDeps> = {}): InitrdServingDeps {
  return {
    cache: (overrides.cache as InitrdServingDeps['cache']) ?? makeCache(),
    resolveDeviceRecordByMac: overrides.resolveDeviceRecordByMac ?? (async () => null),
    getDeviceById: overrides.getDeviceById ?? (async () => null),
    buildBrokkrDiscoveryInitrd: overrides.buildBrokkrDiscoveryInitrd ?? (async () => undefined),
    buildUbuntuRescueOsInitrd: overrides.buildUbuntuRescueOsInitrd ?? (async () => undefined),
  };
}

async function mkTmpBuildsDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${label}-`));
  process.env.PERSISTENT_STORAGE_PATH = dir;
  resetInitrdConfigForTests();
  return join(dir, 'initrd-builds');
}

describe('InitrdServingService.getBuildsDir', () => {
  it('returns the configured initrd-builds path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'builds-cfg-'));
    process.env.PERSISTENT_STORAGE_PATH = root;
    resetInitrdConfigForTests();
    const svc = new InitrdServingService('test-job', makeDeps());
    expect(await svc.getBuildsDir()).toBe(join(root, 'initrd-builds'));
    await rm(root, { recursive: true, force: true });
  });
});

describe('InitrdServingService.findInitrdFile', () => {
  it('returns the default brokkr-live.img when no name is provided', async () => {
    const builds = await mkTmpBuildsDir('find-default');
    await mkdir(builds, { recursive: true });
    await writeFile(join(builds, 'brokkr-live.img'), Buffer.from('x'));

    const svc = new InitrdServingService('t', makeDeps());
    expect(await svc.findInitrdFile()).toBe(join(builds, 'brokkr-live.img'));
  });

  it('accepts a bare build name and appends .img', async () => {
    const builds = await mkTmpBuildsDir('find-bare');
    await mkdir(builds, { recursive: true });
    await writeFile(join(builds, 'bridge-agent.img'), Buffer.from('x'));

    const svc = new InitrdServingService('t', makeDeps());
    expect(await svc.findInitrdFile('bridge-agent')).toBe(join(builds, 'bridge-agent.img'));
  });

  it('accepts a build name with the .img suffix included', async () => {
    const builds = await mkTmpBuildsDir('find-suffixed');
    await mkdir(builds, { recursive: true });
    await writeFile(join(builds, 'brokkr-live.img'), Buffer.from('x'));

    const svc = new InitrdServingService('t', makeDeps());
    expect(await svc.findInitrdFile('brokkr-live.img')).toBe(join(builds, 'brokkr-live.img'));
  });

  it('serves a device-specific brokkr-discovery image by exact name', async () => {
    const builds = await mkTmpBuildsDir('find-device');
    await mkdir(builds, { recursive: true });
    await writeFile(join(builds, 'brokkr-discovery-42.img'), Buffer.from('x'));

    const svc = new InitrdServingService('t', makeDeps());
    expect(await svc.findInitrdFile('brokkr-discovery-42.img')).toBe(join(builds, 'brokkr-discovery-42.img'));
  });

  it('returns null when the requested file does not exist', async () => {
    const builds = await mkTmpBuildsDir('find-missing');
    await mkdir(builds, { recursive: true });

    const svc = new InitrdServingService('t', makeDeps());
    expect(await svc.findInitrdFile('nonexistent')).toBeNull();
  });

  it('returns null for an unknown build-type bare name', async () => {
    const builds = await mkTmpBuildsDir('find-invalid');
    await mkdir(builds, { recursive: true });

    const svc = new InitrdServingService('t', makeDeps());
    expect(await svc.findInitrdFile('invalid_type')).toBeNull();
  });

  it('rejects a path-traversal name that escapes the builds dir', async () => {
    const builds = await mkTmpBuildsDir('find-traversal');
    await mkdir(builds, { recursive: true });
    await writeFile(join(builds, '..', 'secret.img'), Buffer.from('top-secret'));

    const svc = new InitrdServingService('t', makeDeps());
    expect(await svc.findInitrdFile('brokkr-discovery-../../secret.img')).toBeNull();
    expect(await svc.findInitrdFile('brokkr-discovery-../secret.img')).toBeNull();
  });
});

describe('InitrdServingService.scheduleDelayedCleanup', () => {
  async function waitForGone(path: string, deadlineMs = 5000): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      try {
        await stat(path);
      } catch {
        return true;
      }
      if (Date.now() - start > deadlineMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  it('unlinks the target after the delay elapses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cleanup-real-'));
    const target = join(dir, 'doomed.img');
    await writeFile(target, Buffer.from('x'));

    const svc = new InitrdServingService('t', makeDeps());
    svc.scheduleDelayedCleanup(target, 0);

    expect(await waitForGone(target)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('swallows a missing-file error after the delay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cleanup-missing-'));
    const svc = new InitrdServingService('t', makeDeps());
    svc.scheduleDelayedCleanup(join(dir, 'nope.img'), 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(dir, { recursive: true, force: true });
  });
});

describe('createInitrdServingService', () => {
  it('returns an InitrdServingService instance', async () => {
    await mkTmpBuildsDir('factory');
    const svc = await createInitrdServingService('job-xyz', makeDeps());
    expect(svc).toBeInstanceOf(InitrdServingService);
  });
});

describe('InitrdServingService.buildDeviceInitrdOnDemand — short-circuits', () => {
  it('skips lock acquisition when the build name is unparseable', async () => {
    await mkTmpBuildsDir('short-bad-name');
    const cache = makeCache();
    const svc = new InitrdServingService('t', makeDeps({ cache }));

    await svc.buildDeviceInitrdOnDemand('brokkr-live.img');

    expect(cache.acquireLock).not.toHaveBeenCalled();
  });

  it('skips lock acquisition when the discovery payload is a non-uuid device id', async () => {
    await mkTmpBuildsDir('short-non-uuid');
    const cache = makeCache();
    const svc = new InitrdServingService('t', makeDeps({ cache }));

    await svc.buildDeviceInitrdOnDemand('brokkr-discovery-notauuid.img');

    expect(cache.acquireLock).not.toHaveBeenCalled();
  });

  it('brokkr-discovery-<NIL>.img is a bounded give-up: no build, no throw', async () => {
    await mkTmpBuildsDir('nil-give-up');
    const getDeviceById = vi.fn(async () => null);
    const buildBrokkrDiscoveryInitrd = vi.fn(async () => undefined);
    const svc = new InitrdServingService('t', makeDeps({ getDeviceById, buildBrokkrDiscoveryInitrd }));

    await svc.buildDeviceInitrdOnDemand(`brokkr-discovery-${NIL_DEVICE_ID}.img`);

    expect(buildBrokkrDiscoveryInitrd).not.toHaveBeenCalled();
    expect(getDeviceById).not.toHaveBeenCalled();
  });
});

describe('InitrdServingService.buildDeviceInitrdOnDemand — rescue caching gate', () => {
  const deviceId = '77777777-7777-7777-7777-777777777777';

  function rescueCacheWithKeys(customerKeys: string | null): FakeCache {
    const rescueKey = `device:${deviceId}:rescue:ssh_pub_keys`;
    return makeCache({
      get: vi.fn(async (key: string) => (key === rescueKey ? customerKeys : null)),
    });
  }

  async function runRescueBuild(cache: FakeCache, builds: string): Promise<Mock<(...args: any[]) => any>> {
    const buildUbuntu = vi.fn(async (_jobId: string, did: string) => {
      await mkdir(builds, { recursive: true });
      await writeFile(join(builds, `ubuntu-rescue-os-${did}.img`), Buffer.from('img-bytes'));
    });

    const svc = new InitrdServingService('t', makeDeps({ cache, buildUbuntuRescueOsInitrd: buildUbuntu }));
    await svc.buildDeviceInitrdOnDemand(`ubuntu-rescue-os-${deviceId}.img`);
    return buildUbuntu;
  }

  it('does NOT cache the admin-keys-only rescue image when customer keys are absent', async () => {
    const builds = await mkTmpBuildsDir('rescue-skip-cache');
    const cache = rescueCacheWithKeys(null);
    const buildUbuntu = await runRescueBuild(cache, builds);

    expect(buildUbuntu).toHaveBeenCalledOnce();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('caches the rescue image when the customer keys are present', async () => {
    const builds = await mkTmpBuildsDir('rescue-cache');
    const cache = rescueCacheWithKeys('ssh-ed25519 AAAA customer@host');
    const buildUbuntu = await runRescueBuild(cache, builds);

    expect(buildUbuntu).toHaveBeenCalledOnce();
    expect(cache.set).toHaveBeenCalledOnce();
  });
});

describe('InitrdServingService.buildDeviceInitrdOnDemand — client_ip threading', () => {
  it('forwards client_ip + output_name to the discovery builder on a UUID-keyed build', async () => {
    const deviceUuid = 'abcdef00-1111-2222-3333-444455556666';
    await mkTmpBuildsDir('client-ip');

    const cache = makeCache();
    const buildDiscovery = vi.fn();
    const svc = new InitrdServingService(
      't',
      makeDeps({
        cache,
        getDeviceById: async () => ({ id: deviceUuid, netplan: 'x' }),
        buildBrokkrDiscoveryInitrd: buildDiscovery,
      }),
    );

    await svc.buildDeviceInitrdOnDemand(`brokkr-discovery-${deviceUuid}.img`, '172.16.8.10');

    expect(buildDiscovery).toHaveBeenCalledOnce();
    const args = buildDiscovery.mock.calls[0];
    expect(args?.[3]).toBe(`brokkr-discovery-${deviceUuid}.img`);
    expect(args?.[4]).toBe('172.16.8.10');
  });

  it('acquires the build lock with a TTL above the worst-case build budget', async () => {
    const deviceUuid = 'abcdef00-1111-2222-3333-444455556666';
    await mkTmpBuildsDir('lock-ttl');

    const cache = makeCache();
    const svc = new InitrdServingService(
      't',
      makeDeps({
        cache,
        getDeviceById: async () => ({ id: deviceUuid, netplan: 'x' }),
        buildBrokkrDiscoveryInitrd: vi.fn(),
      }),
    );

    await svc.buildDeviceInitrdOnDemand(`brokkr-discovery-${deviceUuid}.img`);

    expect(cache.acquireLock.mock.calls[0]?.[1]).toBeGreaterThan(600);
  });
});

describe('InitrdServingService.buildDeviceInitrdOnDemand — MAC-keyed fact resolution', () => {
  it('sources facts from a placeholder device_record atom and skips discovery:pending', async () => {
    await mkTmpBuildsDir('placeholder-facts');

    const cache = makeCache();
    const placeholder = {
      id: '22222222-2222-2222-2222-222222222222',
      is_placeholder: true,
      status: 'inventory',
      role: 'discovered-hosts',
    };
    const buildDiscovery = vi.fn();
    const svc = new InitrdServingService(
      't',
      makeDeps({
        cache,
        resolveDeviceRecordByMac: async () =>
          placeholder as unknown as Awaited<ReturnType<InitrdServingDeps['resolveDeviceRecordByMac']>>,
        buildBrokkrDiscoveryInitrd: buildDiscovery,
      }),
    );

    await svc.buildDeviceInitrdOnDemand('brokkr-discovery-mac-aabbccddeeff.img');

    expect(cache.hgetall).not.toHaveBeenCalled();
    expect(buildDiscovery).toHaveBeenCalledOnce();
    const args = buildDiscovery.mock.calls[0];
    const deviceData = args?.[2] as Record<string, unknown>;
    expect(deviceData.status).toBe('inventory');
    expect(deviceData.role).toBe('discovered-hosts');
    expect(deviceData.id).toBe(NIL_DEVICE_ID);
    expect(deviceData.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(args?.[3]).toBe('brokkr-discovery-mac-aabbccddeeff.img');
  });

  it('falls back to discovery:pending facts when no placeholder record resolves', async () => {
    await mkTmpBuildsDir('pending-facts');

    const cache = makeCache({
      hgetall: vi.fn(async () => ({ manufacturer: 'Dell', serial: 'ABC123' })),
    });
    const buildDiscovery = vi.fn();
    const svc = new InitrdServingService(
      't',
      makeDeps({
        cache,
        resolveDeviceRecordByMac: async () => null,
        buildBrokkrDiscoveryInitrd: buildDiscovery,
      }),
    );

    await svc.buildDeviceInitrdOnDemand('brokkr-discovery-mac-aabbccddeeff.img');

    expect(cache.hgetall).toHaveBeenCalledOnce();
    expect(buildDiscovery).toHaveBeenCalledOnce();
    const args = buildDiscovery.mock.calls[0];
    const deviceData = args?.[2] as Record<string, unknown>;
    expect(deviceData.manufacturer).toBe('Dell');
    expect(deviceData.serial).toBe('ABC123');
    expect(deviceData.id).toBe(NIL_DEVICE_ID);
    expect(deviceData.mac).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('aborts without building when neither a placeholder record nor discovery:pending facts are found', async () => {
    await mkTmpBuildsDir('no-facts');

    const cache = makeCache({ hgetall: vi.fn(async () => ({})) });
    const buildDiscovery = vi.fn();
    const svc = new InitrdServingService(
      't',
      makeDeps({
        cache,
        resolveDeviceRecordByMac: async () => null,
        buildBrokkrDiscoveryInitrd: buildDiscovery,
      }),
    );

    await svc.buildDeviceInitrdOnDemand('brokkr-discovery-mac-aabbccddeeff.img');

    expect(buildDiscovery).not.toHaveBeenCalled();
  });
});
