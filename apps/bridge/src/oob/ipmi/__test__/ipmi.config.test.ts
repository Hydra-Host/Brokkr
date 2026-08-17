import { describe, expect, it } from 'vitest';

import { buildIpmiConfig } from '../ipmi.config.js';

describe('buildIpmiConfig', () => {
  it('defaults command timeout to 30 when env is unset', () => {
    expect(buildIpmiConfig({}).commandTimeout).toBe(30);
  });

  it('honors IPMI_COMMAND_TIMEOUT override', () => {
    expect(buildIpmiConfig({ IPMI_COMMAND_TIMEOUT: '45' }).commandTimeout).toBe(45);
  });

  it('strips PEP-515 underscore separators', () => {
    expect(buildIpmiConfig({ IPMI_COMMAND_TIMEOUT: '1_000' }).commandTimeout).toBe(1000);
  });

  it('rejects a non-integer IPMI_COMMAND_TIMEOUT', () => {
    expect(() => buildIpmiConfig({ IPMI_COMMAND_TIMEOUT: '3.5' })).toThrow();
  });

  it('locks the cipher detection list and cache dir', () => {
    const cfg = buildIpmiConfig({});
    expect(cfg.cipherDetectionList).toEqual([null, 3, 17]);
    expect(cfg.cipherCacheDir).toBe('/ipmi_ciphers');
  });
});
