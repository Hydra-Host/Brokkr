import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isMutatingPermission, MAIN_APP_PERMISSIONS, permissionKey } from '@repo/auth/rbac';
import type { Prisma } from '@repo/database';
import { defer, from } from 'rxjs';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { AUDIT_ACTION_KEY, type AuditActionOptions } from 'src/event-log/audit-action.decorator';
import { EventLogInterceptor } from 'src/event-log/event-log.interceptor';
import type { EventLogWrite } from 'src/event-log/event-log.types';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationInvitationsController } from '../organization-invitations.controller';
import type { InvitationWithAssignedRole } from '../organization-invitations.repository';
import { OrganizationInvitationsService } from '../organization-invitations.service';

const ACTOR_ORG = 'org-actor';
const INVITE_ORG = 'org-invite';
const INVITEE = 'invitee@example.com';
const TX = { transaction: true } as unknown as Prisma.TransactionClient;

const assignedRole = {
  id: 'role-member',
  name: 'Member',
  slug: 'member',
  isSystem: true,
  rolePermissions: [],
};

function invRow(over: Partial<InvitationWithAssignedRole> = {}): InvitationWithAssignedRole {
  return {
    id: 'inv-1',
    email: INVITEE,
    inviterId: 'u-inviter',
    organizationId: INVITE_ORG,
    assignedRoleId: assignedRole.id,
    assignedRole,
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

function actor(opts: { email: string; permissions?: string[]; authType?: AuthType }): IdentityContext {
  return {
    authType: opts.authType ?? AuthType.Session,
    role: 'Admin',
    organizationId: ACTOR_ORG,
    organization: { id: ACTOR_ORG },
    permissions: new Set(opts.permissions ?? []),
    session: { user: { id: 'u-actor', email: opts.email, firstName: 'A', lastName: 'B' } },
  } as unknown as IdentityContext;
}

const inviter = () => actor({ email: 'inviter@example.com', permissions: ['invitation:create', 'invitation:delete'] });
const invitee = () => actor({ email: INVITEE });

function build(
  opts: {
    findById?: InvitationWithAssignedRole | null;
    pendingCount?: number;
    claimWins?: boolean;
    liveMember?: { id: string } | null;
  } = {},
) {
  const writes: EventLogWrite[] = [];
  const failures: EventLogWrite[] = [];
  const order: string[] = [];
  const eventLog = {
    recordInTransaction: vi.fn(async (_tx: Prisma.TransactionClient, write: EventLogWrite) => {
      order.push('event');
      writes.push(write);
    }),
    record: vi.fn(async (write: EventLogWrite) => {
      failures.push(write);
    }),
  };

  const row = opts.findById === undefined ? invRow() : opts.findById;
  const repository = {
    findById: vi.fn().mockResolvedValue(row),
    findByIdAndOrganizationId: vi.fn().mockResolvedValue(row),
    updateStatus: vi.fn((id: string, status: string, _tx?: Prisma.TransactionClient) =>
      Promise.resolve(invRow({ id, status })),
    ),
    findLiveMemberByEmail: vi.fn().mockResolvedValue(opts.liveMember ?? null),
    findPendingByEmailAndOrganization: vi.fn().mockResolvedValue(null),
    countPendingByOrganization: vi.fn().mockResolvedValue(opts.pendingCount ?? 0),
    findActiveOrganizationName: vi.fn().mockResolvedValue({ name: 'Org' }),
    createInvitation: vi.fn((data: Partial<InvitationWithAssignedRole>, _tx?: Prisma.TransactionClient) =>
      Promise.resolve(invRow({ ...data, id: 'inv-new' })),
    ),
    claimPendingAsAccepted: vi.fn().mockResolvedValue(opts.claimWins ?? true),
  };

  const lockedOrganizations: string[] = [];
  const rbacService = {
    withOwnerLock: vi.fn((organizationId: string, action: (tx: Prisma.TransactionClient) => unknown) => {
      lockedOrganizations.push(organizationId);
      return action(TX);
    }),
    getRoleById: vi.fn().mockResolvedValue(assignedRole),
    assertRoleAssignableBy: vi.fn(),
  };

  const membershipsRepository = { create: vi.fn().mockResolvedValue({}) };
  const eventBus = { emit: vi.fn() };
  const emailService = {
    send: {
      organizationInvite: vi.fn(async () => {
        order.push('email');
      }),
    },
  };
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  const contextService = new ContextService(new DesignationOperatorPolicy());
  const service = new OrganizationInvitationsService(
    contextService,
    rbacService as never,
    emailService as never,
    eventBus as never,
    repository as never,
    membershipsRepository as never,
    eventLog as never,
    logger as never,
  );

  const inContext = <T>(identity: IdentityContext, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId: 'req-1',
          identity,
          method: 'POST',
          path: '/api/v1/organizations/invitations',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          fn().then(resolve, reject);
        },
      );
    });

  return {
    service,
    contextService,
    repository,
    membershipsRepository,
    rbacService,
    eventLog,
    logger,
    writes,
    failures,
    order,
    lockedOrganizations,
    inContext,
  };
}

