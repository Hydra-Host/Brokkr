import { ExecutionContext, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationMembershipRole } from '@repo/database';
import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { IS_SESSION_ONLY_KEY } from '../../../auth/decorators/session-only.decorator';
import { UnifiedIdentityGuard } from '../../../auth/unified-identity.guard';
import { DesignationOperatorPolicy } from '../../../common/authz/operator-policy';
import { ContextService } from '../../../common/context/context.service';
import type { LoggerService } from '../../../logger/logger.service';
import { OrganizationInvitationsService } from '../organization-invitations.service';

const ORG_ID = 'org-1';
const USER_ID = 'user-invitee';
const INVITEE_EMAIL = 'invitee@example.com';
const FIRST_NAME = 'Ada';
const LAST_NAME = 'Lovelace';

const roleSummary = {
  id: 'role-member',
  name: 'Member',
  slug: 'member',
  isSystem: true,
  isOwnerCapable: false,
  rolePermissions: [],
};

function invitationRow(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    email: INVITEE_EMAIL,
    inviterId: 'user-inviter',
    organizationId: ORG_ID,
    assignedRoleId: roleSummary.id,
    assignedRole: roleSummary,
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

function memberRow() {
  const now = new Date();
  return {
    id: 'member-1',
    userId: USER_ID,
    organizationId: ORG_ID,
    role: OrganizationMembershipRole.Admin,
    assignedRoleId: 'role-admin',
    createdAt: now,
    updatedAt: now,
    user: { id: USER_ID, email: INVITEE_EMAIL, banned: false, banExpires: null },
    organization: {
      id: ORG_ID,
      name: 'Org',
      slug: 'org',
      logo: null,
      metadata: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      members: [],
    },
  };
}

function sessionPayload(names: { firstName: string | null; lastName: string | null } = {
  firstName: FIRST_NAME,
  lastName: LAST_NAME,
}) {
  return {
    session: { activeOrganizationId: ORG_ID },
    user: { id: USER_ID, email: INVITEE_EMAIL, ...names },
  };
}

function executionContext(headers: Record<string, string>): ExecutionContext {
  return {
    getHandler: vi.fn(),
    getClass: vi.fn(),
    switchToHttp: vi.fn().mockReturnValue({ getRequest: vi.fn().mockReturnValue({ headers }) }),
  } as unknown as ExecutionContext;
}

function harness(opts: { sessionOnly?: boolean; apiKey?: boolean; nullNames?: boolean } = {}) {
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const tx = { transaction: true };

  const authClient = {
    api: {
      getSession: vi
        .fn()
        .mockResolvedValue(opts.nullNames ? sessionPayload({ firstName: null, lastName: null }) : sessionPayload()),
      verifyApiKey: vi.fn().mockResolvedValue({
        valid: true,
        error: null,
        key: { id: 'ak-1', name: 'ci-bot', referenceId: USER_ID, permissions: null },
      }),
    },
  };
  const authRepo = { findOrganizationMember: vi.fn().mockResolvedValue(memberRow()) };
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ banned: false, banExpires: null }) },
    apiKey: { findUnique: vi.fn().mockResolvedValue({ organizationId: ORG_ID, permissions: null }) },
  };
  const reflector = {
    getAllAndOverride: vi.fn((key: unknown) => Boolean(opts.sessionOnly) && key === IS_SESSION_ONLY_KEY),
  } as unknown as Reflector;
  const rbacResolver = {
    resolveEffectivePermissions: vi.fn().mockResolvedValue(new Set<string>(['invitation:read'])),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  const guard = new UnifiedIdentityGuard(
    authClient as never,
    authRepo as never,
    prisma as never,
    reflector,
    contextService,
    rbacResolver as never,
    { get: vi.fn() } as never,
    logger as unknown as LoggerService,
  );

  const repository = {
    findById: vi.fn().mockResolvedValue(invitationRow()),
    findByIdAndOrganizationId: vi.fn().mockResolvedValue(invitationRow()),
    findLiveMemberByEmail: vi.fn().mockResolvedValue(null),
    claimPendingAsAccepted: vi.fn().mockResolvedValue(true),
    updateStatus: vi
      .fn()
      .mockImplementation((id: string, status: string) => Promise.resolve(invitationRow({ id, status }))),
  };
  const membershipsRepository = { create: vi.fn().mockResolvedValue({}) };
  const rbacService = {
    withOwnerLock: vi.fn().mockImplementation((_orgId: string, action: (client: object) => unknown) => action(tx)),
    getRoleById: vi.fn().mockResolvedValue(roleSummary),
  };
  const eventBus = { emit: vi.fn() };
  const emailService = { send: { organizationInvite: vi.fn().mockResolvedValue(undefined) } };
  const eventLog = {
    recordInTransaction: vi.fn().mockResolvedValue(undefined),
    record: vi.fn().mockResolvedValue(undefined),
  };

  const service = new OrganizationInvitationsService(
    contextService,
    rbacService as never,
    emailService as never,
    eventBus as never,
    repository as never,
    membershipsRepository as never,
    eventLog as never,
    logger as unknown as LoggerService,
  );

  const headers = opts.apiKey ? { 'x-api-key': 'brk_test' } : { cookie: 'better-auth.session_token=abc' };

  return { guard, service, contextService, repository, membershipsRepository, eventBus, headers };
}

