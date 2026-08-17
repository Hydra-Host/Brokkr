import { apiKey } from '@better-auth/api-key';
import { organization } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';

describe('Better Auth org route contract (guards the AuthController wildcard block)', () => {
  const endpoints = organization().endpoints;

  it('keeps every HTTP-exposed org endpoint under the /organization prefix', () => {
    const httpPaths = Object.values(endpoints)
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === 'string');
    expect(httpPaths.length).toBeGreaterThan(0);
    for (const path of httpPaths) {
      expect(path.startsWith('/organization')).toBe(true);
    }
  });
});

describe('Better Auth api-key route contract (guards the AuthController wildcard block)', () => {
  const endpoints = apiKey().endpoints;

  it('keeps every HTTP-exposed api-key endpoint under the /api-key prefix', () => {
    const httpPaths = Object.values(endpoints)
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === 'string');
    expect(httpPaths.length).toBeGreaterThan(0);
    for (const path of httpPaths) {
      expect(path.startsWith('/api-key')).toBe(true);
    }
  });
});
