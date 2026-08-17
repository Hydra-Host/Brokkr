import { describe, expect, it } from 'vitest';

import { serverTokenAtomSchema } from '../server-token.schema';

describe('serverTokenAtomSchema', () => {
  it('accepts valid Brokkr Live bearer material', () => {
    const atom = serverTokenAtomSchema.parse({
      brokkr_live_token: 'test-live-token-abc',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
      exp: 1_730_000_000,
    });
    expect(atom.brokkr_live_token).toBe('test-live-token-abc');
    expect(atom.endpoint).toBe('https://hub/api/v1/bmc/phone-home');
    expect(atom.exp).toBe(1_730_000_000);
  });

  it('rejects extra fields', () => {
    expect(() =>
      serverTokenAtomSchema.parse({
        brokkr_live_token: 'test-live-token-abc',
        endpoint: 'https://hub/api/v1/bmc/phone-home',
        exp: 1_730_000_000,
        extra: 'x',
      }),
    ).toThrow();
  });

  it('rejects missing token', () => {
    expect(() => serverTokenAtomSchema.parse({ endpoint: 'https://hub/api/v1/bmc/phone-home', exp: 1 })).toThrow();
  });

  it('rejects missing endpoint', () => {
    expect(() => serverTokenAtomSchema.parse({ brokkr_live_token: 'test-live-token-abc', exp: 1 })).toThrow();
  });

  it('rejects non-string token', () => {
    expect(() =>
      serverTokenAtomSchema.parse({ brokkr_live_token: 123, endpoint: 'https://hub/api/v1/bmc/phone-home', exp: 1 }),
    ).toThrow();
  });

  it('rejects non-number exp', () => {
    expect(() =>
      serverTokenAtomSchema.parse({
        brokkr_live_token: 'test-live-token-abc',
        endpoint: 'https://hub/api/v1/bmc/phone-home',
        exp: '1',
      }),
    ).toThrow();
  });

  it.each(['brokkr_live_token', 'endpoint'] as const)('rejects empty %s', (field) => {
    const payload: Record<string, unknown> = {
      brokkr_live_token: 'test-live-token-abc',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
      exp: 1,
    };
    payload[field] = '';
    expect(() => serverTokenAtomSchema.parse(payload)).toThrow();
  });

  it('rejects legacy cipher/signature shape', () => {
    expect(() => serverTokenAtomSchema.parse({ cipher: 'c', signature: 's' })).toThrow();
  });
});
