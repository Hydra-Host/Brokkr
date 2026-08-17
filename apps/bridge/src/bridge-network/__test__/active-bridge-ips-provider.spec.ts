import { describe, expect, it, vi } from 'vitest';

import { createDefaultActiveBridgeIpsProvider, getLocalIpv4Addresses } from '../active-bridge-ips-provider';

describe('getLocalIpv4Addresses', () => {
  it('returns an array of strings, never throws on this host', () => {
    const ips = getLocalIpv4Addresses();
    expect(Array.isArray(ips)).toBe(true);
    for (const ip of ips) expect(typeof ip).toBe('string');
  });
});

describe('createDefaultActiveBridgeIpsProvider', () => {
  it('delegates to the injected discoverer', async () => {
    const discover = vi.fn(() => ['10.0.0.1', '192.168.1.1']);
    const provider = createDefaultActiveBridgeIpsProvider(discover);
    const ips = await provider.getActiveBridgeIps('job-xyz');
    expect(ips).toEqual(['10.0.0.1', '192.168.1.1']);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list and swallows discoverer failure (parity with log_error path)', async () => {
    const provider = createDefaultActiveBridgeIpsProvider(() => {
      throw new Error('netifaces blew up');
    });
    const ips = await provider.getActiveBridgeIps('job-xyz');
    expect(ips).toEqual([]);
  });
});
