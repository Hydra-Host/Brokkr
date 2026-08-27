import { Reflector } from '@nestjs/core';
import { createPrismaClientOptions } from '@repo/database';
import { randomUUID } from 'crypto';
import { from } from 'rxjs';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { EventLogInterceptor } from 'src/event-log/event-log.interceptor';
import { EventLogRepository } from 'src/event-log/event-log.repository';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { WebhookDeliveryRepository } from 'src/webhook/webhook-delivery.repository';
import { WebhookRepository } from 'src/webhook/webhook.repository';
import { WebhookService } from 'src/webhook/webhook.service';
import type { CreateWebhookDTO, UpdateWebhookDTO } from 'src/webhook/webhook.types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrganizationWebhooksController } from '../organization-webhooks.controller';
import { OrganizationWebhooksService } from '../organization-webhooks.service';

const connectionString = process.env.DATABASE_URL;
const ACTOR_PERMS = ['webhook:create', 'webhook:update', 'webhook:delete', 'webhook:read'];

describe.skipIf(!connectionString)('webhook event capture (integration, live DB)', () => {
  let prisma: PrismaClient;
  let contextService: ContextService;
  let webhookService: WebhookService;
  let organizationId: string;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  function identity(permissions: string[] = ACTOR_PERMS): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Admin',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(permissions),
      session: { user: { id: 'u-int-1', email: 'int@example.com' } },
    } as unknown as IdentityContext;
  }

  const realEventLog = () => new EventLogService(new EventLogRepository(prisma), logger as never, contextService);

  const throwingEventLog = () =>
    ({
      recordInTransaction: vi.fn().mockRejectedValue(new Error('event write failed')),
    }) as unknown as EventLogService;

  function buildService(eventLog: EventLogService) {
    return new OrganizationWebhooksService(contextService, webhookService, {} as never, eventLog, prisma);
  }

  const endpoint = () => `https://hooks.example.com/${randomUUID()}`;

  const createDto = (): CreateWebhookDTO => ({ endpoint: endpoint(), events: [] }) as unknown as CreateWebhookDTO;

  const updateDto = (target: string): UpdateWebhookDTO =>
    ({ endpoint: target, events: [], isActive: true }) as unknown as UpdateWebhookDTO;

  async function makeWebhook() {
    return prisma.webhook.create({
      data: { endpoint: endpoint(), events: [], secret: 's3cr3t', organizationId },
    });
  }

  const eventsFor = (targetId: string) =>
    prisma.eventLog.findMany({ where: { organizationId, targetId }, orderBy: { createdAt: 'asc' } });

  const runInContext = <T>(fn: () => Promise<T>, requestId = `req-${randomUUID()}`): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId,
          identity: identity(),
          method: 'POST',
          path: '/api/v1/organization/webhooks',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          fn().then(resolve, reject);
        },
      );
    });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function settledRowsFor(requestId: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await prisma.eventLog.findMany({ where: { organizationId, requestId } });
      if (rows.length > 0) {
        await sleep(150);
        return prisma.eventLog.findMany({ where: { organizationId, requestId } });
      }
      await sleep(20);
    }
    return [];
  }

  async function throughInterceptor(args: {
    handler: (...handlerArgs: never[]) => unknown;
    eventLog: EventLogService;
    invoke: (service: OrganizationWebhooksService) => Promise<unknown>;
    permissions?: string[];
  }): Promise<string> {
    const service = buildService(args.eventLog);
    const interceptor = new EventLogInterceptor(contextService, realEventLog(), new Reflector(), logger as never);
    const requestId = `req-${randomUUID()}`;
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          path: '/api/v1/organization/webhooks',
          params: {},
          ip: '203.0.113.9',
          headers: { 'user-agent': 'vitest' },
        }),
      }),
      getHandler: () => args.handler,
    };

    await new Promise<void>((resolve) => {
      contextService.run(
        {
          requestId,
          identity: identity(args.permissions),
          method: 'POST',
          path: '/api/v1/organization/webhooks',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          interceptor
            .intercept(executionContext as never, { handle: () => from(args.invoke(service)) })
            .subscribe({ error: () => resolve(), complete: () => resolve() });
        },
      );
    });

    return requestId;
  }

  beforeAll(async () => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    contextService = new ContextService(new DesignationOperatorPolicy());
    webhookService = new WebhookService(
      new WebhookRepository(prisma),
      new WebhookDeliveryRepository(prisma),
      logger as never,
    );

    const org = await prisma.organization.create({
      data: { name: `it-wh-evlog-${randomUUID()}`, tenantType: 'SupplyCustomer' },
    });
    organizationId = org.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.webhookDelivery.deleteMany({ where: { webhook: { organizationId } } });
    await prisma.webhook.deleteMany({ where: { organizationId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  describe('create', () => {
    it('persists an atomic evidence row alongside the webhook', async () => {
      const service = buildService(realEventLog());
      const dto = createDto();

      const created = await runInContext(() => service.createWebhook(dto));

      const rows = await eventsFor(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'webhook.created',
        resource: 'webhook',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        targetLabel: dto.endpoint,
        actorId: 'u-int-1',
        actorLabel: 'int@example.com',
      });
      expect(rows[0].metadata).toBeNull();

      const webhook = await prisma.webhook.findUniqueOrThrow({ where: { id: created.id } });
      expect(webhook.endpoint).toBe(dto.endpoint);
    });

    it('rolls the webhook back when the event write fails', async () => {
      const service = buildService(throwingEventLog());
      const dto = createDto();

      await expect(runInContext(() => service.createWebhook(dto))).rejects.toThrow('event write failed');

      expect(await prisma.webhook.findMany({ where: { organizationId, endpoint: dto.endpoint } })).toEqual([]);
    });

    it('writes no evidence row when a non-https endpoint is refused', async () => {
      const service = buildService(realEventLog());
      const requestId = `req-${randomUUID()}`;
      const dto = { endpoint: 'http://hooks.example.com/refused', events: [] } as unknown as CreateWebhookDTO;

      await expect(runInContext(() => service.createWebhook(dto), requestId)).rejects.toThrow(
        'Endpoint must be a public HTTPS URL',
      );

      expect(await prisma.eventLog.findMany({ where: { organizationId, requestId } })).toEqual([]);
    });

    it('writes no evidence row when a private-ip endpoint is refused', async () => {
      const service = buildService(realEventLog());
      const requestId = `req-${randomUUID()}`;
      const dto = { endpoint: 'https://10.0.0.5/refused', events: [] } as unknown as CreateWebhookDTO;

      await expect(runInContext(() => service.createWebhook(dto), requestId)).rejects.toThrow(
        'Endpoint must be a public HTTPS URL',
      );

      expect(await prisma.eventLog.findMany({ where: { organizationId, requestId } })).toEqual([]);
    });
  });

  describe('update', () => {
    it('persists an atomic evidence row alongside the endpoint change', async () => {
      const webhook = await makeWebhook();
      const service = buildService(realEventLog());
      const target = endpoint();

      await runInContext(() => service.updateWebhook(webhook.id, updateDto(target)));

      const rows = await eventsFor(webhook.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'webhook.updated',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        targetLabel: target,
      });

      const updated = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
      expect(updated.endpoint).toBe(target);
    });

    it('rolls the endpoint change back when the event write fails', async () => {
      const webhook = await makeWebhook();
      const service = buildService(throwingEventLog());

      await expect(runInContext(() => service.updateWebhook(webhook.id, updateDto(endpoint())))).rejects.toThrow(
        'event write failed',
      );

      const unchanged = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
      expect(unchanged.endpoint).toBe(webhook.endpoint);
      expect(await eventsFor(webhook.id)).toEqual([]);
    });
  });

  describe('delete', () => {
    it('persists an atomic evidence row alongside the soft delete', async () => {
      const webhook = await makeWebhook();
      const service = buildService(realEventLog());

      await runInContext(() => service.deleteWebhook(webhook.id));

      const rows = await eventsFor(webhook.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'webhook.deleted',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        targetLabel: webhook.endpoint,
      });

      const deleted = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
      expect(deleted.deletedAt).not.toBeNull();
    });

    it('rolls the soft delete back when the event write fails', async () => {
      const webhook = await makeWebhook();
      const service = buildService(throwingEventLog());

      await expect(runInContext(() => service.deleteWebhook(webhook.id))).rejects.toThrow('event write failed');

      const survivor = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
      expect(survivor.deletedAt).toBeNull();
      expect(await eventsFor(webhook.id)).toEqual([]);
    });
  });

  describe('delivery health bookkeeping', () => {
    it('writes no event when a delivery retry increments the failure count', async () => {
      const webhook = await makeWebhook();

      await webhookService.incrementFailureCount(webhook.id);

      const bumped = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
      expect(bumped.failureCount).toBe(1);
      expect(await eventsFor(webhook.id)).toEqual([]);
    });

    it('writes no event when a successful delivery resets the failure count', async () => {
      const webhook = await makeWebhook();
      await webhookService.incrementFailureCount(webhook.id);

      await webhookService.resetFailureCount(webhook.id);

      const reset = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
      expect(reset.failureCount).toBe(0);
      expect(await eventsFor(webhook.id)).toEqual([]);
    });
  });

  describe('tier 2 fallback', () => {
    it('records a failed delete attempt when the rollback leaves the intent unfinalized', async () => {
      const webhook = await makeWebhook();
      const requestId = await throughInterceptor({
        handler: OrganizationWebhooksController.prototype.deleteWebhook,
        eventLog: throwingEventLog(),
        invoke: (service) => service.deleteWebhook(webhook.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'webhook.deleted',
        resource: 'webhook',
        action: 'delete',
        outcome: 'FAILED',
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
      });

      const survivor = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
      expect(survivor.deletedAt).toBeNull();
    });

    it('records a refused non-https creation as a failed webhook.created attempt', async () => {
      const dto = { endpoint: 'http://hooks.example.com/refused', events: [] } as unknown as CreateWebhookDTO;

      const requestId = await throughInterceptor({
        handler: OrganizationWebhooksController.prototype.createWebhook,
        eventLog: realEventLog(),
        invoke: (service) => service.createWebhook(dto),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'webhook.created',
        resource: 'webhook',
        action: 'create',
        outcome: 'FAILED',
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
      });
      expect(await prisma.webhook.findMany({ where: { organizationId, endpoint: dto.endpoint } })).toEqual([]);
    });

    it('records a denied creation under the key its success emits', async () => {
      const requestId = await throughInterceptor({
        handler: OrganizationWebhooksController.prototype.createWebhook,
        eventLog: realEventLog(),
        permissions: [],
        invoke: (service) => service.createWebhook(createDto()),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'webhook.created',
        action: 'create',
        outcome: 'DENIED',
        tier: 'ACTIVITY',
      });
    });

    it('records a denied update under the key its success emits', async () => {
      const requestId = await throughInterceptor({
        handler: OrganizationWebhooksController.prototype.updateWebhook,
        eventLog: realEventLog(),
        permissions: [],
        invoke: (service) => service.updateWebhook(randomUUID(), updateDto(endpoint())),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'webhook.updated',
        action: 'update',
        outcome: 'DENIED',
        tier: 'ACTIVITY',
      });
    });

    it('records a denied deletion under the key its success emits', async () => {
      const requestId = await throughInterceptor({
        handler: OrganizationWebhooksController.prototype.deleteWebhook,
        eventLog: realEventLog(),
        permissions: [],
        invoke: (service) => service.deleteWebhook(randomUUID()),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'webhook.deleted',
        action: 'delete',
        outcome: 'DENIED',
        tier: 'ACTIVITY',
      });
    });
  });

  describe('one row per successful action', () => {
    it('leaves a successful creation with its evidence row alone', async () => {
      const dto = createDto();
      const requestId = await throughInterceptor({
        handler: OrganizationWebhooksController.prototype.createWebhook,
        eventLog: realEventLog(),
        invoke: (service) => service.createWebhook(dto),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'webhook.created', tier: 'EVIDENCE', outcome: 'SUCCEEDED' });
    });

    it('leaves a successful update with its evidence row alone', async () => {
      const webhook = await makeWebhook();
      const requestId = await throughInterceptor({
        handler: OrganizationWebhooksController.prototype.updateWebhook,
        eventLog: realEventLog(),
        invoke: (service) => service.updateWebhook(webhook.id, updateDto(endpoint())),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'webhook.updated', tier: 'EVIDENCE', outcome: 'SUCCEEDED' });
    });

    it('leaves a successful deletion with its evidence row alone', async () => {
      const webhook = await makeWebhook();
      const requestId = await throughInterceptor({
        handler: OrganizationWebhooksController.prototype.deleteWebhook,
        eventLog: realEventLog(),
        invoke: (service) => service.deleteWebhook(webhook.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'webhook.deleted', tier: 'EVIDENCE', outcome: 'SUCCEEDED' });
    });
  });
});
