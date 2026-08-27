import { Reflector } from '@nestjs/core';
import { isMutatingPermission, MAIN_APP_PERMISSIONS, permissionKey } from '@repo/auth/rbac';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService, type PermissionIntent } from 'src/common/context/context.service';
import { AUDIT_ACTION_KEY, type AuditActionOptions } from 'src/event-log/audit-action.decorator';
import { EventLogService } from 'src/event-log/event-log.service';
import type { EventLogWrite } from 'src/event-log/event-log.types';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationApiKeysController } from '../organization-api-keys.controller';
import { OrganizationApiKeysService } from '../organization-api-keys.service';

const intentKey = (intent: PermissionIntent) => permissionKey(intent.resource, intent.action);

const ORG = 'org-1';
const USER = 'u-1';
const OTHER_USER = 'u-2';
const KEY_ID = 'key-1';
const CREATED_KEY_ID = 'key-new';

function sessionIdentity(permissions: string[]): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Admin',
    organizationId: ORG,
    organization: { id: ORG },
    permissions: new Set(permissions),
    session: { user: { id: USER, email: 'admin@example.com', name: 'Admin', firstName: 'Ada', lastName: 'Min' } },
  } as unknown as IdentityContext;
}

function apiKeyIdentity(permissions: string[]): IdentityContext {
  return {
    authType: AuthType.ApiKey,
    role: 'Admin',
    organizationId: ORG,
    organization: { id: ORG },
    permissions: new Set(permissions),
    user: { id: USER, email: 'admin@example.com', name: 'Admin', firstName: 'Ada', lastName: 'Min' },
    apiKey: { id: 'ak-9', name: 'ci-runner', referenceId: USER },
  } as unknown as IdentityContext;
}

function build(args: { identity?: IdentityContext; ownerUserId?: string } = {}) {
  const writes: EventLogWrite[] = [];
  const apiKeyDelegate = {
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    findUnique: vi.fn().mockResolvedValue({
      id: KEY_ID,
      organizationId: ORG,
      userId: args.ownerUserId ?? OTHER_USER,
      name: 'deploy-bot',
      start: null,
      prefix: null,
      enabled: true,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      requestCount: 0,
      remaining: null,
      lastRequest: null,
      metadata: null,
      permissions: null,
      user: { name: 'Admin', email: 'admin@example.com', members: [] },
    }),
  };
  const tx = { apiKey: apiKeyDelegate };
  const prisma = {
    apiKey: apiKeyDelegate,
    member: { findFirst: vi.fn().mockResolvedValue({ assignedRoleId: 'role-1' }) },
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };

  const eventLog = {
    record: vi.fn(async (write: EventLogWrite) => {
      writes.push(write);
    }),
    recordInTransaction: vi.fn(async (client: unknown, write: EventLogWrite) => {
      expect(client).toBe(tx);
      writes.push(write);
    }),
  };

  const authClient = {
    api: {
      createApiKey: vi.fn().mockResolvedValue({
        id: CREATED_KEY_ID,
        name: 'ci',
        start: null,
        prefix: null,
        key: 'brk_PLAINTEXT_SECRET',
        referenceId: USER,
        enabled: true,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        requestCount: 0,
        remaining: null,
        lastRequest: null,
        metadata: null,
      }),
      updateApiKey: vi.fn().mockResolvedValue({ id: KEY_ID }),
      deleteApiKey: vi.fn().mockResolvedValue({ success: true }),
    },
  };

  const rbacResolver = { resolveEffectivePermissions: vi.fn().mockResolvedValue(new Set(['device:read'])) };
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const service = new OrganizationApiKeysService(
    contextService,
    prisma as never,
    authClient as never,
    rbacResolver as never,
    eventLog as never,
    logger as never,
  );

  const identity = args.identity ?? sessionIdentity(['api-key:create', 'api-key:update', 'api-key:delete']);
  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId: 'req-1',
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

  return { service, contextService, prisma, apiKeyDelegate, authClient, eventLog, logger, writes, run };
}

