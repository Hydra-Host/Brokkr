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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrganizationApiKeysController } from '../organization-api-keys.controller';
import { OrganizationApiKeysService } from '../organization-api-keys.service';

const connectionString = process.env.DATABASE_URL;
const MANAGE_PERMS = ['api-key:create', 'api-key:update', 'api-key:delete'];

describe.skipIf(!connectionString)('api key event capture (integration, live DB)', () => {
  let prisma: PrismaClient;
  let contextService: ContextService;
  let organizationId: string;
  let userId: string;
  let otherUserId: string;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const rbacResolver = { resolveEffectivePermissions: vi.fn().mockResolvedValue(new Set(['device:read'])) };

  function sessionIdentity(permissions: string[]): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Admin',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(permissions),
      session: {
        user: { id: userId, email: 'keys-int@example.com', name: 'Keys Int', firstName: 'Keys', lastName: 'Int' },
      },
    } as unknown as IdentityContext;
  }

  function apiKeyIdentity(permissions: string[], actingKeyId: string): IdentityContext {
    return {
      authType: AuthType.ApiKey,
      role: 'Admin',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(permissions),
      user: { id: userId, email: 'keys-int@example.com', name: 'Keys Int', firstName: 'Keys', lastName: 'Int' },
      apiKey: { id: actingKeyId, name: 'ci-runner', referenceId: userId },
    } as unknown as IdentityContext;
  }

  function betterAuthResult(id: string, name: string) {
    return {
      id,
      name,
      start: null,
      prefix: null,
      key: `brk_${randomUUID()}`,
      referenceId: userId,
      enabled: true,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      requestCount: 0,
      remaining: null,
      lastRequest: null,
      metadata: null,
    };
  }

  function authClientFor(created: { id: string; name: string }) {
    return {
      api: {
        createApiKey: vi.fn().mockResolvedValue(betterAuthResult(created.id, created.name)),
        updateApiKey: vi.fn().mockResolvedValue({ id: created.id }),
        deleteApiKey: vi.fn().mockResolvedValue({ success: true }),
      },
    };
  }

  const realEventLog = () => new EventLogService(new EventLogRepository(prisma), logger as never, contextService);

  const throwingEventLog = () =>
    ({
      record: vi.fn().mockRejectedValue(new Error('event write failed')),
      recordInTransaction: vi.fn().mockRejectedValue(new Error('event write failed')),
    }) as unknown as EventLogService;

  function buildService(eventLog: EventLogService, authClient: { api: Record<string, unknown> }) {
    return new OrganizationApiKeysService(
      contextService,
      prisma,
      authClient as never,
      rbacResolver as never,
      eventLog,
      logger as never,
    );
  }

  async function makeKey(args: { ownerUserId?: string; scoped?: boolean; name?: string } = {}) {
    const key = await prisma.apiKey.create({
      data: {
        name: args.name ?? `int-key-${randomUUID().slice(0, 8)}`,
        key: `brk_${randomUUID()}`,
        userId: args.ownerUserId ?? userId,
        organizationId: args.scoped === false ? null : organizationId,
      },
    });
    return { id: key.id, name: key.name ?? '' };
  }

  const runInContext = <T>(identity: IdentityContext, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId: `req-${randomUUID()}`,
          identity,
          method: 'POST',
          path: '/api/v1/organizations/api-keys',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          fn().then(resolve, reject);
        },
      );
    });

  const eventsFor = (targetId: string) =>
    prisma.eventLog.findMany({ where: { organizationId, targetId }, orderBy: { createdAt: 'asc' } });

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
    identity: IdentityContext;
    invoke: (service: OrganizationApiKeysService) => Promise<unknown>;
    serviceEventLog: EventLogService;
    authClient: { api: Record<string, unknown> };
  }): Promise<string> {
    const interceptorEventLog = realEventLog();
    const service = buildService(args.serviceEventLog, args.authClient);
    const interceptor = new EventLogInterceptor(contextService, interceptorEventLog, new Reflector(), logger as never);
    const requestId = `req-${randomUUID()}`;
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          path: '/api/v1/organizations/api-keys',
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
          identity: args.identity,
          method: 'POST',
          path: '/api/v1/organizations/api-keys',
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

    const org = await prisma.organization.create({
      data: { name: `it-keylog-${randomUUID()}`, tenantType: 'SupplyCustomer' },
    });
    organizationId = org.id;

    const user = await prisma.user.create({
      data: { email: `keys-int-${randomUUID()}@example.com`, name: 'Keys Int', firstName: 'Keys', lastName: 'Int' },
    });
    userId = user.id;

    const other = await prisma.user.create({
      data: { email: `keys-other-${randomUUID()}@example.com`, name: 'Other', firstName: 'Oth', lastName: 'Er' },
    });
    otherUserId = other.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.apiKey.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  describe('revocation (class A, atomic)', () => {
    it('persists an atomic evidence row alongside the delete', async () => {
      const key = await makeKey({ ownerUserId: otherUserId });
      const service = buildService(realEventLog(), authClientFor(key));

      await runInContext(sessionIdentity(MANAGE_PERMS), () => service.deleteApiKey(key.id));

      const rows = await eventsFor(key.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'api-key.revoked',
        resource: 'api-key',
        action: 'revoked',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        actorType: 'UI',
        actorId: userId,
        actorLabel: 'keys-int@example.com',
        targetLabel: key.name,
      });
      expect(rows[0].metadata).toBeNull();
      expect(await prisma.apiKey.findUnique({ where: { id: key.id } })).toBeNull();
    });

    it('rolls the delete back when the event write fails', async () => {
      const key = await makeKey({ ownerUserId: otherUserId });
      const service = buildService(throwingEventLog(), authClientFor(key));

      await expect(runInContext(sessionIdentity(MANAGE_PERMS), () => service.deleteApiKey(key.id))).rejects.toThrow(
        'event write failed',
      );

      expect(await prisma.apiKey.findUnique({ where: { id: key.id } })).not.toBeNull();
      expect(await eventsFor(key.id)).toEqual([]);
    });

    it('records the request provenance', async () => {
      const key = await makeKey({ ownerUserId: otherUserId });
      const service = buildService(realEventLog(), authClientFor(key));

      await runInContext(sessionIdentity(MANAGE_PERMS), () => service.deleteApiKey(key.id));

      const [row] = await eventsFor(key.id);
      expect(row.requestId).toMatch(/^req-/);
      expect(row.method).toBe('POST');
      expect(row.path).toBe('/api/v1/organizations/api-keys');
      expect(row.ipAddress).toBe('203.0.113.9');
      expect(row.userAgent).toBe('vitest');
    });
  });

  describe('creation (class B, post-commit)', () => {
    it('persists a post-commit evidence row once the org scope is written', async () => {
      const key = await makeKey({ scoped: false, name: 'ci' });
      const service = buildService(realEventLog(), authClientFor(key));

      await runInContext(sessionIdentity(MANAGE_PERMS), () => service.createApiKey({}, { name: 'ci' }));

      const rows = await eventsFor(key.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'api-key.created',
        tier: 'EVIDENCE',
        durability: 'POST_COMMIT',
        outcome: 'SUCCEEDED',
        targetLabel: 'ci',
      });
      expect(rows[0].metadata).toEqual({ scope: 'inherit' });
      const scoped = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
      expect(scoped.organizationId).toBe(organizationId);
    });

    it('records the granted scope on an explicit selection', async () => {
      const key = await makeKey({ scoped: false, name: 'ci-scoped' });
      const service = buildService(realEventLog(), authClientFor(key));

      await runInContext(sessionIdentity([...MANAGE_PERMS, 'device:read']), () =>
        service.createApiKey({}, { name: 'ci-scoped', permissions: ['device:read'] }),
      );

      const [row] = await eventsFor(key.id);
      expect(row.metadata).toEqual({ scope: 'explicit', grantedKeys: ['device:read'] });
    });

    it('keeps the key and lets tier 2 record when the post-commit insert fails', async () => {
      const key = await makeKey({ scoped: false, name: 'ci-lost' });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.createApiKey,
        identity: sessionIdentity(MANAGE_PERMS),
        serviceEventLog: throwingEventLog(),
        authClient: authClientFor(key),
        invoke: (service) => service.createApiKey({}, { name: 'ci-lost' }),
      });

      expect(await prisma.apiKey.findUnique({ where: { id: key.id } })).not.toBeNull();

      const rows = await settledRowsFor(requestId);
      expect(rows.filter((row) => row.durability === 'POST_COMMIT')).toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'api-key.created',
        resource: 'api-key',
        action: 'create',
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
        outcome: 'SUCCEEDED',
        targetId: key.id,
      });
    });

    it('records nothing when the org-scope update is compensated', async () => {
      const absentId = randomUUID();
      const authClient = authClientFor({ id: absentId, name: 'ci-orphan' });
      const service = buildService(realEventLog(), authClient);

      await expect(
        runInContext(sessionIdentity(MANAGE_PERMS), () => service.createApiKey({}, { name: 'ci-orphan' })),
      ).rejects.toThrow();

      expect(authClient.api.deleteApiKey).toHaveBeenCalledWith(expect.objectContaining({ body: { keyId: absentId } }));
      expect(await eventsFor(absentId)).toEqual([]);
    });

    it('attributes a key-authenticated creation to the owning user and names the acting key', async () => {
      const actingKey = await makeKey({ name: 'ci-runner' });
      const key = await makeKey({ scoped: false, name: 'ci-by-key' });
      const service = buildService(realEventLog(), authClientFor(key));

      await runInContext(apiKeyIdentity(MANAGE_PERMS, actingKey.id), () =>
        service.createApiKey({}, { name: 'ci-by-key' }),
      );

      const [row] = await eventsFor(key.id);
      expect(row).toMatchObject({
        actorType: 'API',
        actorId: userId,
        actorLabel: 'keys-int@example.com',
        apiKeyId: actingKey.id,
        apiKeyLabel: 'ci-runner',
      });
    });
  });

  describe('scope change (class B, post-commit)', () => {
    it('persists a post-commit evidence row', async () => {
      const key = await makeKey({ ownerUserId: otherUserId, name: 'deploy-bot' });
      const service = buildService(realEventLog(), authClientFor(key));

      await runInContext(sessionIdentity(MANAGE_PERMS), () => service.updateApiKey(key.id, null));

      const rows = await eventsFor(key.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'api-key.scope-changed',
        resource: 'api-key',
        action: 'scope-changed',
        tier: 'EVIDENCE',
        durability: 'POST_COMMIT',
        outcome: 'SUCCEEDED',
        targetLabel: 'deploy-bot',
      });
      expect(rows[0].metadata).toEqual({ scope: 'inherit' });
    });
  });

  describe('own-key management (no api-key permission held)', () => {
    it('persists a revocation row for the caller own key', async () => {
      const key = await makeKey({ name: 'my-own-key' });
      const service = buildService(realEventLog(), authClientFor(key));

      await runInContext(sessionIdentity([]), () => service.deleteApiKey(key.id));

      const rows = await eventsFor(key.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'api-key.revoked', durability: 'ATOMIC', targetLabel: 'my-own-key' });
      expect(await prisma.apiKey.findUnique({ where: { id: key.id } })).toBeNull();
    });

    it('persists a scope-change row for the caller own key', async () => {
      const key = await makeKey({ name: 'my-other-key' });
      const service = buildService(realEventLog(), authClientFor(key));

      await runInContext(sessionIdentity([]), () => service.updateApiKey(key.id, null));

      const rows = await eventsFor(key.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'api-key.scope-changed', durability: 'POST_COMMIT' });
    });

    it('lets tier 2 record a failed own-key revocation', async () => {
      const key = await makeKey({ name: 'my-doomed-key' });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.deleteApiKey,
        identity: sessionIdentity([]),
        serviceEventLog: throwingEventLog(),
        authClient: authClientFor(key),
        invoke: (service) => service.deleteApiKey(key.id),
      });

      expect(await prisma.apiKey.findUnique({ where: { id: key.id } })).not.toBeNull();

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'api-key.revoked',
        resource: 'api-key',
        action: 'delete',
        tier: 'ACTIVITY',
        outcome: 'FAILED',
      });
    });
  });
  describe('audited handlers write exactly one row per success', () => {
    it('records a cross-user revocation once', async () => {
      const key = await makeKey({ ownerUserId: otherUserId });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.deleteApiKey,
        identity: sessionIdentity(MANAGE_PERMS),
        serviceEventLog: realEventLog(),
        authClient: authClientFor(key),
        invoke: (service) => service.deleteApiKey(key.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'api-key.revoked', tier: 'EVIDENCE', durability: 'ATOMIC' });
    });

    it('records a creation once', async () => {
      const key = await makeKey({ scoped: false, name: 'ci-once' });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.createApiKey,
        identity: sessionIdentity(MANAGE_PERMS),
        serviceEventLog: realEventLog(),
        authClient: authClientFor(key),
        invoke: (service) => service.createApiKey({}, { name: 'ci-once' }),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'api-key.created', tier: 'EVIDENCE', durability: 'POST_COMMIT' });
    });

    it('records a cross-user scope change once', async () => {
      const key = await makeKey({ ownerUserId: otherUserId });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.updateApiKey,
        identity: sessionIdentity(MANAGE_PERMS),
        serviceEventLog: realEventLog(),
        authClient: authClientFor(key),
        invoke: (service) => service.updateApiKey(key.id, null),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'api-key.scope-changed', tier: 'EVIDENCE', durability: 'POST_COMMIT' });
    });

    it('records an own-key revocation once, minting no synthetic intent alongside it', async () => {
      const key = await makeKey({ name: 'own-once' });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.deleteApiKey,
        identity: sessionIdentity([]),
        serviceEventLog: realEventLog(),
        authClient: authClientFor(key),
        invoke: (service) => service.deleteApiKey(key.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'api-key.revoked',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        targetLabel: 'own-once',
      });
      expect(rows.filter((row) => row.tier === 'ACTIVITY')).toEqual([]);
    });

    it('records an own-key scope change once, minting no synthetic intent alongside it', async () => {
      const key = await makeKey({ name: 'own-scope-once' });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.updateApiKey,
        identity: sessionIdentity([]),
        serviceEventLog: realEventLog(),
        authClient: authClientFor(key),
        invoke: (service) => service.updateApiKey(key.id, null),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'api-key.scope-changed', tier: 'EVIDENCE' });
      expect(rows.filter((row) => row.tier === 'ACTIVITY')).toEqual([]);
    });
  });

  describe('denied attempts carry the tier 1 action key', () => {
    it('records a refused cross-user revocation as api-key.revoked', async () => {
      const key = await makeKey({ ownerUserId: otherUserId });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.deleteApiKey,
        identity: sessionIdentity([]),
        serviceEventLog: realEventLog(),
        authClient: authClientFor(key),
        invoke: (service) => service.deleteApiKey(key.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'api-key.revoked',
        resource: 'api-key',
        action: 'delete',
        tier: 'ACTIVITY',
        outcome: 'DENIED',
      });
      expect(await prisma.apiKey.findUnique({ where: { id: key.id } })).not.toBeNull();
    });

    it('records a refused creation as api-key.created', async () => {
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.createApiKey,
        identity: sessionIdentity([]),
        serviceEventLog: realEventLog(),
        authClient: authClientFor({ id: randomUUID(), name: 'ci-denied' }),
        invoke: (service) => service.createApiKey({}, { name: 'ci-denied' }),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'api-key.created', action: 'create', outcome: 'DENIED' });
    });

    it('records a refused cross-user scope change as api-key.scope-changed', async () => {
      const key = await makeKey({ ownerUserId: otherUserId });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.updateApiKey,
        identity: sessionIdentity([]),
        serviceEventLog: realEventLog(),
        authClient: authClientFor(key),
        invoke: (service) => service.updateApiKey(key.id, null),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'api-key.scope-changed', action: 'update', outcome: 'DENIED' });
    });

    it('leaves no creation row when the org-scope update is compensated', async () => {
      const absentId = randomUUID();
      const authClient = authClientFor({ id: absentId, name: 'ci-orphan-audited' });
      const requestId = await throughInterceptor({
        handler: OrganizationApiKeysController.prototype.createApiKey,
        identity: sessionIdentity(MANAGE_PERMS),
        serviceEventLog: realEventLog(),
        authClient,
        invoke: (service) => service.createApiKey({}, { name: 'ci-orphan-audited' }),
      });

      expect(authClient.api.deleteApiKey).toHaveBeenCalledWith(expect.objectContaining({ body: { keyId: absentId } }));
      expect(await eventsFor(absentId)).toEqual([]);

      const rows = await settledRowsFor(requestId);
      expect(rows.filter((row) => row.tier === 'EVIDENCE')).toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'api-key.created', tier: 'ACTIVITY', outcome: 'FAILED' });
    });
  });
});
