import { describe, expect, it, vi } from 'vitest';

import { getRequestClientIp } from '../client-ip.context';
import { ClientIpMiddleware, type ClientIpRequest } from '../client-ip.middleware';

function makeRequest(overrides: Partial<ClientIpRequest> = {}): ClientIpRequest {
  return { headers: {}, ...overrides };
}

describe('ClientIpMiddleware', () => {
  it('binds req.ip so getRequestClientIp reads it inside the request context', () => {
    const middleware = new ClientIpMiddleware();
    let seen: string | null = 'sentinel';
    const next = vi.fn(() => {
      seen = getRequestClientIp();
    });

    middleware.use(makeRequest({ ip: '172.16.12.50' }), {}, next);

    expect(next).toHaveBeenCalledOnce();
    expect(seen).toBe('172.16.12.50');
  });

  it('prefers req.ip over spoofable forwarding headers', () => {
    const middleware = new ClientIpMiddleware();
    let seen: string | null = null;
    middleware.use(
      makeRequest({ ip: '172.16.12.50', headers: { 'x-forwarded-for': '10.99.99.99' } }),
      {},
      () => {
        seen = getRequestClientIp();
      },
    );

    expect(seen).toBe('172.16.12.50');
  });

  it('leaves the client IP null outside any request context', () => {
    expect(getRequestClientIp()).toBeNull();
  });
});
