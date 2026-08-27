import type { PluginRateLimiter } from '@hydrahost/plugin-sdk';
import { PluginRateLimit, PluginRateLimitGuard } from '@hydrahost/plugin-sdk/nest';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { describe, expect, it, vi } from 'vitest';

class LimitedController {
  @PluginRateLimit({ name: 'leads', limit: 10, windowSeconds: 60 })
  handler() {}
}

class UnconfiguredController {
  handler() {}
}

function makeContext(controller: typeof LimitedController | typeof UnconfiguredController, ip?: string) {
  const request = ip ? { ip } : {};
  const response = { setHeader: vi.fn() };
  const context = new ExecutionContextHost([request, response], controller, controller.prototype.handler);
  context.setType('http');
  return { context, response };
}

function makeLimiter(result = { allowed: true, remaining: 9, retryAfterSeconds: 60 }) {
  return { consume: vi.fn().mockResolvedValue(result) } satisfies PluginRateLimiter;
}

describe('PluginRateLimitGuard', () => {
  it('uses the route policy and request IP', async () => {
    const limiter = makeLimiter();
    const { context } = makeContext(LimitedController, '203.0.113.1');

    await expect(new PluginRateLimitGuard(limiter).canActivate(context)).resolves.toBe(true);
    expect(limiter.consume).toHaveBeenCalledWith({
      name: 'leads',
      subject: '203.0.113.1',
      limit: 10,
      windowSeconds: 60,
    });
  });

  it('returns 429 with retry-after when the limit is exceeded', async () => {
    const limiter = makeLimiter({ allowed: false, remaining: 0, retryAfterSeconds: 42 });
    const { context, response } = makeContext(LimitedController, '203.0.113.1');

    await expect(new PluginRateLimitGuard(limiter).canActivate(context)).rejects.toMatchObject({ status: 429 });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('fails closed when the request IP is unavailable', async () => {
    const limiter = makeLimiter();
    const { context } = makeContext(LimitedController);

    await expect(new PluginRateLimitGuard(limiter).canActivate(context)).rejects.toMatchObject({ status: 500 });
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it('fails when the guard has no route policy', async () => {
    const limiter = makeLimiter();
    const { context } = makeContext(UnconfiguredController, '203.0.113.1');

    await expect(new PluginRateLimitGuard(limiter).canActivate(context)).rejects.toMatchObject({ status: 500 });
  });
});
