import { describe, expect, it } from 'vitest';

import { defaultDhcpRuntimeConfig, intToIp, ipToInt } from '../dhcp.config.js';

describe('defaultDhcpRuntimeConfig', () => {
  it('returns the baseline runtime tuning', () => {
    const config = defaultDhcpRuntimeConfig();
    expect(config.leaderPollMs).toBe(2000);
    expect(config.pruneIntervalMs).toBe(60000);
    expect(config.declineBackoffSeconds).toBe(600);
  });

  it('returns a fresh object per call', () => {
    const a = defaultDhcpRuntimeConfig();
    const b = defaultDhcpRuntimeConfig();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('ipToInt / intToIp', () => {
  it('round-trips addresses, including the high bit set', () => {
    for (const ip of ['0.0.0.0', '10.0.0.1', '192.168.1.255', '255.255.255.255']) {
      expect(intToIp(ipToInt(ip))).toBe(ip);
    }
  });

  it('keeps the result unsigned', () => {
    expect(ipToInt('255.255.255.255')).toBe(0xffffffff);
    expect(ipToInt('10.0.0.20') - ipToInt('10.0.0.10')).toBe(10);
  });
});
