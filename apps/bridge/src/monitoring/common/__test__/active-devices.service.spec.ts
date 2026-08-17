import { describe, expect, it, vi } from 'vitest';

import {
  extractBmcIp,
  getCachedDeviceData,
  iterActiveDeviceIds,
  type ActiveDevicesCache,
  type DeviceDataBlob,
} from '../active-devices.service';

function makeCache(overrides: Partial<ActiveDevicesCache> = {}): ActiveDevicesCache {
  return {
    scan: vi.fn(async () => []),
    get: vi.fn(async () => null),
    ...overrides,
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe('iterActiveDeviceIds', () => {
  it('extracts device ids from device-metadata atom keys', async () => {
    const cache = makeCache({
      scan: vi.fn(async () => ['device:42:data', 'device:1234:data', 'device:abc-uuid-99:data']),
    });
    const ids = await collect(iterActiveDeviceIds(cache));
    expect(ids.sort()).toEqual(['1234', '42', 'abc-uuid-99']);
  });

  it('ignores unrelated keys defensively', async () => {
    const cache = makeCache({
      scan: vi.fn(async () => [
        'device:42:data',
        'totally:unrelated:key',
        'device:data',
        'device:7:data',
        'device:9:device_record',
      ]),
    });
    const ids = await collect(iterActiveDeviceIds(cache));
    expect(ids.sort()).toEqual(['42', '7']);
  });

  it('yields nothing when cache.scan throws', async () => {
    const cache = makeCache({
      scan: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    const ids = await collect(iterActiveDeviceIds(cache));
    expect(ids).toEqual([]);
  });

  it('supports composite device ids with embedded colons after segment slicing', async () => {
    const cache = makeCache({
      scan: vi.fn(async () => ['device:a:b:data']),
    });
    const ids = await collect(iterActiveDeviceIds(cache));
    expect(ids).toEqual(['a:b']);
  });
});

describe('getCachedDeviceData', () => {
  it('returns parsed json on hit', async () => {
    const cache = makeCache({
      get: vi.fn(async () => JSON.stringify({ id: 42, interfaces: [] })),
    });
    const data = await getCachedDeviceData(cache, '42');
    expect(data).toEqual({ id: 42, interfaces: [] });
  });

  it('returns null on miss', async () => {
    const cache = makeCache({ get: vi.fn(async () => null) });
    expect(await getCachedDeviceData(cache, '42')).toBeNull();
  });

  it('returns null on malformed json', async () => {
    const cache = makeCache({ get: vi.fn(async () => 'not-json') });
    expect(await getCachedDeviceData(cache, '42')).toBeNull();
  });

  it('returns null when cache.get throws', async () => {
    const cache = makeCache({
      get: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    expect(await getCachedDeviceData(cache, '42')).toBeNull();
  });
});

describe('extractBmcIp', () => {
  it('finds mgmt-only ipv4', () => {
    const data: DeviceDataBlob = {
      interfaces: [
        { name: 'eth0', mgmt_only: false, ip_addresses: [{ address: '10.0.0.5/24' }] },
        { name: 'ipmi0', mgmt_only: true, ip_addresses: [{ address: '192.168.100.42/24' }] },
      ],
    };
    expect(extractBmcIp(data)).toBe('192.168.100.42');
  });

  it('returns null without mgmt interface', () => {
    const data: DeviceDataBlob = {
      interfaces: [{ name: 'eth0', mgmt_only: false, ip_addresses: [{ address: '10.0.0.5/24' }] }],
    };
    expect(extractBmcIp(data)).toBeNull();
  });

  it('returns null when mgmt interface has no ip', () => {
    const data: DeviceDataBlob = {
      interfaces: [{ name: 'ipmi0', mgmt_only: true, ip_addresses: [] }],
    };
    expect(extractBmcIp(data)).toBeNull();
  });

  it('strips cidr suffix', () => {
    const data: DeviceDataBlob = {
      interfaces: [{ mgmt_only: true, ip_addresses: [{ address: '1.2.3.4/32' }] }],
    };
    expect(extractBmcIp(data)).toBe('1.2.3.4');
  });

  it('returns null when interfaces key is missing', () => {
    expect(extractBmcIp({})).toBeNull();
  });
});
