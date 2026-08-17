import { ExecutionContext, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationMembershipRole } from '@repo/database';
import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { IS_SESSION_ONLY_KEY } from '../decorators/session-only.decorator';
import { AuthType } from '../identity-context';
import { UnifiedIdentityGuard } from '../unified-identity.guard';

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const API_KEY_ID = randomUUID();

function makeApiKey(overrides: Record<string, unknown> = {}) {
  return {
    id: API_KEY_ID,
    key: 'test_key_value',
    referenceId: USER_ID,
    name: 'Test Key',
    start: null,
    prefix: null,
    enabled: true,
    permissions: null,
    metadata: { organizationId: ORG_ID },
    ...overrides,
  };
}

function makeVerifyApiKeyResult(key: ReturnType<typeof makeApiKey>) {
  return {
    valid: true,
    error: null,
    key,
  };
}

function makeMember() {
  const now = new Date();
  return {
    id: randomUUID(),
    userId: USER_ID,
    organizationId: ORG_ID,
    role: OrganizationMembershipRole.Member,
    assignedRoleId: 'role-member',
    createdAt: now,
    updatedAt: now,
    user: {
      id: USER_ID,
      name: 'Test User',
      email: 'test@example.com',
      banned: false,
      banExpires: null,
    },
    organization: {
      id: ORG_ID,
      name: 'Test Org',
      slug: 'test-org',
      logo: null,
      metadata: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      members: [],
    },
  };
}

function makeSession(overrides: { activeOrganizationId?: string | null; userId?: string } = {}) {
  return {
    session: { activeOrganizationId: 'activeOrganizationId' in overrides ? overrides.activeOrganizationId : ORG_ID },
    user: { id: overrides.userId ?? USER_ID, name: 'Test User', email: 'test@example.com' },
  };
}

