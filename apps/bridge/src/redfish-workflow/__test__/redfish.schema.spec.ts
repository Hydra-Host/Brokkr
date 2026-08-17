import { describe, expect, it } from 'vitest';

import { redfishSagaPayloadSchema } from '../redfish.schema';

const SEALED_BMC = {
  zoneId: 'zone-1',
  zoneKeyId: 'enroll-1',
  deviceId: 'dev-1',
  purpose: 'BMC',
  kind: 'USER',
  keyGen: 1,
  ephPub: 'ZXBo',
  ciphertext: 'Y2lwaGVy',
  tag: 'dGFn',
};

const VALID = {
  bmc_ip: '10.0.0.1',
  device_id: 'dev-1',
  secrets: { bmc: SEALED_BMC },
  command: 'reliable_boot',
};

describe('RedfishSagaPayload', () => {
  it('accepts a minimal valid payload and defaults kwargs to null', () => {
    const parsed = redfishSagaPayloadSchema.parse(VALID);
    expect(parsed.bmc_ip).toBe('10.0.0.1');
    expect(parsed.command).toBe('reliable_boot');
    expect(parsed.device_id).toBe('dev-1');
    expect(parsed.secrets.bmc.ciphertext).toBe('Y2lwaGVy');
    expect(parsed.kwargs).toBeNull();
  });

  it('accepts a payload with kwargs populated', () => {
    const parsed = redfishSagaPayloadSchema.parse({ ...VALID, kwargs: { pending: true } });
    expect(parsed.kwargs).toEqual({ pending: true });
  });

  it('rejects a payload missing the required command field', () => {
    const { command: _drop, ...withoutCommand } = VALID;
    expect(redfishSagaPayloadSchema.safeParse(withoutCommand).success).toBe(false);
  });

  it('rejects a payload with no sealed secrets.bmc (creds must be sealed, never plaintext)', () => {
    const { secrets: _drop, ...withoutSecrets } = VALID;
    expect(redfishSagaPayloadSchema.safeParse(withoutSecrets).success).toBe(false);
    expect(
      redfishSagaPayloadSchema.safeParse({ ...withoutSecrets, username: 'admin', password: 'secret' }).success,
    ).toBe(false);
  });

  it('rejects an empty bmc_ip', () => {
    expect(redfishSagaPayloadSchema.safeParse({ ...VALID, bmc_ip: '' }).success).toBe(false);
  });

  it('rejects an empty command', () => {
    expect(redfishSagaPayloadSchema.safeParse({ ...VALID, command: '' }).success).toBe(false);
  });

  it('rejects an unexpected sibling secret kind (strict secrets wrapper)', () => {
    const parsed = redfishSagaPayloadSchema.safeParse({
      ...VALID,
      secrets: { bmc: SEALED_BMC, rogue: SEALED_BMC },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    expect(redfishSagaPayloadSchema.safeParse({ ...VALID, rogue: 'x' }).success).toBe(false);
  });
});
