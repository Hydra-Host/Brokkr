import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { RequestSource, TenantType } from '@repo/database';
import { randomUUID } from 'crypto';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import type { DeviceIdentityContext } from 'src/device-tokens/device-tokens.types';
import { describe, expect, it, vi } from 'vitest';
import { ContextService, type RequestContext } from '../context.service';

function makeService() {
  return new ContextService(new DesignationOperatorPolicy());
}

function sessionIdentity(userId = 'user-session'): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Member' as IdentityContext['role'],
    organizationId: 'org-1',
    organization: { id: 'org-1' } as IdentityContext['organization'],
    session: { user: { id: userId, email: 'caller@example.com' } },
  } as unknown as IdentityContext;
}

function apiKeyIdentity(userId = 'user-apikey'): IdentityContext {
  return {
    authType: AuthType.ApiKey,
    role: 'Admin' as IdentityContext['role'],
    organizationId: 'org-1',
    organization: { id: 'org-1' } as IdentityContext['organization'],
    apiKey: { id: 'ak-1', name: 'ci-bot', userId },
    user: { id: userId, email: 'apikey@example.com' },
  } as unknown as IdentityContext;
}

function deviceIdentity(): DeviceIdentityContext {
  return { deviceId: 'dev-1', tokenId: 'tok-1', supplierId: 'sup-1' } as unknown as DeviceIdentityContext;
}

describe('ContextService.requireSessionUser', () => {
  it('returns the session user when email is present', () => {
    const service = makeService();
    const user = { id: randomUUID(), email: 'user@example.com', firstName: 'Ada', lastName: 'Lovelace' };
    service.run({ requestId: randomUUID(), sessionUser: user }, () => {
      expect(service.requireSessionUser).toEqual(user);
    });
  });

  it('throws 401 when the session user is missing', () => {
    const service = makeService();
    service.run({ requestId: randomUUID() }, () => {
      expect(() => service.requireSessionUser).toThrow(UnauthorizedException);
    });
  });

  it('throws 401 when the session user email is empty', () => {
    const service = makeService();
    const user = { id: randomUUID(), email: '', firstName: 'Ada', lastName: 'Lovelace' };
    service.run({ requestId: randomUUID(), sessionUser: user }, () => {
      expect(() => service.requireSessionUser).toThrow(UnauthorizedException);
    });
  });
});

describe('ContextService.actingUser', () => {
  it('returns the identity user when identity is present', () => {
    const service = makeService();
    service.run({ requestId: randomUUID(), identity: sessionIdentity('u-identity') }, () => {
      expect(service.actingUser).toEqual({ id: 'u-identity', email: 'caller@example.com' });
    });
  });

  it('returns the api-key owning user when the identity is an api key', () => {
    const service = makeService();
    service.run({ requestId: randomUUID(), identity: apiKeyIdentity('u-apikey') }, () => {
      expect(service.actingUser).toEqual({ id: 'u-apikey', email: 'apikey@example.com' });
    });
  });

  it('falls back to the session user when identity is absent', () => {
    const service = makeService();
    const sessionUser = { id: 'u-so', email: 'sessiononly@example.com', firstName: 'Ada', lastName: 'Lovelace' };
    service.run({ requestId: randomUUID(), sessionUser }, () => {
      expect(service.actingUser).toEqual(sessionUser);
    });
  });

  it('prefers identity over the session user when both are bound', () => {
    const service = makeService();
    const sessionUser = { id: 'u-so', email: 'sessiononly@example.com', firstName: 'Ada', lastName: 'Lovelace' };
    service.run({ requestId: randomUUID(), identity: sessionIdentity('u-identity'), sessionUser }, () => {
      expect(service.actingUser).toEqual({ id: 'u-identity', email: 'caller@example.com' });
    });
  });

  it('throws 401 when neither identity nor a session user is bound', () => {
    const service = makeService();
    service.run({ requestId: randomUUID() }, () => {
      expect(() => service.actingUser).toThrow(UnauthorizedException);
    });
  });
});