function makeExecutionContext(headers: Record<string, string> = { 'x-api-key': 'test_key_value' }): ExecutionContext {
  return {
    getHandler: vi.fn(),
    getClass: vi.fn(),
    switchToHttp: vi.fn().mockReturnValue({
      getRequest: vi.fn().mockReturnValue({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(
  verifyApiKeyResult: ReturnType<typeof makeVerifyApiKeyResult> | null,
  memberResult: ReturnType<typeof makeMember> | null = makeMember(),
  opts: {
    session?: unknown;
    bannedUser?: { banned: boolean; banExpires: Date | null } | null;
    sessionOnly?: boolean;
    apiKeyOrgColumn?: string | null;
    apiKeyStoredPermissions?: unknown;
    memberPermissions?: string[];
  } = {},
) {
  const authClient = {
    api: {
      verifyApiKey: vi.fn().mockResolvedValue(verifyApiKeyResult),
      getSession: vi.fn().mockResolvedValue(opts.session ?? null),
    },
  };

  const repo = {
    findOrganizationMember: vi.fn().mockResolvedValue(memberResult),
  };

  const apiKeyOrgColumn = 'apiKeyOrgColumn' in opts ? opts.apiKeyOrgColumn : ORG_ID;
  const apiKeyStoredPermissions =
    'apiKeyStoredPermissions' in opts ? opts.apiKeyStoredPermissions : verifyApiKeyResult?.key?.permissions;
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue(opts.bannedUser ?? null) },
    apiKey: {
      findUnique: vi.fn().mockResolvedValue({
        organizationId: apiKeyOrgColumn,
        permissions: apiKeyStoredPermissions,
      }),
    },
  };

  const reflector = {
    getAllAndOverride: vi.fn((key: unknown) => Boolean(opts.sessionOnly) && key === IS_SESSION_ONLY_KEY),
  } as unknown as Reflector;

  const identitySetter = vi.fn();
  const contextService = {};
  Object.defineProperty(contextService, 'identity', {
    set: identitySetter,
    get: vi.fn(),
    configurable: true,
  });

  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  };

  const rbacResolver = {
    resolveEffectivePermissions: vi.fn().mockResolvedValue(new Set<string>(opts.memberPermissions ?? [])),
  };

  const guard = new UnifiedIdentityGuard(
    authClient as any,
    repo as any,
    prisma as any,
    reflector,
    contextService as any,
    rbacResolver as any,
    { get: vi.fn() } as any,
    logger as any,
  );

  return { guard, authClient, repo, prisma, logger, identitySetter };
}

describe('UnifiedIdentityGuard — API key path', () => {
  it('allows access when the api-key row has a server-assigned organizationId', async () => {
    const key = makeApiKey();
    const { guard } = makeGuard(makeVerifyApiKeyResult(key));

    const result = await guard.canActivate(makeExecutionContext());

    expect(result).toBe(true);
  });

  it('rejects a key whose prisma organizationId column is null (metadata-minted key)', async () => {
    const key = makeApiKey({ metadata: { organizationId: ORG_ID } });
    const { guard, logger } = makeGuard(makeVerifyApiKeyResult(key), makeMember(), { apiKeyOrgColumn: null });

    await expect(guard.canActivate(makeExecutionContext())).rejects.toThrow(UnauthorizedException);
    expect(logger.error).toHaveBeenCalledWith('API key has no server-assigned organization');
  });

  it('scopes the key by the prisma column and ignores client-supplied metadata', async () => {
    const key = makeApiKey({ metadata: { organizationId: 'attacker-supplied-org' } });
    const { guard, repo } = makeGuard(makeVerifyApiKeyResult(key));

    await guard.canActivate(makeExecutionContext());

    expect(repo.findOrganizationMember).toHaveBeenCalledWith(USER_ID, ORG_ID);
  });

  it('scopes a key to the live intersection of its permissions and the member’s current set', async () => {
    const key = makeApiKey({ permissions: { device: ['read'], 'device-secret': ['access'] } });
    const { guard, identitySetter } = makeGuard(makeVerifyApiKeyResult(key), makeMember(), {
      memberPermissions: ['device:read', 'deployment:create'],
    });

    await guard.canActivate(makeExecutionContext());

    const identity = identitySetter.mock.calls[0][0];
    expect([...identity.permissions]).toEqual(['device:read']);
  });

  it.each([null, {}, '{}'])(
    'a key with inheritance marker %j uses the owner’s full live permissions',
    async (permissions) => {
      const key = makeApiKey({ permissions });
      const { guard, identitySetter } = makeGuard(makeVerifyApiKeyResult(key), makeMember(), {
        memberPermissions: ['device:read', 'deployment:create', 'api-key:update', 'organization:manage-owners'],
      });

      await guard.canActivate(makeExecutionContext());

      const identity = identitySetter.mock.calls[0][0];
      expect([...identity.permissions]).toEqual([
        'device:read',
        'deployment:create',
        'api-key:update',
        'organization:manage-owners',
      ]);
    },
  );

  it.each([
    ['malformed JSON', '{invalid'],
    ['non-object JSON', '["device:read"]'],
    ['array value', { device: 'read' }],
  ])('a key with %s scope fails closed to zero permissions', async (_label, permissions) => {
    const key = makeApiKey({ permissions: null });
    const { guard, identitySetter, logger } = makeGuard(makeVerifyApiKeyResult(key), makeMember(), {
      memberPermissions: ['device:read', 'deployment:create'],
      apiKeyStoredPermissions: permissions,
    });

    await guard.canActivate(makeExecutionContext());

    expect([...identitySetter.mock.calls[0][0].permissions]).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('API key has malformed permission scope');
  });

  it('rejects with 401 when API key verification fails', async () => {
    const { guard } = makeGuard({ valid: false, error: null, key: null } as any);

    await expect(guard.canActivate(makeExecutionContext())).rejects.toThrow(UnauthorizedException);
  });

  it('throws 429 when API key is rate limited', async () => {
    const { guard } = makeGuard({
      valid: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      key: null,
    } as any);

    await expect(guard.canActivate(makeExecutionContext())).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('rejects when API key owner is not a member of the organization', async () => {
    const key = makeApiKey();
    const { guard } = makeGuard(makeVerifyApiKeyResult(key), null);

    await expect(guard.canActivate(makeExecutionContext())).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when API key owner belongs to a deleted organization', async () => {
    const key = makeApiKey();
    const member = makeMember();
    member.organization.deletedAt = new Date();
    const { guard } = makeGuard(makeVerifyApiKeyResult(key), member);

    await expect(guard.canActivate(makeExecutionContext())).rejects.toThrow(HttpException);
  });

  it('returns true for public routes without authentication', async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValueOnce(true),
    } as unknown as Reflector;

    const guard = new UnifiedIdentityGuard(
      {} as any,
      {} as any,
      {} as any,
      reflector,
      {} as any,
      {} as any,
      { get: vi.fn() } as any,
      { error: vi.fn(), warn: vi.fn() } as any,
    );

    const result = await guard.canActivate(makeExecutionContext());

    expect(result).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith('isPublic', expect.any(Array));
  });

  it('sets identity context with organizationId sourced from the prisma column', async () => {
    const key = makeApiKey({ metadata: { organizationId: ORG_ID } });
    const identitySetter = vi.fn();
    const { guard } = makeGuard(makeVerifyApiKeyResult(key));

    const contextService = (guard as any).contextService;
    Object.defineProperty(contextService, 'identity', {
      set: identitySetter,
      configurable: true,
    });

    await guard.canActivate(makeExecutionContext());

    expect(identitySetter).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: AuthType.ApiKey,
        organizationId: ORG_ID,
      }),
    );
  });

  it('enriches the apiKey in identity context with organizationId from the prisma column', async () => {
    const key = makeApiKey({ metadata: { organizationId: ORG_ID } });
    const identitySetter = vi.fn();
    const { guard } = makeGuard(makeVerifyApiKeyResult(key));

    const contextService = (guard as any).contextService;
    Object.defineProperty(contextService, 'identity', {
      set: identitySetter,
      configurable: true,
    });

    await guard.canActivate(makeExecutionContext());

    const identity = identitySetter.mock.calls[0][0];
    expect(identity.apiKey.organizationId).toBe(ORG_ID);
  });
});

