import { describe, expect, it } from 'vitest';

import { commissionSagaPayloadSchema } from '../commission.schema';

const BMC_SECRET = {
  zoneId: '00000000-0000-0000-0000-000000000001',
  zoneKeyId: '00000000-0000-0000-0000-0000000000e1',
  deviceId: 'e5f6a7b8-1234-5678-9abc-def012345678',
  purpose: 'BMC',
  kind: 'USER',
  keyGen: 1,
  ephPub: 'ZXBoUHViQmFzZTY0',
  ciphertext: 'Y2lwaGVydGV4dEJhc2U2NA==',
  tag: 'dGFnQmFzZTY0',
};

const VALID = {
  device_id: 'e5f6a7b8-1234-5678-9abc-def012345678',
  bmc_ip: '10.0.0.1',
  secrets: { bmc: BMC_SECRET },
  boot_device: 'pxe',
  storage_layouts: { sda: { type: 'disk', ptable: 'gpt' } },
};

describe('commissionSagaPayloadSchema', () => {
  it('accepts a fully populated payload', () => {
    const result = commissionSagaPayloadSchema.parse(VALID);
    expect(result.device_id).toBe('e5f6a7b8-1234-5678-9abc-def012345678');
    expect(result.storage_layouts).toEqual({ sda: { type: 'disk', ptable: 'gpt' } });
  });

  it('rejects missing storage_layouts', () => {
    const { storage_layouts: _omit, ...rest } = VALID;
    expect(() => commissionSagaPayloadSchema.parse(rest)).toThrow();
  });

  it('rejects a payload missing the sealed secrets envelope', () => {
    const { secrets: _omit, ...rest } = VALID;
    expect(() => commissionSagaPayloadSchema.parse(rest)).toThrow();
  });

  it('rejects plaintext root creds (username/password are no longer payload fields)', () => {
    expect(() => commissionSagaPayloadSchema.parse({ ...VALID, username: 'admin', password: 'secret' })).toThrow();
  });

  it('rejects empty boot_device', () => {
    expect(() => commissionSagaPayloadSchema.parse({ ...VALID, boot_device: '' })).toThrow();
  });

  it('rejects extra fields (strict mode)', () => {
    expect(() => commissionSagaPayloadSchema.parse({ ...VALID, rogue: 'x' })).toThrow();
  });

  it('accepts empty storage_layouts', () => {
    const result = commissionSagaPayloadSchema.parse({ ...VALID, storage_layouts: {} });
    expect(result.storage_layouts).toEqual({});
  });
});
