import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { PluginOperatorGuard } from '../operator-guard';
import type { PluginOperatorPolicy, PluginRequestContext } from '../request-context';

/** Stand-in for HostPluginRequestContext.requireOperator; host spec covers the real impl. */
function applyRequireOperator(
  ctx: Pick<PluginRequestContext, 'isInstanceOperator' | 'organizationId'>,
  policy?: PluginOperatorPolicy,
): void {
  if (ctx.isInstanceOperator) return;
  const adminOrganizationId = policy?.adminOrganizationId ?? '';
  if (adminOrganizationId !== '' && ctx.organizationId === adminOrganizationId) return;
  throw new ForbiddenException('This action is restricted to the instance operator');
}

function makeCtx(
  overrides: Partial<Pick<PluginRequestContext, 'isInstanceOperator' | 'organizationId'>> = {},
): PluginRequestContext {
  const base = {
    userId: 'u-1',
    email: 'u@example.com',
    firstName: 'U',
    lastName: 'One',
    organizationId: 'other-org',
    role: 'Admin' as const,
    isInstanceOperator: false,
    authType: 'session' as const,
    requirePermission: vi.fn(),
    requireInstanceOperator: vi.fn(),
    requireSessionAuth: vi.fn(),
    ...overrides,
  };
  return {
    ...base,
    requireOperator: (policy?: PluginOperatorPolicy) => applyRequireOperator(base, policy),
  };
}

describe('PluginOperatorGuard', () => {
  it('allows instance operators', () => {
    const guard = new PluginOperatorGuard(makeCtx({ isInstanceOperator: true }), 'admin-org');
    expect(guard.canActivate()).toBe(true);
  });

  it('allows the configured admin organization when the token is set and matches', () => {
    const guard = new PluginOperatorGuard(makeCtx({ organizationId: 'admin-org' }), 'admin-org');
    expect(guard.canActivate()).toBe(true);
  });

  it('rejects when neither grant applies', () => {
    const guard = new PluginOperatorGuard(makeCtx({ organizationId: 'tenant-org' }), 'admin-org');
    expect(() => guard.canActivate()).toThrow(ForbiddenException);
  });

  it('rejects when adminOrganizationId is empty even if the caller org id is empty', () => {
    const guard = new PluginOperatorGuard(makeCtx({ organizationId: '' }), '');
    expect(() => guard.canActivate()).toThrow(ForbiddenException);
  });

  it('rejects when the admin-org token is omitted (operator-hub policy)', () => {
    const guard = new PluginOperatorGuard(makeCtx({ organizationId: 'admin-org' }));
    expect(() => guard.canActivate()).toThrow(ForbiddenException);
  });

  it('fails closed when request identity is unavailable', () => {
    const ctx = makeCtx();
    Object.defineProperty(ctx, 'isInstanceOperator', {
      get() {
        throw new UnauthorizedException('Identity context is missing');
      },
    });
    ctx.requireOperator = (policy?: PluginOperatorPolicy) => applyRequireOperator(ctx, policy);
    const guard = new PluginOperatorGuard(ctx, 'admin-org');
    expect(() => guard.canActivate()).toThrow(UnauthorizedException);
  });

  it('passes the injected admin org id through to requireOperator', () => {
    const ctx = makeCtx({ organizationId: 'admin-org' });
    const requireOperator = vi.fn();
    ctx.requireOperator = requireOperator;
    const guard = new PluginOperatorGuard(ctx, 'admin-org');
    expect(guard.canActivate()).toBe(true);
    expect(requireOperator).toHaveBeenCalledWith({ adminOrganizationId: 'admin-org' });
  });

  it('passes an empty admin org id when the token is omitted', () => {
    const ctx = makeCtx({ isInstanceOperator: true });
    const requireOperator = vi.fn();
    ctx.requireOperator = requireOperator;
    const guard = new PluginOperatorGuard(ctx);
    expect(guard.canActivate()).toBe(true);
    expect(requireOperator).toHaveBeenCalledWith({ adminOrganizationId: '' });
  });
});
