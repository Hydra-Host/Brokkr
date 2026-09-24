import { describe, expect, it } from 'vitest';

import { deployTokenAtomSchema } from '../deploy-token.schema';

describe('deployTokenAtomSchema', () => {
  it('accepts valid DEPLOYMENT_OS bearer material', () => {
    const atom = deployTokenAtomSchema.parse({
      deployment_os_token: 'test-deploy-token-abc',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
    });
    expect(atom.deployment_os_token).toBe('test-deploy-token-abc');
    expect(atom.endpoint).toBe('https://hub/api/v1/bmc/phone-home');
  });

  it('rejects extra fields', () => {
    expect(() =>
      deployTokenAtomSchema.parse({
        deployment_os_token: 'test-deploy-token-abc',
        endpoint: 'https://hub/api/v1/bmc/phone-home',
        extra: 'x',
      }),
    ).toThrow();
  });

  it('rejects missing token', () => {
    expect(() => deployTokenAtomSchema.parse({ endpoint: 'https://hub/api/v1/bmc/phone-home' })).toThrow();
  });

  it('rejects missing endpoint', () => {
    expect(() => deployTokenAtomSchema.parse({ deployment_os_token: 'test-deploy-token-abc' })).toThrow();
  });

  it('rejects non-string token', () => {
    expect(() =>
      deployTokenAtomSchema.parse({ deployment_os_token: 123, endpoint: 'https://hub/api/v1/bmc/phone-home' }),
    ).toThrow();
  });

  it.each(['deployment_os_token', 'endpoint'] as const)('rejects empty %s', (field) => {
    const payload: Record<string, unknown> = {
      deployment_os_token: 'test-deploy-token-abc',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
    };
    payload[field] = '';
    expect(() => deployTokenAtomSchema.parse(payload)).toThrow();
  });

  it('rejects the BROKKR_LIVE shape (server_token, not deploy_token)', () => {
    expect(() =>
      deployTokenAtomSchema.parse({ brokkr_live_token: 'bl', endpoint: 'https://hub', exp: 1 }),
    ).toThrow();
  });
});
