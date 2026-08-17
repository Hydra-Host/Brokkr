import { describe, expect, it } from 'vitest';

import {
  bootstrapLockKey,
  epochMsFromFloatSeconds,
  instanceIdFromKey,
  instanceScanPattern,
  isLeaderFlag,
  isPresenceFresh,
  leaderKey,
  parseInterfaces,
  parsePlugins,
  prefixIdFromVrrpKey,
  PRESENCE_FRESH_SECONDS,
  vrrpScanPattern,
  workDispatchPattern,
  workProgressPattern,
  zoneCryptoKey,
} from '../runtime-keys';

const ZONE = '00000000-0000-0000-0000-111111111111';

describe('key construction', () => {
  it('prefixes every key with the zone uuid', () => {
    expect(leaderKey(ZONE)).toBe(`${ZONE}:bridge:leader`);
    expect(instanceScanPattern(ZONE)).toBe(`${ZONE}:bridge:instance:*`);
    expect(vrrpScanPattern(ZONE)).toBe(`${ZONE}:prefix:*:config:vrrp`);
    expect(zoneCryptoKey(ZONE)).toBe(`${ZONE}:zone_crypto`);
    expect(bootstrapLockKey(ZONE)).toBe(`${ZONE}:lock:zone_crypto:bootstrap_lock`);
    expect(workDispatchPattern(ZONE)).toBe(`${ZONE}:work:dispatch:*`);
    expect(workProgressPattern(ZONE)).toBe(`${ZONE}:work:progress:*`);
  });

  it('recovers the instance id from a presence key', () => {
    expect(instanceIdFromKey(`${ZONE}:bridge:instance:spoke-2`)).toBe('spoke-2');
    expect(instanceIdFromKey(`${ZONE}:bridge:instance:`)).toBeNull();
    expect(instanceIdFromKey(`${ZONE}:bridge:leader`)).toBeNull();
  });

  it('recovers the prefix id from a vrrp atom key', () => {
    expect(prefixIdFromVrrpKey(`${ZONE}:prefix:abc-123:config:vrrp`)).toBe('abc-123');
    expect(prefixIdFromVrrpKey(`${ZONE}:prefix:abc:config:dhcp`)).toBeNull();
  });
});

describe('isLeaderFlag', () => {
  it('reads the python-parity capitalised booleans', () => {
    expect(isLeaderFlag('True')).toBe(true);
    expect(isLeaderFlag('False')).toBe(false);
  });

  it('does not read a lowercase true as leader', () => {
    expect(isLeaderFlag('true')).toBeNull();
    expect(isLeaderFlag('false')).toBeNull();
  });

  it('reports an absent flag as undetermined rather than follower', () => {
    expect(isLeaderFlag(undefined)).toBeNull();
    expect(isLeaderFlag('')).toBeNull();
  });
});

describe('epochMsFromFloatSeconds', () => {
  it('converts float seconds to milliseconds', () => {
    expect(epochMsFromFloatSeconds('1712345678.5')).toBe(1712345678500);
    expect(epochMsFromFloatSeconds('1712345678.0')).toBe(1712345678000);
  });

  it('reports an absent or unparseable stamp as undetermined', () => {
    expect(epochMsFromFloatSeconds(undefined)).toBeNull();
    expect(epochMsFromFloatSeconds('recently')).toBeNull();
  });
});

describe('isPresenceFresh', () => {
  const now = 1_700_000_000_000;

  it('reads a record refreshed inside the window as online', () => {
    expect(isPresenceFresh(now - 5_000, now)).toBe(true);
  });

  it('reads a record older than the window as offline even though its key still exists', () => {
    expect(isPresenceFresh(now - (PRESENCE_FRESH_SECONDS + 5) * 1000, now)).toBe(false);
  });

  it('reports an unknown stamp as undetermined rather than offline', () => {
    expect(isPresenceFresh(null, now)).toBeNull();
  });
});

describe('embedded json fields', () => {
  it('parses reported interfaces and plugins', () => {
    const interfaces = parseInterfaces('[{"iface":"eth0","mac":"aa:bb","subnet":"10.0.0.0/24","ip":"10.0.0.2"}]');
    expect(interfaces).toEqual([{ iface: 'eth0', mac: 'aa:bb', subnet: '10.0.0.0/24', ip: '10.0.0.2' }]);
    expect(parsePlugins('[{"id":"hello","version":"1.0.0"}]')).toEqual([{ id: 'hello', version: '1.0.0' }]);
  });

  it('reads an empty list as a measurement and an absent field as undetermined', () => {
    expect(parseInterfaces('[]')).toEqual([]);
    expect(parseInterfaces(undefined)).toBeNull();
  });

  it('reports malformed json as undetermined rather than empty', () => {
    expect(parseInterfaces('{')).toBeNull();
    expect(parseInterfaces('[{"iface":"eth0"}]')).toBeNull();
  });
});
