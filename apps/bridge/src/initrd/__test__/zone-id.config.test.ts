import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getZoneId, resetInitrdConfigForTests } from '../initrd.config';

beforeEach(() => {
  resetInitrdConfigForTests();
  vi.stubEnv('BROKKR_ZONE_ID', '');
});
afterEach(() => {
  resetInitrdConfigForTests();
  vi.unstubAllEnvs();
});

describe('getZoneId', () => {
  it('returns the zone id when BROKKR_ZONE_ID is set', () => {
    vi.stubEnv('BROKKR_ZONE_ID', '00000000-0000-4000-8000-000000000001');
    expect(getZoneId()).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('throws when BROKKR_ZONE_ID is unset', () => {
    vi.stubEnv('BROKKR_ZONE_ID', '');
    expect(() => getZoneId()).toThrow(/BROKKR_ZONE_ID is not set/);
  });

  it('throws when BROKKR_ZONE_ID is blank whitespace', () => {
    vi.stubEnv('BROKKR_ZONE_ID', '   ');
    expect(() => getZoneId()).toThrow(/BROKKR_ZONE_ID is not set/);
  });
});