type Harness = ReturnType<typeof build>;

const create = (service: OrganizationInvitationsService) =>
  service.createInvitation({ email: ` ${INVITEE.toUpperCase()} `, roleId: assignedRole.id });

const swallow = (promise: Promise<unknown>) => promise.then(() => undefined).catch(() => undefined);

describe('OrganizationInvitationsService tier 1 event capture', () => {
  it('records member.invited when an invitation is created', async () => {
    const { service, writes, inContext } = build();

    await inContext(inviter(), () => create(service));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'member',
      action: 'invited',
      actionKey: 'member.invited',
      targetId: 'inv-new',
    });
  });

  it('labels member.invited with the trimmed lowercase invitee email', async () => {
    const { service, writes, inContext } = build();

    await inContext(inviter(), () => create(service));

    expect(writes[0].targetLabel).toBe(INVITEE);
  });

  it('records member.invited before the invitation email is sent', async () => {
    const { service, order, inContext } = build();

    await inContext(inviter(), () => create(service));

    expect(order).toEqual(['event', 'email']);
  });

  it('records member.joined when an invitation is accepted', async () => {
    const { service, writes, inContext } = build();

    await inContext(invitee(), () => service.acceptInvitation('inv-1'));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'member',
      action: 'joined',
      actionKey: 'member.joined',
      targetId: 'inv-1',
      targetLabel: INVITEE,
    });
  });

  it('records invitation.rejected when an invitation is rejected', async () => {
    const { service, writes, inContext } = build();

    await inContext(invitee(), () => service.rejectInvitation('inv-1'));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'invitation',
      action: 'rejected',
      actionKey: 'invitation.rejected',
      targetId: 'inv-1',
      targetLabel: INVITEE,
    });
  });

  it('records invitation.cancelled when an invitation is cancelled', async () => {
    const { service, writes, inContext } = build({ findById: invRow({ organizationId: ACTOR_ORG }) });

    await inContext(inviter(), () => service.cancelInvitation('inv-1'));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'invitation',
      action: 'cancelled',
      actionKey: 'invitation.cancelled',
      targetId: 'inv-1',
      targetLabel: INVITEE,
    });
  });

  it('marks every invitation lifecycle event as atomic evidence that succeeded', async () => {
    const created = build();
    const accepted = build();
    const rejected = build();
    const cancelled = build({ findById: invRow({ organizationId: ACTOR_ORG }) });

    await created.inContext(inviter(), () => create(created.service));
    await accepted.inContext(invitee(), () => accepted.service.acceptInvitation('inv-1'));
    await rejected.inContext(invitee(), () => rejected.service.rejectInvitation('inv-1'));
    await cancelled.inContext(inviter(), () => cancelled.service.cancelInvitation('inv-1'));

    const writes = [...created.writes, ...accepted.writes, ...rejected.writes, ...cancelled.writes];
    expect(writes).toHaveLength(4);
    for (const write of writes) {
      expect(write.tier).toBe('EVIDENCE');
      expect(write.durability).toBe('ATOMIC');
      expect(write.outcome).toBe('SUCCEEDED');
    }
  });

  it('carries the acting identity and request provenance', async () => {
    const { service, writes, inContext } = build();

    await inContext(invitee(), () => service.acceptInvitation('inv-1'));

    expect(writes[0]).toMatchObject({
      actorType: 'UI',
      actorId: 'u-actor',
      actorLabel: INVITEE,
      requestId: 'req-1',
      method: 'POST',
      path: '/api/v1/organizations/invitations',
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
    });
  });

  it('omits metadata rather than writing a json null', async () => {
    const { service, writes, inContext } = build();

    await inContext(invitee(), () => service.acceptInvitation('inv-1'));

    expect(writes[0]).not.toHaveProperty('metadata');
  });
});

