import { describe, expect, it } from 'vitest';

import { deviceDataPattern, deviceSecret, discoveryPending, ipxeChainHit, normalizeDiscoveryMac } from '../redis-keys';

const DEVICE_ID = '11111111-2222-3333-4444-555555555555';

describe('redis-keys: ipxe chain-hit marker', () => {
  it('keys the marker on the normalized mac beside the pending key', () => {
    expect(ipxeChainHit('00:11:22:33:44:55')).toBe('ipxe:chain:00:11:22:33:44:55');
    expect(ipxeChainHit('00:11:22:33:44:55')).not.toBe(discoveryPending('00:11:22:33:44:55'));
  });
});

describe('redis-keys: discovery mac normalizer', () => {
  it('turns every twelve-digit form into lowercase colon-separated octets', () => {
    expect(normalizeDiscoveryMac('00-11-22-33-44-55')).toBe('00:11:22:33:44:55');
    expect(normalizeDiscoveryMac('00.11.22.33.44.55')).toBe('00:11:22:33:44:55');
    expect(normalizeDiscoveryMac('0011.2233.4455')).toBe('00:11:22:33:44:55');
    expect(normalizeDiscoveryMac('00:11:22:33:44:55')).toBe('00:11:22:33:44:55');
    expect(normalizeDiscoveryMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeDiscoveryMac('001122334455')).toBe('00:11:22:33:44:55');
  });

  it('only lowercases and swaps separators when the digits do not make six octets', () => {
    expect(normalizeDiscoveryMac('00-11-22')).toBe('00:11:22');
    expect(normalizeDiscoveryMac('')).toBe('');
  });

  it('keys the pending and chain-hit markers on the same normalized form', () => {
    const mac = normalizeDiscoveryMac('00-11-22-33-44-55');
    expect(discoveryPending(mac)).toBe('discovery:pending:00:11:22:33:44:55');
    expect(ipxeChainHit(mac)).toBe('ipxe:chain:00:11:22:33:44:55');
  });
});

describe('redis-keys: sealed device-secret atom', () => {
  it('builds the per-(device, purpose, kind) key under the secrets segment', () => {
    expect(deviceSecret(DEVICE_ID, 'BMC', 'USER')).toBe(`device:${DEVICE_ID}:secrets:bmc:user`);
  });

  it('lowercases purpose and kind so it addresses the identical key the hub writes', () => {
    expect(deviceSecret(DEVICE_ID, 'Console', 'Cert')).toBe(`device:${DEVICE_ID}:secrets:console:cert`);
  });

  it('the metrics-eligibility scan globs the device-metadata atom, not the secret', () => {
    expect(deviceDataPattern()).toBe('device:*:data');
  });
});