describe('ContextService.resolveActor', () => {
  function resolveIn(context: RequestContext) {
    const svc = makeService();
    let result!: ReturnType<ContextService['resolveActor']>;
    svc.run(context, () => {
      result = svc.resolveActor();
    });
    return result;
  }

  it('attributes a session caller to UI with the session user id', () => {
    expect(resolveIn({ requestId: 'r', identity: sessionIdentity('u-7') })).toEqual({
      actorId: 'u-7',
      actorType: RequestSource.UI,
      actorLabel: 'caller@example.com',
      apiKeyId: null,
      apiKeyLabel: null,
    });
  });

  it('attributes an api-key caller to the owning user and names the key', () => {
    expect(resolveIn({ requestId: 'r', identity: apiKeyIdentity('u-9') })).toEqual({
      actorId: 'u-9',
      actorType: RequestSource.API,
      actorLabel: 'apikey@example.com',
      apiKeyId: 'ak-1',
      apiKeyLabel: 'ci-bot',
    });
  });

  it('attributes a device caller to DEVICE with a null actor id', () => {
    expect(resolveIn({ requestId: 'r', deviceIdentity: deviceIdentity() })).toEqual({
      actorId: null,
      actorType: RequestSource.DEVICE,
      actorLabel: 'dev-1',
      apiKeyId: null,
      apiKeyLabel: null,
    });
  });

  it('attributes a session-only caller to the real user, not SYSTEM', () => {
    const sessionUser = { id: 'u-so', email: 'sessiononly@example.com', firstName: 'Ada', lastName: 'Lovelace' };
    expect(resolveIn({ requestId: 'r', sessionUser })).toEqual({
      actorId: 'u-so',
      actorType: RequestSource.UI,
      actorLabel: 'sessiononly@example.com',
      apiKeyId: null,
      apiKeyLabel: null,
    });
  });

  it('attributes a principal-less context to SYSTEM rather than a null type', () => {
    expect(resolveIn({ requestId: 'r' })).toEqual({
      actorId: null,
      actorType: RequestSource.SYSTEM,
      actorLabel: null,
      apiKeyId: null,
      apiKeyLabel: null,
    });
  });

  it('exposes the same shape through actorFields', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: sessionIdentity('u-7') }, () => {
      expect(svc.actorFields()).toEqual(svc.resolveActor());
    });
  });
});

describe('ContextService.requestFields', () => {
  it('returns the request provenance held on the store', () => {
    const svc = makeService();
    svc.run(
      {
        requestId: 'r',
        method: 'POST',
        path: '/api/v1/zones/z-1',
        ipAddress: '203.0.113.7',
        userAgent: 'brokkr-cli/1.2.3',
      },
      () => {
        expect(svc.requestFields()).toEqual({
          method: 'POST',
          path: '/api/v1/zones/z-1',
          ipAddress: '203.0.113.7',
          userAgent: 'brokkr-cli/1.2.3',
        });
      },
    );
  });

  it('returns nulls when the store carries no request information', () => {
    const svc = makeService();
    svc.run({ requestId: 'r' }, () => {
      expect(svc.requestFields()).toEqual({ method: null, path: null, ipAddress: null, userAgent: null });
    });
  });

  it('returns nulls under runAsSystem', () => {
    const svc = makeService();
    svc.runAsSystem('org-sys', () => {
      expect(svc.requestFields()).toEqual({ method: null, path: null, ipAddress: null, userAgent: null });
    });
  });

  it('returns nulls outside of any store', () => {
    expect(makeService().requestFields()).toEqual({ method: null, path: null, ipAddress: null, userAgent: null });
  });

  it('leaves actorFields untouched for a request carrying provenance', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: sessionIdentity('u-9'), method: 'GET', path: '/api/v1/zones' }, () => {
      expect(svc.actorFields()).toEqual({
        actorType: RequestSource.UI,
        actorId: 'u-9',
        actorLabel: 'caller@example.com',
        apiKeyId: null,
        apiKeyLabel: null,
      });
    });
  });
});

