import { describe, expect, it } from 'vitest';

import { bmcCredentials } from '../../../common/bmc.types';
import {
  CachingDeviceVendorHints,
  EmptyDeviceVendorHints,
  GpuLayout,
  defaultVendorHints,
  type DeviceVendorHints,
  type VendorHints,
} from '../device-vendor-hints';

const DUMMY_CREDS = bmcCredentials('10.0.0.1', 'u', 'p');

class CountingHints implements DeviceVendorHints {
  calls = 0;
  constructor(private readonly hints: VendorHints) {}
  async get(): Promise<VendorHints> {
    this.calls += 1;
    return this.hints;
  }
}

describe('default VendorHints', () => {
  it('no args means baseline only', () => {
    const h = defaultVendorHints();
    expect(h.gpuLayout).toBe(GpuLayout.NONE);
    expect(h.gpuCount).toBe(0);
  });
});

describe('EmptyDeviceVendorHints', () => {
  it('any device returns defaults', async () => {
    const lookup = new EmptyDeviceVendorHints();
    expect(await lookup.get('42', DUMMY_CREDS)).toEqual(defaultVendorHints());
  });
});

describe('CachingDeviceVendorHints', () => {
  it('first call probes inner', async () => {
    const inner = new CountingHints({
      ...defaultVendorHints(),
      gpuLayout: GpuLayout.LENOVO_XCC,
      gpuCount: 4,
    });
    const cache = new CachingDeviceVendorHints(inner, 60);
    const h = await cache.get('42', DUMMY_CREDS);
    expect(h.gpuCount).toBe(4);
    expect(inner.calls).toBe(1);
  });

  it('second call within ttl uses cache', async () => {
    const inner = new CountingHints({
      ...defaultVendorHints(),
      gpuLayout: GpuLayout.LENOVO_XCC,
      gpuCount: 4,
    });
    const cache = new CachingDeviceVendorHints(inner, 60);
    await cache.get('42', DUMMY_CREDS);
    await cache.get('42', DUMMY_CREDS);
    await cache.get('42', DUMMY_CREDS);
    expect(inner.calls).toBe(1);
  });

  it('different devices each probe once', async () => {
    const inner = new CountingHints(defaultVendorHints());
    const cache = new CachingDeviceVendorHints(inner, 60);
    await cache.get('d1', DUMMY_CREDS);
    await cache.get('d2', DUMMY_CREDS);
    expect(inner.calls).toBe(2);
  });

  it('credential rotation reprobes', async () => {
    const inner = new CountingHints(defaultVendorHints());
    const cache = new CachingDeviceVendorHints(inner, 60);
    await cache.get('42', DUMMY_CREDS);
    const rotated = bmcCredentials('10.0.0.1', 'u', 'NEW');
    await cache.get('42', rotated);
    expect(inner.calls).toBe(2);
  });

  it('expired entry reprobes', async () => {
    const inner = new CountingHints(defaultVendorHints());
    const cache = new CachingDeviceVendorHints(inner, 0);
    await cache.get('42', DUMMY_CREDS);
    await cache.get('42', DUMMY_CREDS);
    expect(inner.calls).toBe(2);
  });

  it('invalidate single device', async () => {
    const inner = new CountingHints(defaultVendorHints());
    const cache = new CachingDeviceVendorHints(inner, 60);
    await cache.get('d1', DUMMY_CREDS);
    await cache.get('d2', DUMMY_CREDS);
    cache.invalidate('d1');
    await cache.get('d1', DUMMY_CREDS);
    await cache.get('d2', DUMMY_CREDS);
    expect(inner.calls).toBe(3);
  });

  it('invalidate without device id clears entire cache', async () => {
    const inner = new CountingHints(defaultVendorHints());
    const cache = new CachingDeviceVendorHints(inner, 60);
    await cache.get('d1', DUMMY_CREDS);
    await cache.get('d2', DUMMY_CREDS);
    cache.invalidate();
    await cache.get('d1', DUMMY_CREDS);
    await cache.get('d2', DUMMY_CREDS);
    expect(inner.calls).toBe(4);
  });
});