describe('OrganizationApiKeysService event capture', () => {
  it('records a revocation as one atomic evidence row on the delete transaction', async () => {
    const { service, eventLog, writes, run } = build();

    await run(() => service.deleteApiKey(KEY_ID));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      organizationId: ORG,
      resource: 'api-key',
      action: 'revoked',
      actionKey: 'api-key.revoked',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      outcome: 'SUCCEEDED',
      targetId: KEY_ID,
      targetLabel: 'deploy-bot',
    });
    expect(eventLog.recordInTransaction).toHaveBeenCalledOnce();
    expect(eventLog.record).not.toHaveBeenCalled();
  });

  it('omits metadata rather than sending null when a revocation carries none', async () => {
    const { service, writes, run } = build();

    await run(() => service.deleteApiKey(KEY_ID));

    expect(writes[0]).not.toHaveProperty('metadata');
  });

  it('fails the revocation when the atomic insert fails', async () => {
    const { service, eventLog, apiKeyDelegate, run } = build();
    eventLog.recordInTransaction.mockRejectedValueOnce(new Error('event write failed'));

    await expect(run(() => service.deleteApiKey(KEY_ID))).rejects.toThrow('event write failed');

    expect(apiKeyDelegate.delete).toHaveBeenCalledWith({ where: { id: KEY_ID } });
  });

  it('records a creation as a post-commit evidence row', async () => {
    const { service, eventLog, writes, run } = build();

    await run(() => service.createApiKey({}, { name: 'ci' }));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'api-key',
      action: 'created',
      actionKey: 'api-key.created',
      tier: 'EVIDENCE',
      durability: 'POST_COMMIT',
      outcome: 'SUCCEEDED',
      targetId: CREATED_KEY_ID,
      targetLabel: 'ci',
    });
    expect(eventLog.record).toHaveBeenCalledOnce();
    expect(eventLog.recordInTransaction).not.toHaveBeenCalled();
  });

  it('records a scope change as a post-commit evidence row', async () => {
    const { service, eventLog, writes, run } = build();

    await run(() => service.updateApiKey(KEY_ID, null));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'api-key',
      action: 'scope-changed',
      actionKey: 'api-key.scope-changed',
      tier: 'EVIDENCE',
      durability: 'POST_COMMIT',
      outcome: 'SUCCEEDED',
      targetId: KEY_ID,
      targetLabel: 'deploy-bot',
    });
    expect(eventLog.record).toHaveBeenCalledOnce();
  });

  it('records the granted keys on an explicit scope and marks an empty selection as inherited', async () => {
    const { service, writes, run } = build({
      identity: sessionIdentity(['api-key:create', 'device:read', 'device:power-control']),
    });

    await run(() => service.createApiKey({}, { name: 'ci', permissions: ['device:power-control', 'device:read'] }));
    await run(() => service.createApiKey({}, { name: 'ci' }));

    expect(writes[0].metadata).toEqual({ scope: 'explicit', grantedKeys: ['device:power-control', 'device:read'] });
    expect(writes[1].metadata).toEqual({ scope: 'inherit' });
  });

  it('carries the request provenance the tier 2 interceptor records', async () => {
    const { service, writes, run } = build();

    await run(() => service.createApiKey({}, { name: 'ci' }));

    expect(writes[0]).toMatchObject({
      requestId: 'req-1',
      method: 'POST',
      path: '/api/v1/organizations/api-keys',
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
    });
  });

  it('attributes a key-authenticated caller to the owning user and names the key it used', async () => {
    const { service, writes, run } = build({ identity: apiKeyIdentity(['api-key:create']) });

    await run(() => service.createApiKey({}, { name: 'ci' }));

    expect(writes[0]).toMatchObject({
      actorType: 'API',
      actorId: USER,
      actorLabel: 'admin@example.com',
      apiKeyId: 'ak-9',
      apiKeyLabel: 'ci-runner',
    });
    expect(writes[0].targetId).toBe(CREATED_KEY_ID);
  });

  it('attributes a session caller with no key fields', async () => {
    const { service, writes, run } = build();

    await run(() => service.deleteApiKey(KEY_ID));

    expect(writes[0]).toMatchObject({
      actorType: 'UI',
      actorId: USER,
      actorLabel: 'admin@example.com',
      apiKeyId: null,
      apiKeyLabel: null,
    });
  });
});