function runGuarded<T>(contextService: ContextService, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    contextService.run({ requestId: randomUUID() }, () => {
      fn().then(resolve, reject);
    });
  });
}

describe('invitation actor resolution through the real UnifiedIdentityGuard', () => {
  it('accepts an invitation on a session-only route where the guard leaves identity unset', async () => {
    const { guard, service, contextService, membershipsRepository, headers } = harness({ sessionOnly: true });

    const result = await runGuarded(contextService, async () => {
      await guard.canActivate(executionContext(headers));
      expect(contextService.identity).toBeUndefined();
      expect(contextService.sessionUser).toEqual({
        id: USER_ID,
        email: INVITEE_EMAIL,
        firstName: FIRST_NAME,
        lastName: LAST_NAME,
      });
      return service.acceptInvitation('inv-1');
    });

    expect(result.status).toBe('accepted');
    expect(membershipsRepository.create).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      OrganizationMembershipRole.Member,
      roleSummary.id,
      expect.anything(),
    );
  });

  it('rejects an invitation on a session-only route where the guard leaves identity unset', async () => {
    const { guard, service, contextService, repository, headers } = harness({ sessionOnly: true });

    const result = await runGuarded(contextService, async () => {
      await guard.canActivate(executionContext(headers));
      expect(contextService.identity).toBeUndefined();
      return service.rejectInvitation('inv-1');
    });

    expect(result.status).toBe('rejected');
    expect(repository.updateStatus).toHaveBeenCalledWith('inv-1', 'rejected', expect.anything());
  });

  it('carries the session user names into the member.added payload on a session-only route', async () => {
    const { guard, service, contextService, eventBus, headers } = harness({ sessionOnly: true });

    await runGuarded(contextService, async () => {
      await guard.canActivate(executionContext(headers));
      return service.acceptInvitation('inv-1');
    });

    expect(eventBus.emit).toHaveBeenCalledWith('member.added', {
      organizationId: ORG_ID,
      userId: USER_ID,
      email: INVITEE_EMAIL,
      firstName: FIRST_NAME,
      lastName: LAST_NAME,
      role: OrganizationMembershipRole.Member,
    });
  });

  it('coalesces null session user names so the member.added payload never carries null', async () => {
    const { guard, service, contextService, eventBus, headers } = harness({ sessionOnly: true, nullNames: true });

    await runGuarded(contextService, async () => {
      await guard.canActivate(executionContext(headers));
      expect(contextService.sessionUser).toEqual({
        id: USER_ID,
        email: INVITEE_EMAIL,
        firstName: '',
        lastName: '',
      });
      return service.acceptInvitation('inv-1');
    });

    expect(eventBus.emit).toHaveBeenCalledWith('member.added', {
      organizationId: ORG_ID,
      userId: USER_ID,
      email: INVITEE_EMAIL,
      firstName: '',
      lastName: '',
      role: OrganizationMembershipRole.Member,
    });
  });

  it('never surfaces a 401 from the session-only accept or reject path', async () => {
    const accept = harness({ sessionOnly: true });
    const reject = harness({ sessionOnly: true });

    await expect(
      runGuarded(accept.contextService, async () => {
        await accept.guard.canActivate(executionContext(accept.headers));
        return accept.service.acceptInvitation('inv-1');
      }),
    ).resolves.not.toThrow(UnauthorizedException);

    await expect(
      runGuarded(reject.contextService, async () => {
        await reject.guard.canActivate(executionContext(reject.headers));
        return reject.service.rejectInvitation('inv-1');
      }),
    ).resolves.not.toThrow(UnauthorizedException);
  });

  it('accepts an invitation on the org-scoped route where the guard populates identity', async () => {
    const { guard, service, contextService, membershipsRepository, headers } = harness();

    const result = await runGuarded(contextService, async () => {
      await guard.canActivate(executionContext(headers));
      expect(contextService.identity).toBeDefined();
      expect(contextService.sessionUser).toBeUndefined();
      return service.acceptInvitation('inv-1');
    });

    expect(result.status).toBe('accepted');
    expect(membershipsRepository.create).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      OrganizationMembershipRole.Member,
      roleSummary.id,
      expect.anything(),
    );
  });

  it('rejects an invitation on the org-scoped route where the guard populates identity', async () => {
    const { guard, service, contextService, repository, headers } = harness();

    const result = await runGuarded(contextService, async () => {
      await guard.canActivate(executionContext(headers));
      return service.rejectInvitation('inv-1');
    });

    expect(result.status).toBe('rejected');
    expect(repository.updateStatus).toHaveBeenCalledWith('inv-1', 'rejected', expect.anything());
  });

  it('blocks a genuine api-key caller from accepting with 403', async () => {
    const { guard, service, contextService, membershipsRepository, headers } = harness({ apiKey: true });

    const failure = await runGuarded(contextService, async () => {
      await guard.canActivate(executionContext(headers));
      return service.acceptInvitation('inv-1').then(
        () => null,
        (error: unknown) => error,
      );
    });

    expect(failure).toBeInstanceOf(HttpException);
    expect(failure instanceof HttpException && failure.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(membershipsRepository.create).not.toHaveBeenCalled();
  });
});
