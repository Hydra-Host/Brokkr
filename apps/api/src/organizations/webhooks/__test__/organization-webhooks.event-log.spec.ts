import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MAIN_APP_PERMISSIONS, isMutatingPermission, permissionKey } from '@repo/auth/rbac';
import type { Prisma } from '@repo/database';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService, type PermissionIntent } from 'src/common/context/context.service';
import { AUDIT_ACTION_KEY, type AuditActionOptions } from 'src/event-log/audit-action.decorator';
import type { EventLogWrite } from 'src/event-log/event-log.types';
import { PrismaClient } from 'src/prisma/prisma.client';
import { WebhookRepository } from 'src/webhook/webhook.repository';
import { WebhookService } from 'src/webhook/webhook.service';
import type { CreateWebhookDTO, UpdateWebhookDTO } from 'src/webhook/webhook.types';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationWebhooksController } from '../organization-webhooks.controller';
import { OrganizationWebhooksService } from '../organization-webhooks.service';

const ORG = 'org-1';
const WEBHOOK_ID = '9f0f1d6e-0000-4000-8000-000000000001';
const ENDPOINT = 'https://hooks.example.com/brokkr';

const createDto = { endpoint: ENDPOINT, events: [] } as unknown as CreateWebhookDTO;
const updateDto = { endpoint: ENDPOINT, events: [], isActive: true } as unknown as UpdateWebhookDTO;

function identity(): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Admin',
    organizationId: ORG,
    organization: { id: ORG },
    permissions: new Set(['webhook:create', 'webhook:update', 'webhook:delete']),
    session: { user: { id: 'u-1', email: 'admin@example.com' } },
  } as unknown as IdentityContext;
}