describe('OrganizationApiKeysService own-key management', () => {
  it('records a revocation of the caller own key, which never reaches requirePermission', async () => {
    const { service, contextService, writes, run } = build({ identity: sessionIdentity([]), ownerUserId: USER });
    const requirePermission = vi.spyOn(contextService, 'requirePermission');

    await run(() => service.deleteApiKey(KEY_ID));

    expect(requirePermission).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ actionKey: 'api-key.revoked', durability: 'ATOMIC' });
  });

  it('records a scope change on the caller own key, which never reaches requirePermission', async () => {
    const { service, contextService, writes, run } = build({ identity: sessionIdentity([]), ownerUserId: USER });
    const requirePermission = vi.spyOn(contextService, 'requirePermission');

    await run(() => service.updateApiKey(KEY_ID, null));

    expect(requirePermission).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ actionKey: 'api-key.scope-changed', durability: 'POST_COMMIT' });
  });

  it('leaves an intent for tier 2 when an own-key revocation fails', async () => {
    const { service, contextService, eventLog, run } = build({ identity: sessionIdentity([]), ownerUserId: USER });
    eventLog.recordInTransaction.mockRejectedValueOnce(new Error('event write failed'));
    let pending: PermissionIntent[] = [];

    await run(async () => {
      await service.deleteApiKey(KEY_ID).catch(() => undefined);
      pending = contextService.drainIntents();
    });

    expect(pending).toEqual([expect.objectContaining({ resource: 'api-key', action: 'delete', denied: false })]);
    expect(pending.map((intent) => isMutatingPermission(MAIN_APP_PERMISSIONS, intentKey(intent)))).toEqual([true]);
  });

  it('drains no intent once an own-key revocation is recorded', async () => {
    const { service, contextService, run } = build({ identity: sessionIdentity([]), ownerUserId: USER });
    let recorded = false;
    let pending: PermissionIntent[] = [];

    await run(async () => {
      await service.deleteApiKey(KEY_ID);
      recorded = contextService.hasRecordedIntents;
      pending = contextService.drainIntents();
    });

    expect(recorded).toBe(true);
    expect(pending).toEqual([]);
  });
});

