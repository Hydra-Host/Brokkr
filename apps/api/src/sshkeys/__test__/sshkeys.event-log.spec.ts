import { Reflector } from '@nestjs/core';
import { MAIN_APP_PERMISSIONS, isMutatingPermission, permissionKey } from '@repo/auth/rbac';
import type { Prisma } from '@repo/database';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { AUDIT_ACTION_KEY, type AuditActionOptions } from 'src/event-log/audit-action.decorator';
import type { EventLogWrite } from 'src/event-log/event-log.types';
import { describe, expect, it, vi } from 'vitest';
import { SshkeysController } from '../sshkeys.controller';
import { SshKeysService } from '../sshkeys.service';

const ORG = 'org-1';
const USER = 'u-1';
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKVkht1ZdckTEe2WZwwFgJX+cot8xSf5CAYaYqGtQKJ6 owner@laptop';
const KEY_BODY = KEY.split(' ')[1];
const FINGERPRINT = 'SHA256:TCzqHyUTYIf0YZCdq/F9k8JPYKElvkd39ZBWhP5mEAo';
const CREATED = { id: 'k-1', name: 'workstation', fingerprint: FINGERPRINT, key: KEY, userId: USER };

function identity(permissions: string[]): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Owner',
    organizationId: ORG,
    organization: { id: ORG },
    permissions: new Set(permissions),
    session: { user: { id: USER, email: 'owner@example.com' } },
  } as unknown as IdentityContext;
}

function build() {
  const writes: EventLogWrite[] = [];
  const eventLog = {
    recordInTransaction: vi.fn(async (_tx: Prisma.TransactionClient, write: EventLogWrite) => {
      writes.push(write);
    }),
  };
  const prisma = {
    sshKeys: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(CREATED),
      create: vi.fn().mockResolvedValue(CREATED),
      update: vi.fn().mockResolvedValue({ ...CREATED, dateDeleted: new Date() }),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    fn(prisma as unknown as Prisma.TransactionClient),
  );
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const service = new SshKeysService(prisma as never, contextService, eventLog as never);

  const run = async (permissions: string[], fn: () => Promise<unknown>) => {
    await new Promise<void>((resolve) => {
      contextService.run(
        {
          requestId: 'req-1',
          identity: identity(permissions),
          method: 'POST',
          path: '/api/v1/ssh-keys',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          void fn()
            .catch(() => undefined)
            .finally(resolve);
        },
      );
    });
  };

  const create = () => run(['ssh-key:create'], () => service.createSshKey({ name: 'workstation', key: KEY }));
  const remove = () => run(['ssh-key:delete'], () => service.deleteSshKey('k-1'));

  return { service, contextService, prisma, eventLog, writes, run, create, remove };
}

describe('SshKeysService event capture', () => {
  it('emits one atomic evidence row keyed ssh-key.created', async () => {
    const { writes, create } = build();

    await create();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      organizationId: ORG,
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      resource: 'ssh-key',
      action: 'created',
      actionKey: 'ssh-key.created',
      outcome: 'SUCCEEDED',
      targetId: 'k-1',
      targetLabel: 'workstation',
    });
  });

  it('emits one atomic evidence row keyed ssh-key.deleted', async () => {
    const { writes, remove } = build();

    await remove();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'ssh-key',
      action: 'deleted',
      actionKey: 'ssh-key.deleted',
      durability: 'ATOMIC',
      tier: 'EVIDENCE',
      outcome: 'SUCCEEDED',
      targetId: 'k-1',
      targetLabel: 'workstation',
    });
  });

  it('records the event on the same transaction client as the key write', async () => {
    const { prisma, eventLog, create } = build();

    await create();

    expect(eventLog.recordInTransaction.mock.calls[0][0]).toBe(prisma);
    expect(prisma.sshKeys.create).toHaveBeenCalledOnce();
  });

  it('carries the acting session user and the request provenance', async () => {
    const { writes, create } = build();

    await create();

    expect(writes[0]).toMatchObject({
      actorType: 'UI',
      actorId: USER,
      actorLabel: 'owner@example.com',
      requestId: 'req-1',
      method: 'POST',
      path: '/api/v1/ssh-keys',
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
    });
  });

  it('records no key material on a created key', async () => {
    const { writes, create } = build();

    await create();

    const row = JSON.stringify(writes[0]);
    expect(row).not.toContain(KEY_BODY);
    expect(row).not.toContain(KEY_BODY.slice(0, 20));
    expect(row).not.toContain(FINGERPRINT);
    expect(writes[0].metadata).toBeUndefined();
  });

  it('records no key material on a deleted key', async () => {
    const { writes, remove } = build();

    await remove();

    const row = JSON.stringify(writes[0]);
    expect(row).not.toContain(KEY_BODY.slice(0, 20));
    expect(row).not.toContain(FINGERPRINT);
    expect(writes[0].metadata).toBeUndefined();
  });

  it('supersedes the create intent only after the transaction resolves', async () => {
    const { contextService, create } = build();
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await create();

    expect(finalize).toHaveBeenCalledOnce();
  });

  it('leaves the create intent unfinalized when the event write fails', async () => {
    const { contextService, eventLog, create } = build();
    eventLog.recordInTransaction.mockRejectedValueOnce(new Error('event write failed'));
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await create();

    expect(finalize).not.toHaveBeenCalled();
  });

  it('leaves the delete intent unfinalized when the event write fails', async () => {
    const { contextService, eventLog, remove } = build();
    eventLog.recordInTransaction.mockRejectedValueOnce(new Error('event write failed'));
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await remove();

    expect(finalize).not.toHaveBeenCalled();
  });

  it.each([
    ['ssh-key.created', SshkeysController.prototype.createSshKey],
    ['ssh-key.deleted', SshkeysController.prototype.deleteSshKey],
  ])('gates the tier 2 fallback for %s on a catalog permission classified as mutating', (actionKey, handler) => {
    const options = new Reflector().get<AuditActionOptions>(AUDIT_ACTION_KEY, handler);

    expect(options.actionKey).toBe(actionKey);
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, permissionKey(options.resource, options.action))).toBe(true);
  });

  it('emits nothing when the caller lacks the ssh-key permission', async () => {
    const { service, writes, run } = build();

    await run([], () => service.createSshKey({ name: 'workstation', key: KEY }));
    await run([], () => service.deleteSshKey('k-1'));

    expect(writes).toHaveLength(0);
  });

  it('emits nothing when the key does not belong to the caller', async () => {
    const { service, prisma, writes, run } = build();
    prisma.sshKeys.findUnique.mockResolvedValue(null);

    await run(['ssh-key:delete'], () => service.deleteSshKey('k-1'));

    expect(writes).toHaveLength(0);
    expect(prisma.sshKeys.update).not.toHaveBeenCalled();
  });
});