describe('OrganizationInvitationsService event organization attribution', () => {
  it('attributes an accepted invitation to the inviting organization, not the accepting actor', async () => {
    const { service, writes, inContext } = build();

    await inContext(invitee(), () => service.acceptInvitation('inv-1'));

    expect(writes[0].organizationId).toBe(INVITE_ORG);
    expect(writes.filter((write) => write.organizationId === ACTOR_ORG)).toEqual([]);
  });

  it('attributes a rejected invitation to the inviting organization, not the rejecting actor', async () => {
    const { service, writes, inContext } = build();

    await inContext(invitee(), () => service.rejectInvitation('inv-1'));

    expect(writes[0].organizationId).toBe(INVITE_ORG);
    expect(writes.filter((write) => write.organizationId === ACTOR_ORG)).toEqual([]);
  });

  it('reads the accepted organization from the transactionally reloaded row, not the pre-lock read', async () => {
    const { service, repository, writes, lockedOrganizations, inContext } = build();
    repository.findById
      .mockResolvedValueOnce(invRow({ organizationId: INVITE_ORG }))
      .mockResolvedValueOnce(invRow({ organizationId: 'org-relocated' }));

    await inContext(invitee(), () => service.acceptInvitation('inv-1'));

    expect(lockedOrganizations).toEqual([INVITE_ORG]);
    expect(writes[0].organizationId).toBe('org-relocated');
  });

  it('reads the rejected organization from the transactionally reloaded row, not the pre-lock read', async () => {
    const { service, repository, writes, inContext } = build();
    repository.findById
      .mockResolvedValueOnce(invRow({ organizationId: INVITE_ORG }))
      .mockResolvedValueOnce(invRow({ organizationId: 'org-relocated' }));

    await inContext(invitee(), () => service.rejectInvitation('inv-1'));

    expect(writes[0].organizationId).toBe('org-relocated');
  });

  it('attributes a created invitation to the acting organization', async () => {
    const { service, writes, inContext } = build();

    await inContext(inviter(), () => create(service));

    expect(writes[0].organizationId).toBe(ACTOR_ORG);
  });

  it('attributes a cancelled invitation to the acting organization', async () => {
    const { service, writes, inContext } = build({ findById: invRow({ organizationId: ACTOR_ORG }) });

    await inContext(inviter(), () => service.cancelInvitation('inv-1'));

    expect(writes[0].organizationId).toBe(ACTOR_ORG);
  });
});

describe('OrganizationInvitationsService event transaction sharing', () => {
  it('writes the created invitation event on the insert transaction', async () => {
    const { service, repository, eventLog, inContext } = build();

    await inContext(inviter(), () => create(service));

    expect(eventLog.recordInTransaction.mock.calls[0][0]).toBe(repository.createInvitation.mock.calls[0][1]);
  });

  it('writes the accepted invitation event on the membership transaction', async () => {
    const { service, membershipsRepository, eventLog, inContext } = build();

    await inContext(invitee(), () => service.acceptInvitation('inv-1'));

    expect(eventLog.recordInTransaction.mock.calls[0][0]).toBe(membershipsRepository.create.mock.calls[0][4]);
  });

  it('writes the rejected invitation event on the status-update transaction', async () => {
    const { service, repository, eventLog, inContext } = build();

    await inContext(invitee(), () => service.rejectInvitation('inv-1'));

    expect(eventLog.recordInTransaction.mock.calls[0][0]).toBe(repository.updateStatus.mock.calls[0][2]);
  });

  it('writes the cancelled invitation event on the status-update transaction', async () => {
    const { service, repository, eventLog, inContext } = build({ findById: invRow({ organizationId: ACTOR_ORG }) });

    await inContext(inviter(), () => service.cancelInvitation('inv-1'));

    expect(eventLog.recordInTransaction.mock.calls[0][0]).toBe(repository.updateStatus.mock.calls[0][2]);
  });

  it('propagates an event write failure to the caller so the transaction rolls back', async () => {
    const { service, eventLog, inContext } = build();
    eventLog.recordInTransaction.mockRejectedValueOnce(new Error('event write failed'));

    await expect(inContext(invitee(), () => service.acceptInvitation('inv-1'))).rejects.toThrow('event write failed');
  });
});

