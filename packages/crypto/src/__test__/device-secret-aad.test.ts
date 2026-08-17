import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { DEVICE_SECRET_AAD_VERSION, deviceSecretAad, type DeviceSecretAadFields } from '../device-secret-aad';

function fields(overrides: Partial<DeviceSecretAadFields> = {}): DeviceSecretAadFields {
  return {
    zoneId: 'zone-1',
    zoneKeyId: 'enrollment-1',
    deviceId: 'device-1',
    purpose: 'BMC',
    kind: 'USER',
    keyGen: 1,
    ...overrides,
  };
}

describe('deviceSecretAad — encoding', () => {
  it('emits keys in lexicographic order with no whitespace, binding all fields + zone_key_id', () => {
    expect(deviceSecretAad(fields()).toString('utf8')).toBe(
      '{"aad_v":1,"device_id":"device-1","key_gen":1,"purpose":"device-secret",' +
        '"secret_kind":"USER","secret_purpose":"BMC","zone_id":"zone-1","zone_key_id":"enrollment-1"}',
    );
  });

  it('carries the fixed device-secret domain separator', () => {
    expect(deviceSecretAad(fields()).toString('utf8')).toContain('"purpose":"device-secret"');
  });

  it('emits keyGen as a JSON number, not a string', () => {
    const out = deviceSecretAad(fields({ keyGen: 42 })).toString('utf8');
    expect(out).toContain('"key_gen":42');
    expect(out).not.toContain('"key_gen":"42"');
  });

  it('emits non-ASCII as raw UTF-8 (no \\uXXXX escapes)', () => {
    const out = deviceSecretAad(fields({ zoneId: 'zöne-üñîçødé' }));
    expect(out.includes(Buffer.from('zöne-üñîçødé', 'utf8'))).toBe(true);
    expect(out.toString('utf8')).not.toContain('\\u00');
  });

  it('is byte-identical regardless of input field declaration order', () => {
    const a = deviceSecretAad({
      keyGen: 7,
      zoneKeyId: 'e',
      kind: 'KEY',
      zoneId: 'z',
      purpose: 'CONSOLE',
      deviceId: 'd',
    });
    const b = deviceSecretAad({
      zoneId: 'z',
      deviceId: 'd',
      purpose: 'CONSOLE',
      kind: 'KEY',
      keyGen: 7,
      zoneKeyId: 'e',
    });
    expect(a.equals(b)).toBe(true);
  });

  it('produces distinct bytes when zone_key_id changes', () => {
    expect(deviceSecretAad(fields({ zoneKeyId: 'a' })).equals(deviceSecretAad(fields({ zoneKeyId: 'b' })))).toBe(false);
  });

  it('uses aad version 1', () => {
    expect(DEVICE_SECRET_AAD_VERSION).toBe(1);
    expect(deviceSecretAad(fields()).toString('utf8')).toContain('"aad_v":1');
  });
});

describe('deviceSecretAad — validation', () => {
  it.each(['zoneId', 'zoneKeyId', 'deviceId', 'purpose', 'kind'] as const)('rejects empty %s', (field) => {
    expect(() => deviceSecretAad(fields({ [field]: '' }))).toThrow(new RegExp(`deviceSecretAad.${field}`));
  });

  it('rejects a negative keyGen', () => {
    expect(() => deviceSecretAad(fields({ keyGen: -1 }))).toThrow(/keyGen must be a non-negative integer/);
  });

  it('rejects a non-integer keyGen', () => {
    expect(() => deviceSecretAad(fields({ keyGen: 1.5 }))).toThrow(/keyGen must be a non-negative integer/);
  });

  it('accepts keyGen 0', () => {
    expect(deviceSecretAad(fields({ keyGen: 0 })).toString('utf8')).toContain('"key_gen":0');
  });
});