describe('ContextService.organizationIdOrUndefined', () => {
  it('returns the identity organization', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: sessionIdentity() }, () => {
      expect(svc.organizationIdOrUndefined).toBe('org-1');
    });
  });

  it('returns the system organization under runAsSystem', () => {
    const svc = makeService();
    svc.runAsSystem('org-sys', () => {
      expect(svc.organizationIdOrUndefined).toBe('org-sys');
    });
  });

  it('returns the supplier organization for a device-authenticated context', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', deviceIdentity: deviceIdentity() }, () => {
      expect(svc.organizationIdOrUndefined).toBe('sup-1');
    });
  });

  it('prefers the device supplier over the identity organization, matching buildAuditPayload', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: sessionIdentity(), deviceIdentity: deviceIdentity() }, () => {
      expect(svc.organizationIdOrUndefined).toBe('sup-1');
      expect(svc.buildAuditPayload().organizationId).toBe('sup-1');
    });
  });

  it('falls back to the identity organization when the device has no supplier', () => {
    const svc = makeService();
    const device = { ...deviceIdentity(), supplierId: null };
    svc.run({ requestId: 'r', identity: sessionIdentity(), deviceIdentity: device }, () => {
      expect(svc.organizationIdOrUndefined).toBe('org-1');
    });
  });

  it('returns undefined instead of throwing when no principal is in scope', () => {
    const svc = makeService();
    svc.run({ requestId: 'r' }, () => {
      expect(svc.organizationIdOrUndefined).toBeUndefined();
      expect(() => svc.organizationId).toThrow();
    });
  });
});

describe('ContextService permission intents', () => {
  function permissionIdentity(permissions: string[]): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Member' as IdentityContext['role'],
      organizationId: 'org-1',
      organization: { id: 'org-1' } as IdentityContext['organization'],
      permissions: new Set(permissions),
      session: { user: { id: 'u-1', email: 'caller@example.com' } },
    } as unknown as IdentityContext;
  }

  it('records an allowed check and returns a handle', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: permissionIdentity(['device:update']) }, () => {
      const handle = svc.requirePermission('device', 'update');

      expect(handle).toBeDefined();
      expect(svc.drainIntents()).toEqual([
        expect.objectContaining({ resource: 'device', action: 'update', denied: false }),
      ]);
    });
  });

  it('records a denied check before throwing', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: permissionIdentity([]) }, () => {
      expect(() => svc.requirePermission('device', 'update')).toThrow(ForbiddenException);

      expect(svc.drainIntents()).toEqual([expect.objectContaining({ denied: true })]);
    });
  });

  it('omits finalized intents from the drain', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: permissionIdentity(['device:update']) }, () => {
      const handle = svc.requirePermission('device', 'update');
      svc.finalizeIntents([handle!]);

      expect(svc.drainIntents()).toEqual([]);
    });
  });

  it('leaves unrelated intents pending when one is finalized', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: permissionIdentity(['device:update', 'member:delete']) }, () => {
      const first = svc.requirePermission('device', 'update');
      svc.requirePermission('member', 'delete');
      svc.finalizeIntents([first!]);

      expect(svc.drainIntents()).toEqual([expect.objectContaining({ resource: 'member' })]);
    });
  });

  it('drains once so a second pass cannot double-write', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: permissionIdentity(['device:update']) }, () => {
      svc.requirePermission('device', 'update');

      expect(svc.drainIntents()).toHaveLength(1);
      expect(svc.drainIntents()).toEqual([]);
    });
  });

  it('returns undefined and records nothing outside a request scope', () => {
    const svc = makeService();

    expect(svc.pushIntent('device', 'update', false)).toBeUndefined();
    expect(svc.drainIntents()).toEqual([]);
  });
});

describe('ContextService.requireSupplyOrganization', () => {
  function tenantIdentity(tenantType: TenantType): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Member' as IdentityContext['role'],
      organizationId: 'org-1',
      organization: { id: 'org-1', tenantType } as IdentityContext['organization'],
      session: { user: { id: 'u', email: 'caller@example.com' } },
    } as unknown as IdentityContext;
  }

  it('passes and reports true for a supply tenant', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: tenantIdentity(TenantType.SupplyCustomer) }, () => {
      expect(() => svc.requireSupplyOrganization()).not.toThrow();
    });
  });

  it('throws 403 and reports false for a demand tenant', () => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: tenantIdentity(TenantType.DemandCustomer) }, () => {
      expect(() => svc.requireSupplyOrganization()).toThrow(ForbiddenException);
    });
  });

  it('throws 401 fail-closed when no identity is in scope', () => {
    const svc = makeService();
    svc.run({ requestId: 'r' }, () => {
      expect(() => svc.requireSupplyOrganization()).toThrow(UnauthorizedException);
    });
  });
});

