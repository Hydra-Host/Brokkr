import { describe, expect, it } from 'vitest';

import { parseAddress, subnetMatchEntries } from '../subnet-match';
import type { BridgeSnapshot } from '../topology-broadcaster.types';

describe('subnetMatchEntries', () => {
  const clientAddr = parseAddress('10.0.0.50');

  it('has a parsable client address fixture', () => {
    expect(clientAddr).not.toBeNull();
  });

  it('skips a non-string subnet without throwing in parseNetwork', () => {
    const numberSubnet: BridgeSnapshot = [['bridge-a', [{ iface: 'eth0', ip: '10.0.0.231', subnet: 12345 }]]];
    const objectSubnet: BridgeSnapshot = [['bridge-a', [{ iface: 'eth0', ip: '10.0.0.231', subnet: {} }]]];
    expect(() => subnetMatchEntries(numberSubnet, clientAddr!)).not.toThrow();
    expect(subnetMatchEntries(numberSubnet, clientAddr!)).toEqual([]);
    expect(() => subnetMatchEntries(objectSubnet, clientAddr!)).not.toThrow();
    expect(subnetMatchEntries(objectSubnet, clientAddr!)).toEqual([]);
  });

  it('skips a non-string ip without throwing', () => {
    const snapshot: BridgeSnapshot = [['bridge-a', [{ iface: 'eth0', ip: 12345, subnet: '10.0.0.0/24' }]]];
    expect(() => subnetMatchEntries(snapshot, clientAddr!)).not.toThrow();
    expect(subnetMatchEntries(snapshot, clientAddr!)).toEqual([]);
  });

  it('continues past a poison entry to a valid entry in the same host', () => {
    const snapshot: BridgeSnapshot = [
      [
        'bridge-a',
        [
          { iface: 'eth0', ip: '10.0.0.231', subnet: 12345 },
          { iface: 'eth0', ip: '10.0.0.231', subnet: '10.0.0.0/24' },
        ],
      ],
    ];
    expect(subnetMatchEntries(snapshot, clientAddr!)).toEqual([['10.0.0.231', 'bridge-a']]);
  });

  it('matches a client-facing routable interface on the happy path', () => {
    const snapshot: BridgeSnapshot = [['bridge-a', [{ iface: 'eth0', ip: '10.0.0.231', subnet: '10.0.0.0/24' }]]];
    expect(subnetMatchEntries(snapshot, clientAddr!)).toEqual([['10.0.0.231', 'bridge-a']]);
  });
});
