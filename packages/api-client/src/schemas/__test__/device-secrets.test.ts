import { describe, expect, it } from 'vitest';
import { DeviceSecretRevealStatusResponseSchema } from '../device-secrets';

describe('DeviceSecretRevealStatusResponseSchema', () => {
  it('accepts the pending variant with null secret', () => {
    expect(DeviceSecretRevealStatusResponseSchema.safeParse({ status: 'pending', secret: null }).success).toBe(true);
  });

  it('accepts the ready variant with a non-null secret', () => {
    expect(
      DeviceSecretRevealStatusResponseSchema.safeParse({ status: 'ready', secret: { token: 'abc' } }).success,
    ).toBe(true);
  });

  it('accepts the unavailable variant with null secret', () => {
    expect(DeviceSecretRevealStatusResponseSchema.safeParse({ status: 'unavailable', secret: null }).success).toBe(
      true,
    );
  });

  it('rejects ready with a null secret', () => {
    expect(DeviceSecretRevealStatusResponseSchema.safeParse({ status: 'ready', secret: null }).success).toBe(false);
  });

  it('rejects pending with a non-null secret', () => {
    expect(
      DeviceSecretRevealStatusResponseSchema.safeParse({ status: 'pending', secret: { token: 'x' } }).success,
    ).toBe(false);
  });

  it('rejects unavailable with a non-null secret', () => {
    expect(
      DeviceSecretRevealStatusResponseSchema.safeParse({ status: 'unavailable', secret: { token: 'x' } }).success,
    ).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(DeviceSecretRevealStatusResponseSchema.safeParse({ status: 'expired', secret: null }).success).toBe(false);
  });

  it('rejects a ready secret with non-string values', () => {
    expect(DeviceSecretRevealStatusResponseSchema.safeParse({ status: 'ready', secret: { token: 42 } }).success).toBe(
      false,
    );
  });
});
