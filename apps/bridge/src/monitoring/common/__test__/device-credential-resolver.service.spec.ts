import { afterEach, describe, expect, it } from 'vitest';

import { bmcCredentials, type BmcCredentials } from '../../../common/bmc.types';
import {
  DeviceCredentialResolver,
  configureDeviceCredentialResolver,
  getDeviceCredentialResolver,
  resetDeviceCredentialResolverForTests,
  resolveMetricsTarget,
  type BmcCredentialsLookup,
} from '../device-credential-resolver.service';

function creds(ip = '10.0.0.1'): BmcCredentials {
  return bmcCredentials(ip, 'u', 'p');
}

class CountingLookup implements BmcCredentialsLookup {
  readonly calls: string[] = [];
  constructor(private readonly table: Record<string, BmcCredentials>) {}
  async get(id: string): Promise<BmcCredentials | null> {
    this.calls.push(id);
    return this.table[id] ?? null;
  }
}

class SlowLookup extends CountingLookup {
  constructor(
    table: Record<string, BmcCredentials>,
    private readonly delayMs: number,
  ) {
    super(table);
  }
  override async get(id: string): Promise<BmcCredentials | null> {
    this.calls.push(id);
    await new Promise((r) => setTimeout(r, this.delayMs));
    return (this as unknown as { table: Record<string, BmcCredentials> }).table[id] ?? null;
  }
}

describe('DeviceCredentialResolver', () => {
  it('resolves and returns creds', async () => {
    const lookup = new CountingLookup({ '42': creds() });
    const resolver = new DeviceCredentialResolver(lookup);
    expect(await resolver.resolve('42')).toEqual(creds());
  });

  it('caches indefinitely after first resolve', async () => {
    const lookup = new CountingLookup({ '42': creds() });
    const resolver = new DeviceCredentialResolver(lookup);
    await resolver.resolve('42');
    await resolver.resolve('42');
    await resolver.resolve('42');
    expect(lookup.calls).toEqual(['42']);
  });

  it('miss is not cached', async () => {
    const table: Record<string, BmcCredentials> = {};
    const lookup = new CountingLookup(table);
    const resolver = new DeviceCredentialResolver(lookup);
    expect(await resolver.resolve('42')).toBeNull();
    table['42'] = creds();
    expect(await resolver.resolve('42')).toEqual(creds());
    expect(lookup.calls).toEqual(['42', '42']);
  });

  it('invalidate busts a single entry', async () => {
    const table: Record<string, BmcCredentials> = {
      '42': creds('10.0.0.1'),
      '99': creds('10.0.0.9'),
    };
    const lookup = new CountingLookup(table);
    const resolver = new DeviceCredentialResolver(lookup);
    await resolver.resolve('42');
    await resolver.resolve('99');
    table['42'] = bmcCredentials('10.0.0.1', 'u', 'rotated');
    resolver.invalidate('42');
    expect((await resolver.resolve('42'))?.password).toBe('rotated');
    expect(lookup.calls).toEqual(['42', '99', '42']);
  });

  it('invalidate on unknown device is a no-op', () => {
    const resolver = new DeviceCredentialResolver(new CountingLookup({}));
    expect(() => resolver.invalidate('nope')).not.toThrow();
  });

  it('concurrent cold resolves collapse via lock', async () => {
    const lookup = new SlowLookup({ '42': creds() }, 30);
    const resolver = new DeviceCredentialResolver(lookup);
    const results = await Promise.all([
      resolver.resolve('42'),
      resolver.resolve('42'),
      resolver.resolve('42'),
      resolver.resolve('42'),
      resolver.resolve('42'),
    ]);
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(creds()))).toBe(true);
    expect(lookup.calls).toEqual(['42']);
  });
});

