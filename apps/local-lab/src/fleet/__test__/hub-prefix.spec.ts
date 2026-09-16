import { describe, expect, it } from 'vitest';

import { contract } from '@repo/api-client';
import { bootReadinessPath, dhcpConfigPath, PREFIXES_PATH, prefixPath } from '../hub-prefix';

const PREFIX_ID = '11111111-1111-4111-8111-111111111111';

describe('hub prefix paths', () => {
  it('PREFIXES_PATH is the contract listPrefixes path', () => {
    expect(PREFIXES_PATH).toBe(contract.listPrefixes.path);
    expect(PREFIXES_PATH).toBe('/api/v1/ipam/prefixes');
  });

  it('dhcpConfigPath inserts the prefix id into the contract path', () => {
    expect(dhcpConfigPath(PREFIX_ID)).toBe(`/api/v1/ipam/prefixes/${PREFIX_ID}/dhcp/config`);
  });

  it('prefixPath inserts the prefix id into the contract path', () => {
    expect(prefixPath(PREFIX_ID)).toBe(`/api/v1/ipam/prefixes/${PREFIX_ID}`);
  });

  it('bootReadinessPath carries the mac and adds a bmc address only when one is known', () => {
    expect(bootReadinessPath(PREFIX_ID, { mac: 'aa:bb:cc:dd:ee:01', bmcAddress: null })).toBe(
      `/api/v1/ipam/prefixes/${PREFIX_ID}/boot-readiness?mac=aa%3Abb%3Acc%3Add%3Aee%3A01`,
    );
    expect(bootReadinessPath(PREFIX_ID, { mac: 'aa:bb:cc:dd:ee:01', bmcAddress: '10.10.0.5' })).toBe(
      `/api/v1/ipam/prefixes/${PREFIX_ID}/boot-readiness?mac=aa%3Abb%3Acc%3Add%3Aee%3A01&bmcAddress=10.10.0.5`,
    );
  });
});
