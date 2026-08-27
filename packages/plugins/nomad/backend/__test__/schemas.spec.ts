import { describe, expect, it } from 'vitest';

import { NomadConfigSchema } from '../../schemas';

const validConfig = {
  address: 'http://127.0.0.1:4646',
  token: 'test-acl-token',
};

describe('NomadConfigSchema', () => {
  it('accepts a minimal valid config and applies safe defaults', () => {
    const parsed = NomadConfigSchema.parse(validConfig);

    expect(parsed).toEqual({
      address: 'http://127.0.0.1:4646',
      token: 'test-acl-token',
      namespace: 'default',
      timeoutMs: 30_000,
      tlsSkipVerify: false,
      adminOrganizationId: '',
    });
  });

  it('rejects missing address and token', () => {
    const result = NomadConfigSchema.safeParse({ address: '', token: '' });

    expect(result.success).toBe(false);
    if (result.success) return;

    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('address');
    expect(paths).toContain('token');
  });

  it('rejects a non-URL address', () => {
    const result = NomadConfigSchema.safeParse({
      address: 'not-a-url',
      token: 'test-acl-token',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path[0] === 'address')).toBe(true);
  });
});
