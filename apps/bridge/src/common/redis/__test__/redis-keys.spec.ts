import { describe, expect, it } from 'vitest';

import { deviceDataPattern, deviceSecret } from '../redis-keys';

const DEVICE_ID = '11111111-2222-3333-4444-555555555555';

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
