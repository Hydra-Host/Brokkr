import { afterEach, describe, expect, it, vi } from 'vitest';

import { withEnv } from '../../__test__/env-guard.js';

withEnv('BROKKR_ZONE_ID', '11111111-2222-3333-4444-555555555555');

import { bmcCredentials, type BmcCredentials } from '../../common/bmc.types';
import type { BmcSecretSource, OpenedBmcSecret } from '../../monitoring/common/bmc-credentials-lookup.service';
import {
  DeviceCredentialResolver,
  configureDeviceCredentialResolver,
  getDeviceCredentialResolver,
  resetDeviceCredentialResolverForTests,
} from '../../monitoring/common/device-credential-resolver.service';
import { resetBmcCacheForTests } from '../bmc-cache-holder';
import { resetBmcSecretSourceForTests, setBmcSecretSource } from '../bmc-secret-source-holder';
import {
  buildDeviceCredentialResolverFactory,
  type DeviceCredentialResolverCache,
} from '../device-cred-resolver-factory';
import { buildStartupArgs } from '../startup-args';

class FakeDataCache implements DeviceCredentialResolverCache {
  constructor(private readonly strings: Map<string, string> = new Map()) {}

  seedDeviceData(deviceId: string, bmcIp: string): void {
    const blob = {
      interfaces: [
        {
          mgmt_only: true,
          ip_addresses: [{ address: `${bmcIp}/24` }],
        },
      ],
    };
    this.strings.set(`device:${deviceId}:data`, JSON.stringify(blob));
  }

  async scan(): Promise<string[]> {
    return [];
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
}

function secretSource(secrets: { [deviceId: string]: OpenedBmcSecret | null }): BmcSecretSource {
  return { getBmcSecret: vi.fn(async (deviceId: string) => secrets[deviceId] ?? null) };
}

describe('buildDeviceCredentialResolverFactory (wiring)', () => {
  afterEach(() => {
    resetDeviceCredentialResolverForTests();
    resetBmcCacheForTests();
    resetBmcSecretSourceForTests();
  });

  it('with cacheFactory: returns BmcCredentials combining the atom secret and the data-atom bmc_ip', async () => {
    const cache = new FakeDataCache();
    cache.seedDeviceData('device-42', '10.0.0.42');

    const builder = buildDeviceCredentialResolverFactory({
      cacheFactory: () => cache,
      secretSourceFactory: () => secretSource({ 'device-42': { username: 'admin', password: 's3cret' } }),
    });
    configureDeviceCredentialResolver(builder);

    const resolver = getDeviceCredentialResolver();
    const creds = await resolver.resolve('device-42');
    const expected: BmcCredentials = bmcCredentials('10.0.0.42', 'admin', 's3cret');
    expect(creds).toEqual(expected);
  });

  it('with cacheFactory: unknown device still resolves to null (no throw on miss)', async () => {
    const builder = buildDeviceCredentialResolverFactory({
      cacheFactory: () => new FakeDataCache(),
      secretSourceFactory: () => secretSource({}),
    });
    configureDeviceCredentialResolver(builder);

    const resolver = getDeviceCredentialResolver();
    await expect(resolver.resolve('not-seeded')).resolves.toBeNull();
  });

  it('cacheFactory is invoked lazily — only on first getDeviceCredentialResolver call', () => {
    let factoryCalls = 0;
    const builder = buildDeviceCredentialResolverFactory({
      cacheFactory: () => {
        factoryCalls += 1;
        return new FakeDataCache();
      },
      secretSourceFactory: () => secretSource({}),
    });
    configureDeviceCredentialResolver(builder);
    expect(factoryCalls).toBe(0);

    getDeviceCredentialResolver();
    expect(factoryCalls).toBe(1);

    getDeviceCredentialResolver();
    getDeviceCredentialResolver();
    expect(factoryCalls).toBe(1);
  });

  it('startup-args wires the factory into the deviceCredentialResolver slot and resolves a real instance', async () => {
    const args = buildStartupArgs({});
    const resolver = args.deviceCredentialResolver.builder();
    expect(resolver).toBeInstanceOf(DeviceCredentialResolver);
    await expect(resolver.resolve('any-device')).resolves.toBeNull();
  });

  it('with orchestrator on: the secret source defaults to the bind-before-use holder', async () => {
    const cache = new FakeDataCache();
    cache.seedDeviceData('device-7', '10.0.0.7');
    setBmcSecretSource(secretSource({ 'device-7': { username: 'root', password: 'pw' } }));

    const builder = buildDeviceCredentialResolverFactory({ cacheFactory: () => cache });
    configureDeviceCredentialResolver(builder);

    const creds = await getDeviceCredentialResolver().resolve('device-7');
    expect(creds).toEqual(bmcCredentials('10.0.0.7', 'root', 'pw'));
  });
});
