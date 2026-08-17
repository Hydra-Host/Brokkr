import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AuthType, type IdentityContext } from '../../auth/identity-context';
import { DesignationOperatorPolicy } from '../../common/authz/operator-policy';
import { ContextService } from '../../common/context/context.service';
import { HostPluginRequestContext } from '../host-plugin-request-context';

function sessionIdentity(
  overrides: Partial<{ role: string; orgId: string; email: string; userId: string; permissions: Set<string> }> = {},
): IdentityContext {
  return {
    authType: AuthType.Session,
    role: (overrides.role ?? 'Member') as IdentityContext['role'],
    organizationId: overrides.orgId ?? 'org-1',
    organization: { id: overrides.orgId ?? 'org-1' } as IdentityContext['organization'],
    permissions: overrides.permissions ?? new Set<string>(),
    session: {
      user: {
        id: overrides.userId ?? 'user-1',
        email: overrides.email ?? 'caller@example.com',
        firstName: 'First',
        lastName: 'Last',
      },
    },
  } as unknown as IdentityContext;
}

function apiKeyIdentity(): IdentityContext {
  return {
    authType: AuthType.ApiKey,
    role: 'Admin' as IdentityContext['role'],
    organizationId: 'org-1',
    organization: { id: 'org-1' } as IdentityContext['organization'],
    apiKey: { id: 'ak-1', userId: 'user-1' },
    user: { id: 'user-1', email: 'apikey@example.com', firstName: 'Api', lastName: 'Key' },
  } as unknown as IdentityContext;
}

function runWith(identity: IdentityContext | undefined, body: (ctx: HostPluginRequestContext) => void): void {
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const requestCtx = new HostPluginRequestContext(contextService);
  contextService.run({ requestId: 'req-1', identity }, () => body(requestCtx));
}

describe('HostPluginRequestContext', () => {
  it('returns identity fields for a session-authenticated caller', () => {
    runWith(sessionIdentity({ userId: 'u-7', email: 'a@b.com', orgId: 'org-x' }), (ctx) => {
      expect(ctx.userId).toBe('u-7');
      expect(ctx.email).toBe('a@b.com');
      expect(ctx.firstName).toBe('First');
      expect(ctx.lastName).toBe('Last');
      expect(ctx.organizationId).toBe('org-x');
      expect(ctx.authType).toBe('session');
    });
  });

  it('reports authType "api-key" for API key auth', () => {
    runWith(apiKeyIdentity(), (ctx) => {
      expect(ctx.authType).toBe('api-key');
      expect(ctx.email).toBe('apikey@example.com');
    });
  });

  it('throws UnauthorizedException when no identity is bound', () => {
    runWith(undefined, (ctx) => {
      expect(() => ctx.userId).toThrow(UnauthorizedException);
      expect(() => ctx.email).toThrow(UnauthorizedException);
      expect(() => ctx.organizationId).toThrow(UnauthorizedException);
    });
  });

  it('requirePermission permits a held permission and rejects a missing one', () => {
    runWith(sessionIdentity({ permissions: new Set(['zone:read']) }), (ctx) => {
      expect(() => ctx.requirePermission('zone', 'read')).not.toThrow();
      expect(() => ctx.requirePermission('zone', 'delete')).toThrow(ForbiddenException);
    });
  });

  it('requireSessionAuth allows session callers, rejects API key callers', () => {
    runWith(sessionIdentity(), (ctx) => {
      expect(() => ctx.requireSessionAuth()).not.toThrow();
    });
    runWith(apiKeyIdentity(), (ctx) => {
      expect(() => ctx.requireSessionAuth()).toThrow(ForbiddenException);
    });
  });
});