describe('OrganizationInvitationsService failed accept and reject capture', () => {
  const acceptCases: [string, () => Harness, string][] = [
    ['a non-pending invitation', () => build({ findById: invRow({ status: 'accepted' }) }), '400:HttpException'],
    [
      'an expired invitation',
      () => build({ findById: invRow({ expiresAt: new Date(Date.now() - 1) }) }),
      '400:HttpException',
    ],
    ['a caller who is already a member', () => build({ liveMember: { id: 'm-1' } }), '400:HttpException'],
    ['a lost pending claim', () => build({ claimWins: false }), '409:HttpException'],
    [
      'an invitation deleted before the locked reload',
      () => {
        const harness = build();
        harness.repository.findById.mockResolvedValueOnce(invRow()).mockResolvedValueOnce(null);
        return harness;
      },
      '404:NotFoundException',
    ],
    [
      'an invitee email that changes before the locked reload',
      () => {
        const harness = build();
        harness.repository.findById
          .mockResolvedValueOnce(invRow())
          .mockResolvedValueOnce(invRow({ email: 'someone-else@example.com' }));
        return harness;
      },
      '404:NotFoundException',
    ],
  ];

  it.each(acceptCases)('records a failed member.joined for %s', async (_case, setup, errorCode) => {
    const { service, writes, failures, inContext } = setup();

    await swallow(inContext(invitee(), () => service.acceptInvitation('inv-1')));

    expect(writes).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      resource: 'member',
      action: 'joined',
      actionKey: 'member.joined',
      tier: 'EVIDENCE',
      durability: 'POST_COMMIT',
      outcome: 'FAILED',
      organizationId: INVITE_ORG,
      targetId: 'inv-1',
      errorCode,
    });
  });

  const rejectCases: [string, () => Harness, string][] = [
    ['a non-pending invitation', () => build({ findById: invRow({ status: 'accepted' }) }), '400:HttpException'],
    [
      'an invitation deleted before the locked reload',
      () => {
        const harness = build();
        harness.repository.findById.mockResolvedValueOnce(invRow()).mockResolvedValueOnce(null);
        return harness;
      },
      '404:NotFoundException',
    ],
  ];

  it.each(rejectCases)('records a failed invitation.rejected for %s', async (_case, setup, errorCode) => {
    const { service, writes, failures, inContext } = setup();

    await swallow(inContext(invitee(), () => service.rejectInvitation('inv-1')));

    expect(writes).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      resource: 'invitation',
      action: 'rejected',
      actionKey: 'invitation.rejected',
      tier: 'EVIDENCE',
      durability: 'POST_COMMIT',
      outcome: 'FAILED',
      organizationId: INVITE_ORG,
      targetId: 'inv-1',
      errorCode,
    });
  });

  it('never writes a failed row on the rolled-back transaction', async () => {
    const { service, eventLog, failures, inContext } = build({ findById: invRow({ status: 'accepted' }) });

    await swallow(inContext(invitee(), () => service.acceptInvitation('inv-1')));

    expect(eventLog.recordInTransaction).not.toHaveBeenCalled();
    expect(eventLog.record).toHaveBeenCalledOnce();
    expect(failures[0].targetLabel).toBe(INVITEE);
  });

  it('attributes a failed accept to the invitation organization, never the accepting actor', async () => {
    const { service, failures, inContext } = build({ findById: invRow({ status: 'accepted' }) });

    await swallow(inContext(invitee(), () => service.acceptInvitation('inv-1')));

    expect(failures.filter((write) => write.organizationId === ACTOR_ORG)).toEqual([]);
  });

  it('writes nothing when the accepted invitation does not exist', async () => {
    const { service, writes, failures, inContext } = build({ findById: null });

    await swallow(inContext(invitee(), () => service.acceptInvitation('inv-1')));

    expect([...writes, ...failures]).toEqual([]);
  });

  it('writes nothing when the rejected invitation does not exist', async () => {
    const { service, writes, failures, inContext } = build({ findById: null });

    await swallow(inContext(invitee(), () => service.rejectInvitation('inv-1')));

    expect([...writes, ...failures]).toEqual([]);
  });

  it('writes nothing when the caller email does not match the invitation before the lock', async () => {
    const accept = build();
    const reject = build();

    await swallow(accept.inContext(inviter(), () => accept.service.acceptInvitation('inv-1')));
    await swallow(reject.inContext(inviter(), () => reject.service.rejectInvitation('inv-1')));

    expect([...accept.writes, ...accept.failures, ...reject.writes, ...reject.failures]).toEqual([]);
  });

  it('writes nothing when an api-key caller is refused before the invitation is known', async () => {
    const { service, writes, failures, inContext } = build();
    const apiKeyCaller = actor({ email: INVITEE, authType: AuthType.ApiKey });

    await swallow(inContext(apiKeyCaller, () => service.acceptInvitation('inv-1')));

    expect([...writes, ...failures]).toEqual([]);
  });
});