function build() {
  const row = {
    id: WEBHOOK_ID,
    organizationId: ORG,
    endpoint: ENDPOINT,
    description: null,
    events: [],
    isActive: false,
    secret: 's',
    failureCount: 1,
    lastFailureAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const tx = {
    webhook: {
      create: vi.fn(async () => row),
      update: vi.fn(async () => row),
      findFirst: vi.fn(async () => row),
    },
  };

  const client = {
    webhook: {
      create: vi.fn(async () => row),
      update: vi.fn(async () => row),
      findFirst: vi.fn(async () => row),
    },
    $transaction: vi.fn(async (fn: (client: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(tx as unknown as Prisma.TransactionClient),
    ),
  };
  const prisma = client as unknown as PrismaClient;

  const writes: EventLogWrite[] = [];
  const transactionClients: unknown[] = [];
  const eventLog = {
    recordInTransaction: vi.fn(async (client: Prisma.TransactionClient, write: EventLogWrite) => {
      transactionClients.push(client);
      writes.push(write);
    }),
  };

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const deliveryRepo = { updateManyPendingOrRetryingToFailed: vi.fn() };
  const webhookService = new WebhookService(new WebhookRepository(prisma), deliveryRepo as never, logger as never);
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const service = new OrganizationWebhooksService(
    contextService,
    webhookService,
    {} as never,
    eventLog as never,
    prisma,
  );

  const run = async <T>(fn: () => Promise<T>) => {
    let result: T | undefined;
    await new Promise<void>((resolve) => {
      contextService.run(
        {
          requestId: 'req-1',
          identity: identity(),
          method: 'POST',
          path: '/api/v1/organization/webhooks',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          void fn()
            .then((value) => {
              result = value;
            })
            .finally(resolve);
        },
      );
    });
    return result;
  };

  return { service, webhookService, contextService, eventLog, writes, transactionClients, client, tx, run };
}

describe('OrganizationWebhooksService event capture', () => {
  it('records a creation as webhook.created targeting the new webhook', async () => {
    const { service, writes, run } = build();

    await run(() => service.createWebhook(createDto));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'webhook',
      action: 'created',
      actionKey: 'webhook.created',
      targetId: WEBHOOK_ID,
      targetLabel: ENDPOINT,
    });
  });

  it('records an update as webhook.updated targeting the updated webhook', async () => {
    const { service, writes, run } = build();

    await run(() => service.updateWebhook(WEBHOOK_ID, updateDto));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'webhook',
      action: 'updated',
      actionKey: 'webhook.updated',
      targetId: WEBHOOK_ID,
      targetLabel: ENDPOINT,
    });
  });

  it('records a deletion as webhook.deleted targeting the deleted webhook', async () => {
    const { service, writes, run } = build();

    await run(() => service.deleteWebhook(WEBHOOK_ID));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'webhook',
      action: 'deleted',
      actionKey: 'webhook.deleted',
      targetId: WEBHOOK_ID,
      targetLabel: ENDPOINT,
    });
  });

  it('marks every webhook event as atomic evidence attributed to the acting session user', async () => {
    const { service, writes, run } = build();

    await run(() => service.createWebhook(createDto));
    await run(() => service.updateWebhook(WEBHOOK_ID, updateDto));
    await run(() => service.deleteWebhook(WEBHOOK_ID));

    expect(writes).toHaveLength(3);
    for (const write of writes) {
      expect(write).toMatchObject({
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        organizationId: ORG,
        actorType: 'UI',
        actorId: 'u-1',
        actorLabel: 'admin@example.com',
        requestId: 'req-1',
        method: 'POST',
        path: '/api/v1/organization/webhooks',
        ipAddress: '203.0.113.9',
        userAgent: 'vitest',
      });
    }
  });

  it('omits metadata rather than writing a json null', async () => {
    const { service, writes, run } = build();

    await run(() => service.createWebhook(createDto));

    expect('metadata' in writes[0]).toBe(false);
  });

  it('writes the creation event through the same transaction client as the webhook insert', async () => {
    const { service, transactionClients, client, tx, run } = build();

    await run(() => service.createWebhook(createDto));

    expect(tx.webhook.create).toHaveBeenCalledOnce();
    expect(client.webhook.create).not.toHaveBeenCalled();
    expect(transactionClients).toEqual([tx]);
  });

  it('writes the update event through the same transaction client as the webhook update', async () => {
    const { service, transactionClients, client, tx, run } = build();

    await run(() => service.updateWebhook(WEBHOOK_ID, updateDto));

    expect(tx.webhook.update).toHaveBeenCalledOnce();
    expect(client.webhook.update).not.toHaveBeenCalled();
    expect(transactionClients).toEqual([tx]);
  });

  it('soft deletes through the transaction client, so the deletion event shares its fate', async () => {
    const { service, transactionClients, client, tx, run } = build();

    await run(() => service.deleteWebhook(WEBHOOK_ID));

    expect(tx.webhook.update).toHaveBeenCalledWith({
      where: { id: WEBHOOK_ID },
      data: { deletedAt: expect.any(Date) },
    });
    expect(client.webhook.update).not.toHaveBeenCalled();
    expect(transactionClients).toEqual([tx]);
  });

  it('records nothing when a delivery failure count is reset', async () => {
    const { webhookService, writes, client } = build();

    await webhookService.resetFailureCount(WEBHOOK_ID);

    expect(client.webhook.update).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it('records nothing when a delivery retry increments the failure count', async () => {
    const { webhookService, writes, client } = build();

    await webhookService.incrementFailureCount(WEBHOOK_ID);

    expect(client.webhook.update).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it('records nothing and opens no transaction when a non-https endpoint is refused', async () => {
    const { service, writes, client, run } = build();
    const dto = { endpoint: 'http://hooks.example.com/brokkr', events: [] } as unknown as CreateWebhookDTO;

    await run(() => expect(service.createWebhook(dto)).rejects.toBeInstanceOf(HttpException));

    expect(writes).toEqual([]);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('records nothing and opens no transaction when a private-ip endpoint is refused', async () => {
    const { service, writes, client, run } = build();
    const dto = { endpoint: 'https://10.0.0.5/brokkr', events: [] } as unknown as CreateWebhookDTO;

    await run(() => expect(service.createWebhook(dto)).rejects.toBeInstanceOf(HttpException));

    expect(writes).toEqual([]);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('supersedes the permission intent only after the transaction resolves', async () => {
    const { service, contextService, run } = build();
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await run(() => service.createWebhook(createDto));

    expect(finalize).toHaveBeenCalledOnce();
  });

  it('leaves the delete intent unfinalized when the event write fails', async () => {
    const { service, contextService, eventLog, run } = build();
    eventLog.recordInTransaction.mockRejectedValueOnce(new Error('event write failed'));
    const finalize = vi.spyOn(contextService, 'finalizeIntents');
    let pending: PermissionIntent[] = [];

    await run(async () => {
      await service.deleteWebhook(WEBHOOK_ID).catch(() => undefined);
      pending = contextService.drainIntents();
    });

    expect(finalize).not.toHaveBeenCalled();
    expect(pending).toEqual([
      expect.objectContaining({ resource: 'webhook', action: 'delete', denied: false, finalized: false }),
    ]);
  });
});

const AUDITED: [keyof OrganizationWebhooksController, string, string][] = [
  ['createWebhook', 'webhook.created', 'create'],
  ['updateWebhook', 'webhook.updated', 'update'],
  ['deleteWebhook', 'webhook.deleted', 'delete'],
];

describe('OrganizationWebhooksController audit actions', () => {
  const reflector = new Reflector();
  const auditOptions = (method: keyof OrganizationWebhooksController) =>
    reflector.get<AuditActionOptions | undefined>(AUDIT_ACTION_KEY, OrganizationWebhooksController.prototype[method]);

  it.each(AUDITED)('keys a denied or failed %s to the key its success emits', (method, actionKey, action) => {
    expect(auditOptions(method)).toMatchObject({ actionKey, resource: 'webhook', action });
  });

  it.each(AUDITED)('names a catalog mutating permission on %s, so the gate intent survives the filter', (method) => {
    const options = auditOptions(method);

    expect(options).toBeDefined();
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, permissionKey(options!.resource, options!.action))).toBe(true);
  });

  it('leaves the read handlers undecorated', () => {
    expect(auditOptions('listWebhooks')).toBeUndefined();
    expect(auditOptions('getWebhook')).toBeUndefined();
    expect(auditOptions('getWebhookStats')).toBeUndefined();
  });
});