describe('ContextService.runAsSystem', () => {
  it('flags the store as system with the given org and returns the callback result', () => {
    const svc = makeService();
    const result = svc.runAsSystem('org-9', () => {
      expect(svc.isSystem).toBe(true);
      expect(svc.systemOrganizationId).toBe('org-9');
      expect(svc.organizationId).toBe('org-9');
      return 42;
    });
    expect(result).toBe(42);
  });

  it('isSystem is false outside a system scope', () => {
    const svc = makeService();
    svc.run({ requestId: 'r' }, () => {
      expect(svc.isSystem).toBe(false);
    });
  });

  it('preserves an existing requestId for log correlation', () => {
    const svc = makeService();
    svc.run({ requestId: 'req-abc' }, () => {
      svc.runAsSystem('org-9', () => {
        expect(svc.requestId).toBe('req-abc');
        expect(svc.isSystem).toBe(true);
      });
    });
  });
});

describe('ContextService.requirePermission / hasPermission gate', () => {
  function identityWithPerms(perms: string[]): IdentityContext {
    return {
      authType: AuthType.ApiKey,
      role: 'Member',
      assignedRoleId: 'role-member',
      organizationId: 'org-1',
      organization: { id: 'org-1' },
      permissions: new Set(perms),
      apiKey: { id: 'ak-1', userId: 'u1' },
      user: { id: 'u1', email: 'a@example.com' },
    } as unknown as IdentityContext;
  }

  const withIdentity = (perms: string[], fn: (svc: ContextService) => void) => {
    const svc = makeService();
    svc.run({ requestId: 'r', identity: identityWithPerms(perms) }, () => fn(svc));
  };

  it('passes when the caller holds the exact resource:action', () => {
    withIdentity(['zone:read'], (svc) => {
      expect(svc.hasPermission('zone', 'read')).toBe(true);
      expect(() => svc.requirePermission('zone', 'read')).not.toThrow();
    });
  });

  it('throws ForbiddenException when the caller lacks the permission', () => {
    withIdentity(['zone:read'], (svc) => {
      expect(svc.hasPermission('zone', 'delete')).toBe(false);
      expect(() => svc.requirePermission('zone', 'delete')).toThrow(ForbiddenException);
    });
  });

  it('matches resource AND action exactly — a held read does not satisfy update on the same resource', () => {
    withIdentity(['zone:read'], (svc) => {
      expect(() => svc.requirePermission('zone', 'update')).toThrow(ForbiddenException);
    });
  });

  it('does not let one resource’s permission satisfy another resource with the same action', () => {
    withIdentity(['zone:read'], (svc) => {
      expect(svc.hasPermission('device', 'read')).toBe(false);
      expect(() => svc.requirePermission('device', 'read')).toThrow(ForbiddenException);
    });
  });

  it('an empty permission set denies everything', () => {
    withIdentity([], (svc) => {
      expect(() => svc.requirePermission('api-key', 'read')).toThrow(ForbiddenException);
    });
  });

  it('a trusted system context bypasses the gate even with no permissions', () => {
    const svc = makeService();
    svc.runAsSystem('org-9', () => {
      expect(svc.hasPermission('zone', 'delete')).toBe(true);
      expect(() => svc.requirePermission('zone', 'delete')).not.toThrow();
    });
  });

  it('fails closed with UnauthorizedException when no identity is bound (not a silent allow)', () => {
    const svc = makeService();
    svc.run({ requestId: 'r' }, () => {
      expect(() => svc.requirePermission('zone', 'read')).toThrow(UnauthorizedException);
    });
  });
});

