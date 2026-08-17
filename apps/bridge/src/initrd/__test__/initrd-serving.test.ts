import { describe, expect, it } from 'vitest';

import { isUuid, parseBuildName } from '../initrd-serving.service.js';

describe('isUuid', () => {
  it('accepts canonical, nil, and dashless uuids', () => {
    expect(isUuid('8f14e45f-ceea-4e7a-9c3b-1a2b3c4d5e6f')).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid('8f14e45fceea4e7a9c3b1a2b3c4d5e6f')).toBe(true);
  });

  it('rejects non-uuids', () => {
    expect(isUuid('mac-aabbccddeeff')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('parseBuildName', () => {
  it('parses device-keyed discovery builds', () => {
    expect(parseBuildName('brokkr-discovery-8f14e45f-ceea-4e7a-9c3b-1a2b3c4d5e6f.img')).toEqual({
      initrdType: 'brokkr-discovery',
      deviceId: '8f14e45f-ceea-4e7a-9c3b-1a2b3c4d5e6f',
      discoveryMac: null,
    });
  });

  it('parses MAC-keyed discovery builds into the colon form', () => {
    expect(parseBuildName('brokkr-discovery-mac-AABBCCDDEEFF.img')).toEqual({
      initrdType: 'brokkr-discovery',
      deviceId: null,
      discoveryMac: 'aa:bb:cc:dd:ee:ff',
    });
  });

  it('rejects malformed MAC segments', () => {
    expect(parseBuildName('brokkr-discovery-mac-zzbbccddeeff.img')).toBeNull();
    expect(parseBuildName('brokkr-discovery-mac-aabbccddee.img')).toBeNull();
  });

  it('parses rescue builds and rejects non-uuid ids', () => {
    expect(parseBuildName('ubuntu-rescue-os-00000000-0000-0000-0000-000000000000.img')).toEqual({
      initrdType: 'ubuntu-rescue-os',
      deviceId: '00000000-0000-0000-0000-000000000000',
      discoveryMac: null,
    });
    expect(parseBuildName('ubuntu-rescue-os-latest.img')).toBeNull();
  });

  it('rejects unrelated names', () => {
    expect(parseBuildName('brokkr-live.img')).toBeNull();
    expect(parseBuildName('bridge-agent.img')).toBeNull();
    expect(parseBuildName('brokkr-discovery-8f14e45f-ceea-4e7a-9c3b-1a2b3c4d5e6f.iso')).toBeNull();
  });
});