const SESSION_HEADERS = { cookie: 'better-auth.session_token=abc' };

describe('UnifiedIdentityGuard — session path', () => {
  it('sets the identity context from the member record', async () => {
    const member = makeMember();
    const session = makeSession();
    const { guard, identitySetter, repo } = makeGuard(null, member, { session });

    const result = await guard.canActivate(makeExecutionContext(SESSION_HEADERS));

    expect(result).toBe(true);
    expect(repo.findOrganizationMember).toHaveBeenCalledWith(USER_ID, ORG_ID);
    expect(identitySetter).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: AuthType.Session,
        organizationId: ORG_ID,
        organization: member.organization,
        role: member.role,
        session,
      }),
    );
  });

  it('rejects with 401 when there is no valid session', async () => {
    const { guard } = makeGuard(null, makeMember(), { session: null });

    await expect(guard.canActivate(makeExecutionContext(SESSION_HEADERS))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects with 401 when the session has no activeOrganizationId', async () => {
    const session = makeSession({ activeOrganizationId: null });
    const { guard, repo } = makeGuard(null, makeMember(), { session });

    await expect(guard.canActivate(makeExecutionContext(SESSION_HEADERS))).rejects.toThrow(UnauthorizedException);
    expect(repo.findOrganizationMember).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the session user id is missing', async () => {
    const session = makeSession({ userId: '' });
    const { guard, repo } = makeGuard(null, makeMember(), { session });

    await expect(guard.canActivate(makeExecutionContext(SESSION_HEADERS))).rejects.toThrow(UnauthorizedException);
    expect(repo.findOrganizationMember).not.toHaveBeenCalled();
  });

  it('rejects with 401 when no matching organization member is found', async () => {
    const { guard } = makeGuard(null, null, { session: makeSession() });

    await expect(guard.canActivate(makeExecutionContext(SESSION_HEADERS))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the organization has been deleted', async () => {
    const member = makeMember();
    member.organization.deletedAt = new Date();
    const { guard } = makeGuard(null, member, { session: makeSession() });

    await expect(guard.canActivate(makeExecutionContext(SESSION_HEADERS))).rejects.toThrow(HttpException);
  });

  it('rejects when the session user is banned', async () => {
    const member = makeMember();
    member.user.banned = true;
    const { guard } = makeGuard(null, member, { session: makeSession() });

    await expect(guard.canActivate(makeExecutionContext(SESSION_HEADERS))).rejects.toThrow(HttpException);
  });
});

describe('UnifiedIdentityGuard — session-only path', () => {
  it('rejects a banned user via rejectIfBanned and exercises prisma.user.findUnique', async () => {
    const { guard, prisma } = makeGuard(null, makeMember(), {
      session: makeSession(),
      sessionOnly: true,
      bannedUser: { banned: true, banExpires: null },
    });

    await expect(guard.canActivate(makeExecutionContext(SESSION_HEADERS))).rejects.toThrow(HttpException);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { banned: true, banExpires: true },
    });
  });

  function makeSessionOnlyGuard(
    session: { user: { id: string; email: string; firstName: string; lastName: string } } | null,
  ) {
    const authClient = { api: { getSession: vi.fn().mockResolvedValue(session), verifyApiKey: vi.fn() } };
    const prisma = { user: { findUnique: vi.fn().mockResolvedValue({ banned: false, banExpires: null }) } };
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
    } as unknown as Reflector;
    const sessionUserSetter = vi.fn();
    const contextService = {};
    Object.defineProperty(contextService, 'sessionUser', { set: sessionUserSetter, configurable: true });
    const logger = { error: vi.fn(), warn: vi.fn() };
    const guard = new UnifiedIdentityGuard(
      authClient as any,
      {} as any,
      prisma as any,
      reflector,
      contextService as any,
      {} as any,
      { get: vi.fn() } as any,
      logger as any,
    );
    return { guard, sessionUserSetter };
  }

  it('populates contextService.sessionUser from the session', async () => {
    const { guard, sessionUserSetter } = makeSessionOnlyGuard({
      user: { id: USER_ID, email: 'me@example.com', firstName: 'Ada', lastName: 'Lovelace' },
    });

    const result = await guard.canActivate(makeExecutionContext({}));

    expect(result).toBe(true);
    expect(sessionUserSetter).toHaveBeenCalledWith({
      id: USER_ID,
      email: 'me@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('rejects when no valid session exists', async () => {
    const { guard } = makeSessionOnlyGuard(null);

    await expect(guard.canActivate(makeExecutionContext({}))).rejects.toThrow(UnauthorizedException);
  });
});