describe('OrganizationApiKeysService post-commit insert failure', () => {
  it('keeps the created key, writes no row, and leaves the intent for tier 2', async () => {
    const { service, contextService, authClient, eventLog, writes, run } = build();
    eventLog.record.mockRejectedValueOnce(new Error('event write failed'));
    let pending: PermissionIntent[] = [];
    let created: { id: string } | undefined;

    await run(async () => {
      created = await service.createApiKey({}, { name: 'ci' });
      pending = contextService.drainIntents();
    });

    expect(created?.id).toBe(CREATED_KEY_ID);
    expect(authClient.api.deleteApiKey).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(pending).toEqual([
      expect.objectContaining({ resource: 'api-key', action: 'create', denied: false, finalized: false }),
    ]);
    expect(pending.map((intent) => isMutatingPermission(MAIN_APP_PERMISSIONS, intentKey(intent)))).toEqual([true]);
  });

  it('drains no intent once a creation is recorded', async () => {
    const { service, contextService, run } = build();
    let pending: PermissionIntent[] = [];

    await run(async () => {
      await service.createApiKey({}, { name: 'ci' });
      pending = contextService.drainIntents();
    });

    expect(pending).toEqual([]);
  });

  it('keeps the persisted scope change and leaves the intent for tier 2', async () => {
    const { service, contextService, eventLog, writes, run } = build();
    eventLog.record.mockRejectedValueOnce(new Error('event write failed'));
    let pending: PermissionIntent[] = [];
    let updated: { id: string } | undefined;

    await run(async () => {
      updated = await service.updateApiKey(KEY_ID, null);
      pending = contextService.drainIntents();
    });

    expect(updated?.id).toBe(KEY_ID);
    expect(writes).toHaveLength(0);
    expect(pending).toEqual([
      expect.objectContaining({ resource: 'api-key', action: 'update', denied: false, finalized: false }),
    ]);
    expect(pending.map((intent) => isMutatingPermission(MAIN_APP_PERMISSIONS, intentKey(intent)))).toEqual([true]);
  });

  it('logs the dropped row without failing the request', async () => {
    const { service, eventLog, logger, run } = build();
    eventLog.record.mockRejectedValueOnce(new Error('event write failed'));

    await expect(run(() => service.createApiKey({}, { name: 'ci' }))).resolves.toBeDefined();

    expect(logger.error.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')).toContain('api-key.created');
  });
});

describe('OrganizationApiKeysService compensating delete', () => {
  it('records nothing when the org-scope update is rolled back', async () => {
    const { service, apiKeyDelegate, authClient, writes, run } = build();
    apiKeyDelegate.update.mockRejectedValueOnce(new Error('org scope failed'));

    await expect(run(() => service.createApiKey({}, { name: 'ci' }))).rejects.toThrow('org scope failed');

    expect(authClient.api.deleteApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ body: { keyId: CREATED_KEY_ID } }),
    );
    expect(writes).toHaveLength(0);
  });

  it('leaves the intent for tier 2 to record the rolled-back attempt', async () => {
    const { service, contextService, apiKeyDelegate, run } = build();
    apiKeyDelegate.update.mockRejectedValueOnce(new Error('org scope failed'));
    let pending: PermissionIntent[] = [];

    await run(async () => {
      await service.createApiKey({}, { name: 'ci' }).catch(() => undefined);
      pending = contextService.drainIntents();
    });

    expect(pending).toEqual([
      expect.objectContaining({ resource: 'api-key', action: 'create', denied: false, finalized: false }),
    ]);
  });
});

describe('EventLogService.record', () => {
  it('propagates the insert failure instead of swallowing it like recordBestEffort', async () => {
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
    const repository = { insert: vi.fn().mockRejectedValue(new Error('insert failed')) };
    const contextService = new ContextService(new DesignationOperatorPolicy());
    const eventLog = new EventLogService(repository as never, logger as never, contextService);
    const write: EventLogWrite = {
      organizationId: ORG,
      tier: 'EVIDENCE',
      durability: 'POST_COMMIT',
      resource: 'api-key',
      action: 'created',
      actionKey: 'api-key.created',
      actorType: 'UI',
      outcome: 'SUCCEEDED',
    };

    await expect(eventLog.record(write)).rejects.toThrow('insert failed');
    await expect(eventLog.recordBestEffort(write)).resolves.toBeUndefined();
  });
});

describe('audited api key handlers', () => {
  it.each([
    ['createApiKey', 'api-key.created'],
    ['updateApiKey', 'api-key.scope-changed'],
    ['deleteApiKey', 'api-key.revoked'],
  ] as const)('gives %s a synthetic intent the catalog classifies as mutating', (handler, actionKey) => {
    const options = new Reflector().get<AuditActionOptions | undefined>(
      AUDIT_ACTION_KEY,
      OrganizationApiKeysController.prototype[handler],
    );

    expect(options).toMatchObject({ actionKey, resource: 'api-key' });
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, permissionKey(options?.resource ?? '', options?.action ?? ''))).toBe(
      true,
    );
  });
});