describe('OrganizationInvitationsService audit write outage', () => {
  const auditFailure = () => new Error('audit row insert failed');

  const thrownBy = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  it('surfaces the business error, not the audit error, when a failed accept cannot be recorded', async () => {
    const { service, eventLog, inContext } = build({ findById: invRow({ status: 'accepted' }) });
    eventLog.record.mockRejectedValueOnce(auditFailure());

    const error = await thrownBy(inContext(invitee(), () => service.acceptInvitation('inv-1')));

    expect(error).toBeInstanceOf(HttpException);
    expect(error instanceof HttpException && error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error instanceof HttpException && error.message).toBe("Cannot accept invitation with status 'accepted'");
  });

  it('surfaces the business error, not the audit error, when a failed reject cannot be recorded', async () => {
    const { service, eventLog, inContext } = build({ findById: invRow({ status: 'accepted' }) });
    eventLog.record.mockRejectedValueOnce(auditFailure());

    const error = await thrownBy(inContext(invitee(), () => service.rejectInvitation('inv-1')));

    expect(error).toBeInstanceOf(HttpException);
    expect(error instanceof HttpException && error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error instanceof HttpException && error.message).toBe("Cannot reject invitation with status 'accepted'");
  });

  it('surfaces the not-found status when a failed accept on a vanished invitation cannot be recorded', async () => {
    const { service, repository, eventLog, inContext } = build();
    repository.findById.mockResolvedValueOnce(invRow()).mockResolvedValueOnce(null);
    eventLog.record.mockRejectedValueOnce(auditFailure());

    const error = await thrownBy(inContext(invitee(), () => service.acceptInvitation('inv-1')));

    expect(error instanceof HttpException && error.getStatus()).toBe(HttpStatus.NOT_FOUND);
  });

  it('logs the audit outage with the action key and the underlying reason', async () => {
    const { service, eventLog, logger, inContext } = build({ findById: invRow({ status: 'accepted' }) });
    eventLog.record.mockRejectedValueOnce(auditFailure());

    await swallow(inContext(invitee(), () => service.acceptInvitation('inv-1')));

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toContain('member.joined');
    expect(logger.error.mock.calls[0][0]).toContain(INVITE_ORG);
    expect(logger.error.mock.calls[0][0]).toContain('audit row insert failed');
  });

  it('still attempts the failed row exactly once', async () => {
    const { service, eventLog, inContext } = build({ findById: invRow({ status: 'accepted' }) });
    eventLog.record.mockRejectedValueOnce(auditFailure());

    await swallow(inContext(invitee(), () => service.acceptInvitation('inv-1')));

    expect(eventLog.record).toHaveBeenCalledOnce();
  });

  it('logs nothing when the failed row is written successfully', async () => {
    const { service, logger, inContext } = build({ findById: invRow({ status: 'accepted' }) });

    await swallow(inContext(invitee(), () => service.acceptInvitation('inv-1')));

    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('OrganizationInvitationsService permission intents', () => {
  const drain = (harness: Harness, identity: IdentityContext, call: () => Promise<unknown>) =>
    harness.inContext(identity, async () => {
      await swallow(call());
      return harness.contextService.drainIntents();
    });

  it('supersedes the create intent once the invitation commits', async () => {
    const harness = build();
    const finalize = vi.spyOn(harness.contextService, 'finalizeIntents');

    const pending = await drain(harness, inviter(), () => create(harness.service));

    expect(finalize).toHaveBeenCalledOnce();
    expect(pending).toEqual([]);
  });

  it('leaves the create intent unfinalized when the pending-invitation limit is reached', async () => {
    const harness = build({ pendingCount: 100 });
    const finalize = vi.spyOn(harness.contextService, 'finalizeIntents');

    const pending = await drain(harness, inviter(), () => create(harness.service));

    expect(finalize).not.toHaveBeenCalled();
    expect(pending).toEqual([
      expect.objectContaining({ resource: 'invitation', action: 'create', denied: false, finalized: false }),
    ]);
  });

  it('supersedes the cancel intent once the cancellation commits', async () => {
    const harness = build({ findById: invRow({ organizationId: ACTOR_ORG }) });
    const finalize = vi.spyOn(harness.contextService, 'finalizeIntents');

    const pending = await drain(harness, inviter(), () => harness.service.cancelInvitation('inv-1'));

    expect(finalize).toHaveBeenCalledOnce();
    expect(pending).toEqual([]);
  });

  it('leaves the cancel intent unfinalized when the invitation is no longer pending', async () => {
    const harness = build({ findById: invRow({ organizationId: ACTOR_ORG, status: 'canceled' }) });
    const finalize = vi.spyOn(harness.contextService, 'finalizeIntents');

    const pending = await drain(harness, inviter(), () => harness.service.cancelInvitation('inv-1'));

    expect(finalize).not.toHaveBeenCalled();
    expect(pending).toEqual([
      expect.objectContaining({ resource: 'invitation', action: 'delete', denied: false, finalized: false }),
    ]);
  });

  it('records no intent for accept or reject, whose rows come from the tier 1 emits alone', async () => {
    const accept = build();
    const reject = build();

    const acceptIntents = await drain(accept, invitee(), () => accept.service.acceptInvitation('inv-1'));
    const rejectIntents = await drain(reject, invitee(), () => reject.service.rejectInvitation('inv-1'));

    expect(acceptIntents).toEqual([]);
    expect(rejectIntents).toEqual([]);
    expect(accept.writes).toHaveLength(1);
    expect(reject.writes).toHaveLength(1);
  });

  it('records no intent for a failed accept either', async () => {
    const harness = build({ findById: invRow({ status: 'accepted' }) });

    const pending = await drain(harness, invitee(), () => harness.service.acceptInvitation('inv-1'));

    expect(pending).toEqual([]);
    expect(harness.failures).toHaveLength(1);
  });
});

type Handler = (...args: never[]) => unknown;

const captureTier2 = async (
  harness: Harness,
  identity: IdentityContext,
  handler: Handler,
  call: () => Promise<unknown>,
): Promise<EventLogWrite[]> => {
  const rows: EventLogWrite[] = [];
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const interceptor = new EventLogInterceptor(
    harness.contextService,
    { recordBestEffort: async (write: EventLogWrite) => void rows.push(write) } as never,
    new Reflector(),
    logger as never,
  );
  const executionContext = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        path: '/api/v1/organizations/invitations',
        params: {},
        ip: '203.0.113.9',
        headers: { 'user-agent': 'vitest' },
      }),
    }),
    getHandler: () => handler,
  };

  await harness.inContext(identity, async () => {
    await new Promise<void>((resolve) =>
      interceptor
        .intercept(executionContext as never, { handle: () => defer(() => from(call())) })
        .subscribe({ complete: () => resolve(), error: () => resolve() }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  return rows;
};

const handlerFor = (name: keyof OrganizationInvitationsController): Handler =>
  OrganizationInvitationsController.prototype[name];

const reader = () => actor({ email: 'reader@example.com', permissions: ['invitation:read'] });

describe('OrganizationInvitationsController tier 2 failure capture', () => {
  it('keys a failed create on member.invited so it matches the succeeded row', async () => {
    const harness = build({ pendingCount: 100 });

    const rows = await captureTier2(harness, inviter(), handlerFor('createInvitation'), () => create(harness.service));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tier: 'ACTIVITY',
      resource: 'invitation',
      action: 'create',
      actionKey: 'member.invited',
      outcome: 'FAILED',
      errorCode: '403:HttpException',
    });
  });

  it('keys a failed cancel on invitation.cancelled so it matches the succeeded row', async () => {
    const harness = build({ findById: invRow({ organizationId: ACTOR_ORG, status: 'canceled' }) });

    const rows = await captureTier2(harness, inviter(), handlerFor('cancelInvitation'), () =>
      harness.service.cancelInvitation('inv-1'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tier: 'ACTIVITY',
      resource: 'invitation',
      action: 'delete',
      actionKey: 'invitation.cancelled',
      outcome: 'FAILED',
      errorCode: '400:HttpException',
    });
  });

  it('writes no tier 2 row beside the tier 1 row of a succeeded create', async () => {
    const harness = build();

    const rows = await captureTier2(harness, inviter(), handlerFor('createInvitation'), () => create(harness.service));

    expect(rows).toEqual([]);
    expect(harness.writes).toHaveLength(1);
  });

  it('writes no tier 2 row beside the tier 1 row of a succeeded cancel', async () => {
    const harness = build({ findById: invRow({ organizationId: ACTOR_ORG }) });

    const rows = await captureTier2(harness, inviter(), handlerFor('cancelInvitation'), () =>
      harness.service.cancelInvitation('inv-1'),
    );

    expect(rows).toEqual([]);
    expect(harness.writes).toHaveLength(1);
  });

  it.each(['acceptInvitation', 'rejectInvitation'] as const)(
    'writes no tier 2 row beside the tier 1 row of a succeeded %s',
    async (handler) => {
      const harness = build();
      const call = () =>
        handler === 'acceptInvitation'
          ? harness.service.acceptInvitation('inv-1')
          : harness.service.rejectInvitation('inv-1');

      const rows = await captureTier2(harness, invitee(), handlerFor(handler), call);

      expect(rows).toEqual([]);
      expect(harness.writes).toHaveLength(1);
    },
  );

  it.each(['acceptInvitation', 'rejectInvitation'] as const)(
    'writes no tier 2 row beside the tier 1 row of a failed %s',
    async (handler) => {
      const harness = build({ findById: invRow({ status: 'accepted' }) });
      const call = () =>
        handler === 'acceptInvitation'
          ? harness.service.acceptInvitation('inv-1')
          : harness.service.rejectInvitation('inv-1');

      const rows = await captureTier2(harness, invitee(), handlerFor(handler), call);

      expect(rows).toEqual([]);
      expect(harness.failures).toHaveLength(1);
    },
  );

  it('writes no tier 2 row for an allowed list read', async () => {
    const harness = build();

    const rows = await captureTier2(harness, reader(), handlerFor('listInvitations'), () =>
      harness.service.listInvitations({}),
    );

    expect(rows).toEqual([]);
  });
});

describe('OrganizationInvitationsController audit metadata', () => {
  const auditActionFor = (handler: Handler) =>
    new Reflector().get<AuditActionOptions | undefined>(AUDIT_ACTION_KEY, handler);

  it.each([
    ['createInvitation', 'member.invited', 'create'],
    ['cancelInvitation', 'invitation.cancelled', 'delete'],
  ] as const)('gates %s on a mutating catalog permission', (handler, actionKey, action) => {
    const options = auditActionFor(handlerFor(handler));

    expect(options).toMatchObject({ actionKey, resource: 'invitation', action });
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, permissionKey('invitation', action))).toBe(true);
  });

  it.each(['listInvitations', 'getInvitation', 'acceptInvitation', 'rejectInvitation'] as const)(
    'leaves %s undecorated so no synthetic intent is minted beside its own row',
    (handler) => {
      expect(auditActionFor(handlerFor(handler))).toBeUndefined();
    },
  );
});