describe('ContextService system intent drain', () => {
  function withFinalizer() {
    const finalize = vi.fn().mockResolvedValue(undefined);
    const svc = makeService();
    svc.setSystemIntentFinalizer({ finalize });
    return { svc, finalize };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const keysOf = (finalize: ReturnType<typeof vi.fn>) =>
    finalize.mock.calls.flatMap(([input]) =>
      input.intents.map((i: { resource: string; action: string }) => `${i.resource}:${i.action}`),
    );

  it('finalizes a mutating intent raised inside an async scope, against the explicit org', async () => {
    const { svc, finalize } = withFinalizer();

    await svc.runAsSystem('org-sys', async () => {
      svc.requirePermission('ipam', 'create');
    });

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-sys', requestId: 'system', error: undefined }),
    );
    expect(keysOf(finalize)).toEqual(['ipam:create']);
  });

  it('returns a synchronous callback value without wrapping it in a promise', async () => {
    const { svc, finalize } = withFinalizer();

    const result = svc.runAsSystem('org-sys', () => {
      svc.requirePermission('ipam', 'create');
      return 42;
    });

    expect(result).toBe(42);
    await flush();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(keysOf(finalize)).toEqual(['ipam:create']);
  });

  it('resolves the async callback only after finalization completes', async () => {
    const { svc, finalize } = withFinalizer();
    const order: string[] = [];
    finalize.mockImplementation(async () => {
      order.push('finalized');
    });

    await svc.runAsSystem('org-sys', async () => {
      svc.requirePermission('ipam', 'create');
    });
    order.push('resolved');

    expect(order).toEqual(['finalized', 'resolved']);
  });

  it('finalizes with the error and rethrows when the async callback rejects', async () => {
    const { svc, finalize } = withFinalizer();
    const boom = new NotFoundException('gone');

    await expect(
      svc.runAsSystem('org-sys', async () => {
        svc.requirePermission('ipam', 'create');
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ error: boom }));
  });

  it('finalizes with the error and rethrows when the synchronous callback throws', async () => {
    const { svc, finalize } = withFinalizer();
    const boom = new NotFoundException('gone');

    expect(() =>
      svc.runAsSystem('org-sys', () => {
        svc.requirePermission('ipam', 'create');
        throw boom;
      }),
    ).toThrow(boom);

    await flush();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ error: boom }));
  });

  it('finalizes with the error when a non-native thenable rejects', async () => {
    const { svc, finalize } = withFinalizer();
    const boom = new NotFoundException('gone');
    const thenable = {
      then(_onFulfilled: (value: unknown) => void, onRejected: (reason: unknown) => void) {
        queueMicrotask(() => onRejected(boom));
      },
    };

    await expect(
      svc.runAsSystem('org-sys', () => {
        svc.requirePermission('ipam', 'create');
        return thenable;
      }),
    ).rejects.toBe(boom);

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ error: boom }));
  });

  it('adopts a non-native thenable that resolves, finalizing once it settles', async () => {
    const { svc, finalize } = withFinalizer();
    const thenable = {
      then(onFulfilled: (value: unknown) => void) {
        queueMicrotask(() => onFulfilled('late'));
      },
    };

    await expect(
      svc.runAsSystem('org-sys', () => {
        svc.requirePermission('ipam', 'create');
        return thenable;
      }),
    ).resolves.toBe('late');

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ error: undefined }));
  });

  it('drops a read-only intent, leaving nothing to finalize for a scope that only read', async () => {
    const { svc, finalize } = withFinalizer();

    await svc.runAsSystem('org-sys', async () => {
      svc.requirePermission('ipam', 'read');
    });

    expect(finalize).not.toHaveBeenCalled();
  });

  it('leaves the scope store empty, so a second scope never re-finalizes the first one’s intents', async () => {
    const { svc, finalize } = withFinalizer();

    await svc.runAsSystem('org-sys', async () => {
      svc.requirePermission('ipam', 'create');
    });
    await svc.runAsSystem('org-sys', async () => {
      svc.requirePermission('ipam', 'update');
    });

    expect(finalize).toHaveBeenCalledTimes(2);
    expect(keysOf(finalize)).toEqual(['ipam:create', 'ipam:update']);
  });

  it('finalizes once when nested in a request and leaves that request’s intents intact', async () => {
    const { svc, finalize } = withFinalizer();
    let outerRemaining: string[] = [];

    await new Promise<void>((resolve, reject) => {
      svc.run({ requestId: 'req-outer', identity: sessionIdentity() }, () => {
        svc.pushIntent('device', 'update', false);
        svc
          .runAsSystem('org-sys', async () => {
            svc.requirePermission('ipam', 'create');
          })
          .then(() => {
            outerRemaining = svc.drainIntents().map((i) => `${i.resource}:${i.action}`);
          })
          .then(resolve, reject);
      });
    });

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(keysOf(finalize)).toEqual(['ipam:create']);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-outer' }));
    expect(outerRemaining).toEqual(['device:update']);
  });

  it('is a no-op when no finalizer has been wired', async () => {
    const svc = makeService();

    await expect(
      svc.runAsSystem('org-sys', async () => {
        svc.requirePermission('ipam', 'create');
        return 'ok';
      }),
    ).resolves.toBe('ok');
  });
});
