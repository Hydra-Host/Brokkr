import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildWipeTimeoutConfig, getWipeTimeoutConfig, resetWipeTimeoutConfigForTests } from '../wipe-timeout.config';

afterEach(() => {
  resetWipeTimeoutConfigForTests();
  vi.unstubAllEnvs();
});

describe('buildWipeTimeoutConfig', () => {
  it('uses the wipe timeout defaults', () => {
    expect(buildWipeTimeoutConfig({})).toEqual({
      stallTimeoutS: 600,
      absoluteTimeoutS: 28_800,
    });
  });

  it('parses environment overrides', () => {
    expect(
      buildWipeTimeoutConfig({
        WIPE_STALL_TIMEOUT_SECONDS: ' 1_200 ',
        WIPE_ABSOLUTE_TIMEOUT_SECONDS: '36_000',
      }),
    ).toEqual({
      stallTimeoutS: 1_200,
      absoluteTimeoutS: 36_000,
    });
  });

  it.each([
    ['WIPE_STALL_TIMEOUT_SECONDS', 'abc'],
    ['WIPE_STALL_TIMEOUT_SECONDS', '1.5'],
    ['WIPE_ABSOLUTE_TIMEOUT_SECONDS', ''],
    ['WIPE_ABSOLUTE_TIMEOUT_SECONDS', 'Infinity'],
  ])('rejects non-integer %s=%s', (name, value) => {
    expect(() => buildWipeTimeoutConfig({ [name]: value })).toThrow(`${name} must be an integer`);
  });

  it.each([
    [{ WIPE_STALL_TIMEOUT_SECONDS: '0' }, /WIPE_STALL_TIMEOUT_SECONDS.*must be positive/],
    [{ WIPE_STALL_TIMEOUT_SECONDS: '-5' }, /WIPE_STALL_TIMEOUT_SECONDS.*must be positive/],
    [{ WIPE_ABSOLUTE_TIMEOUT_SECONDS: '0' }, /WIPE_ABSOLUTE_TIMEOUT_SECONDS.*must be positive/],
    [
      { WIPE_STALL_TIMEOUT_SECONDS: '600', WIPE_ABSOLUTE_TIMEOUT_SECONDS: '600' },
      /WIPE_STALL_TIMEOUT_SECONDS.*must be less than WIPE_ABSOLUTE_TIMEOUT_SECONDS/,
    ],
    [
      { WIPE_STALL_TIMEOUT_SECONDS: '601', WIPE_ABSOLUTE_TIMEOUT_SECONDS: '600' },
      /WIPE_STALL_TIMEOUT_SECONDS.*must be less than WIPE_ABSOLUTE_TIMEOUT_SECONDS/,
    ],
  ])('rejects invalid timeout values', (env, expected) => {
    expect(() => buildWipeTimeoutConfig(env)).toThrow(expected);
  });
});

describe('getWipeTimeoutConfig', () => {
  it('caches values until reset', () => {
    vi.stubEnv('WIPE_STALL_TIMEOUT_SECONDS', '120');
    vi.stubEnv('WIPE_ABSOLUTE_TIMEOUT_SECONDS', '7200');
    const first = getWipeTimeoutConfig();

    vi.stubEnv('WIPE_STALL_TIMEOUT_SECONDS', '240');
    vi.stubEnv('WIPE_ABSOLUTE_TIMEOUT_SECONDS', '14400');
    expect(getWipeTimeoutConfig()).toBe(first);
    expect(getWipeTimeoutConfig()).toEqual({ stallTimeoutS: 120, absoluteTimeoutS: 7200 });

    resetWipeTimeoutConfigForTests();
    expect(getWipeTimeoutConfig()).toEqual({ stallTimeoutS: 240, absoluteTimeoutS: 14400 });
  });
});
