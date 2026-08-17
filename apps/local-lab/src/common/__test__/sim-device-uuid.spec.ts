import { describe, expect, it } from 'vitest';

import { simDeviceIndex, simDeviceUuid } from '../hub-client';

describe('simDeviceIndex', () => {
  it('maps a deterministic sim uuid back to its 0-based fleet index', () => {
    expect(simDeviceIndex('00000000-0000-0000-0000-000000000001')).toBe(0);
    expect(simDeviceIndex('00000000-0000-0000-0000-000000000042')).toBe(41);
  });

  it('round-trips with simDeviceUuid', () => {
    for (const index of [0, 1, 9, 123]) {
      expect(simDeviceIndex(simDeviceUuid(index))).toBe(index);
    }
  });

  it('rejects a random UUIDv4 whose last segment starts with a decimal digit', () => {
    expect(simDeviceIndex('a1b2c3d4-e5f6-4789-abcd-3fa4b2c1d0e9')).toBeNull();
  });

  it('rejects the all-zero org id (tail 0 is not a valid node)', () => {
    expect(simDeviceIndex('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('rejects malformed ids', () => {
    expect(simDeviceIndex('')).toBeNull();
    expect(simDeviceIndex('not-a-uuid')).toBeNull();
    expect(simDeviceIndex('00000000-0000-0000-0000-00000000001')).toBeNull();
    expect(simDeviceIndex('00000000-0000-0000-0000-0000000000001')).toBeNull();
    expect(simDeviceIndex('11111111-0000-0000-0000-000000000001')).toBeNull();
    expect(simDeviceIndex('00000000-0000-0000-0000-00000000000a')).toBeNull();
  });
});
