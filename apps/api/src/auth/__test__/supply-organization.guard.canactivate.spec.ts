import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ContextService } from 'src/common/context/context.service';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SupplyOrganizationGuard } from '../guards/supply-organization.guard';

const handler = () => undefined;
class FakeController {}

function makeExecutionContext(): ExecutionContext {
  return {
    getHandler: vi.fn().mockReturnValue(handler),
    getClass: vi.fn().mockReturnValue(FakeController),
  } as unknown as ExecutionContext;
}

function makeGuard(opts: { isPublic?: boolean; requireThrows?: Error } = {}) {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(opts.isPublic),
  } as unknown as Reflector;

  const requireSupplyOrganization = vi.fn(() => {
    if (opts.requireThrows) throw opts.requireThrows;
  });
  const contextService = { requireSupplyOrganization } as unknown as ContextService;

  const guard = new SupplyOrganizationGuard(reflector, contextService);
  return { guard, reflector, requireSupplyOrganization };
}

describe('SupplyOrganizationGuard.canActivate', () => {
  it('returns true and skips requireSupplyOrganization for @Public routes', () => {
    const { guard, requireSupplyOrganization } = makeGuard({ isPublic: true });

    expect(guard.canActivate(makeExecutionContext())).toBe(true);
    expect(requireSupplyOrganization).not.toHaveBeenCalled();
  });

  it('reads IS_PUBLIC_KEY against the handler and class', () => {
    const { guard, reflector } = makeGuard({ isPublic: true });
    const context = makeExecutionContext();

    guard.canActivate(context);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
  });

  it('enforces supply-org access and returns true when not public (false)', () => {
    const { guard, requireSupplyOrganization } = makeGuard({ isPublic: false });

    expect(guard.canActivate(makeExecutionContext())).toBe(true);
    expect(requireSupplyOrganization).toHaveBeenCalledTimes(1);
  });

  it('enforces supply-org access when the public flag is undefined', () => {
    const { guard, requireSupplyOrganization } = makeGuard({ isPublic: undefined });

    expect(guard.canActivate(makeExecutionContext())).toBe(true);
    expect(requireSupplyOrganization).toHaveBeenCalledTimes(1);
  });

  it('propagates ForbiddenException thrown by requireSupplyOrganization', () => {
    const { guard } = makeGuard({ isPublic: false, requireThrows: new ForbiddenException() });

    expect(() => guard.canActivate(makeExecutionContext())).toThrow(ForbiddenException);
  });
});
