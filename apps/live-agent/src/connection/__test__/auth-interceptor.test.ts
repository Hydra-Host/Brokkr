import { describe, expect, it, vi } from 'vitest';
import { bearerTokenInterceptor } from '.././auth-interceptor';

describe('bearerTokenInterceptor', () => {
  it('attaches Authorization: Bearer <token>', async () => {
    const next = vi.fn(async (req: { header: Headers }) => {
      expect(req.header.get('authorization')).toBe('Bearer test-token');
      return { message: {}, header: new Headers(), trailer: new Headers() };
    });
    const interceptor = bearerTokenInterceptor('test-token');
    const req = { header: new Headers() } as never;
    await interceptor(next as never)(req);
    expect(next).toHaveBeenCalledOnce();
  });

  it('overwrites any pre-existing authorization header', async () => {
    const next = vi.fn(async (req: { header: Headers }) => {
      expect(req.header.get('authorization')).toBe('Bearer fresh-token');
      return { message: {}, header: new Headers(), trailer: new Headers() };
    });
    const preset = new Headers();
    preset.set('authorization', 'Bearer stale-token');
    const interceptor = bearerTokenInterceptor('fresh-token');
    await interceptor(next as never)({ header: preset } as never);
    expect(next).toHaveBeenCalledOnce();
  });
});