describe('resolveIp', () => {
  class IpOnlyLookup implements BmcCredentialsLookup {
    readonly getCalls: string[] = [];
    readonly getIpCalls: string[] = [];
    constructor(
      private readonly credsTable: Record<string, BmcCredentials>,
      private readonly ipTable: Record<string, string>,
    ) {}
    async get(id: string): Promise<BmcCredentials | null> {
      this.getCalls.push(id);
      return this.credsTable[id] ?? null;
    }
    async getIp(id: string): Promise<string | null> {
      this.getIpCalls.push(id);
      return this.ipTable[id] ?? null;
    }
  }

  it('resolves the IP for a device with no sealed secret (PDU/CDU)', async () => {
    const lookup = new IpOnlyLookup({}, { 'pdu-1': '10.4.0.2' });
    const resolver = new DeviceCredentialResolver(lookup);
    expect(await resolver.resolveIp('pdu-1')).toBe('10.4.0.2');
    expect(lookup.getCalls).toEqual([]);
  });

  it('prefers the fresh blob IP over the pinned full-creds cache (BMC moves must propagate to ICMP)', async () => {
    const lookup = new IpOnlyLookup({ '42': creds('9.9.9.9') }, { '42': '10.0.0.99' });
    const resolver = new DeviceCredentialResolver(lookup);
    await resolver.resolve('42');
    expect(await resolver.resolveIp('42')).toBe('10.0.0.99');
  });

  it('falls back to the cached full-creds IP when the blob has none', async () => {
    const lookup = new IpOnlyLookup({ '42': creds('9.9.9.9') }, {});
    const resolver = new DeviceCredentialResolver(lookup);
    await resolver.resolve('42');
    expect(await resolver.resolveIp('42')).toBe('9.9.9.9');
  });

  it('returns null when the device has no IP anywhere', async () => {
    const lookup = new IpOnlyLookup({}, {});
    const resolver = new DeviceCredentialResolver(lookup);
    expect(await resolver.resolveIp('ghost')).toBeNull();
  });

  it('falls back to full resolve for lookups without getIp', async () => {
    const lookup = new CountingLookup({ '42': creds('7.7.7.7') });
    const resolver = new DeviceCredentialResolver(lookup);
    expect(await resolver.resolveIp('42')).toBe('7.7.7.7');
    expect(await resolver.resolveIp('missing')).toBeNull();
  });
});

describe('global resolver registration', () => {
  afterEach(() => resetDeviceCredentialResolverForTests());

  it('getDeviceCredentialResolver throws before configuration', () => {
    expect(() => getDeviceCredentialResolver()).toThrow();
  });

  it('builder is invoked lazily and result is memoized', () => {
    let built = 0;
    const lookup = new CountingLookup({});
    configureDeviceCredentialResolver(() => {
      built += 1;
      return new DeviceCredentialResolver(lookup);
    });
    const a = getDeviceCredentialResolver();
    const b = getDeviceCredentialResolver();
    expect(built).toBe(1);
    expect(a).toBe(b);
  });
});

describe('resolveMetricsTarget', () => {
  afterEach(() => resetDeviceCredentialResolverForTests());

  it('explicit values win and skip the resolver', async () => {
    const out = await resolveMetricsTarget({
      deviceId: '42',
      ip: '1.1.1.1',
      username: 'a',
      password: 'b',
    });
    expect(out).toEqual({ ip: '1.1.1.1', username: 'a', password: 'b', usedResolver: false });
  });

  it('missing values without deviceId fall through unchanged', async () => {
    const out = await resolveMetricsTarget({ deviceId: null, ip: null, username: null, password: null });
    expect(out.usedResolver).toBe(false);
  });

  it('fills missing values from resolver', async () => {
    const lookup = new CountingLookup({ '42': creds('9.9.9.9') });
    configureDeviceCredentialResolver(() => new DeviceCredentialResolver(lookup));
    const out = await resolveMetricsTarget({ deviceId: '42' });
    expect(out).toEqual({ ip: '9.9.9.9', username: 'u', password: 'p', usedResolver: true });
  });

  it('preserves explicit ip while resolver fills auth', async () => {
    const lookup = new CountingLookup({ '42': creds('9.9.9.9') });
    configureDeviceCredentialResolver(() => new DeviceCredentialResolver(lookup));
    const out = await resolveMetricsTarget({ deviceId: '42', ip: '1.1.1.1' });
    expect(out.ip).toBe('1.1.1.1');
    expect(out.username).toBe('u');
    expect(out.usedResolver).toBe(true);
  });

  it('resolver miss leaves caller values intact', async () => {
    const lookup = new CountingLookup({});
    configureDeviceCredentialResolver(() => new DeviceCredentialResolver(lookup));
    const out = await resolveMetricsTarget({ deviceId: '42' });
    expect(out).toEqual({ ip: null, username: null, password: null, usedResolver: false });
  });
});
