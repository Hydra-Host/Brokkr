import { Reflector } from '@nestjs/core';
import { createPrismaClientOptions } from '@repo/database';
import { randomBytes, randomUUID } from 'crypto';
import { from } from 'rxjs';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { EventLogInterceptor } from 'src/event-log/event-log.interceptor';
import { EventLogRepository } from 'src/event-log/event-log.repository';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SshkeysController } from '../sshkeys.controller';
import { SshKeysService } from '../sshkeys.service';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('ssh key event capture (integration, live DB)', () => {
  let prisma: PrismaClient;
  let contextService: ContextService;
  let organizationId: string;
  let userId: string;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  const canaryBody = () => `ZZcanary${randomUUID().replace(/-/g, '')}${randomBytes(16).toString('base64url')}`;

  function identity(permissions: string[]): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Owner',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(permissions),
      session: { user: { id: userId, email: 'int@example.com' } },
    } as unknown as IdentityContext;
  }

  const realEventLog = () => new EventLogService(new EventLogRepository(prisma), logger as never, contextService);

  const throwingEventLog = () =>
    ({
      recordInTransaction: vi.fn().mockRejectedValue(new Error('event write failed')),
    }) as unknown as EventLogService;

  const buildService = (eventLog: EventLogService) => new SshKeysService(prisma, contextService, eventLog);

  const runInContext = <T>(permissions: string[], fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId: `req-${randomUUID()}`,
          identity: identity(permissions),
          method: 'POST',
          path: '/api/v1/ssh-keys',
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

  async function makeKeyRow(name: string) {
    const body = canaryBody();
    const service = buildService(realEventLog());
    const fingerprint = await service.getFingerprint(`ssh-ed25519 ${body}`);
    const key = await prisma.sshKeys.create({
      data: { userId, name, key: `ssh-ed25519 ${body}`, fingerprint, dateDeleted: null },
    });
    return { id: key.id, name, body, fingerprint };
  }

  async function throughInterceptor(args: {
    eventLog: EventLogService;
    handler: (...handlerArgs: never[]) => unknown;
    permissions: string[];
    invoke: (service: SshKeysService) => Promise<unknown>;
  }): Promise<string> {
    const service = buildService(args.eventLog);
    const interceptor = new EventLogInterceptor(contextService, realEventLog(), new Reflector(), logger as never);
    const requestId = `req-${randomUUID()}`;
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          path: '/api/v1/ssh-keys',
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
          path: '/api/v1/ssh-keys',
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

  const createThroughInterceptor = (eventLog: EventLogService, permissions: string[] = ['ssh-key:create']) =>
    throughInterceptor({
      eventLog,
      handler: SshkeysController.prototype.createSshKey,
      permissions,
      invoke: (service) =>
        service.createSshKey({ name: `it-key-${randomUUID().slice(0, 8)}`, key: `ssh-ed25519 ${canaryBody()}` }),
    });

  const deleteThroughInterceptor = (eventLog: EventLogService, keyId: string, permissions = ['ssh-key:delete']) =>
    throughInterceptor({
      eventLog,
      handler: SshkeysController.prototype.deleteSshKey,
      permissions,
      invoke: (service) => service.deleteSshKey(keyId),
    });

  beforeAll(async () => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    contextService = new ContextService(new DesignationOperatorPolicy());

    const org = await prisma.organization.create({
      data: { name: `it-evlog-ssh-${randomUUID()}`, tenantType: 'DemandCustomer' },
    });
    organizationId = org.id;

    const user = await prisma.user.create({
      data: { email: `it-evlog-ssh-${randomUUID()}@example.com`, firstName: 'Int', lastName: 'Test' },
    });
    userId = user.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.sshKeys.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('persists an atomic evidence row alongside the created key', async () => {
    const body = canaryBody();
    const name = `it-created-${randomUUID().slice(0, 8)}`;
    const service = buildService(realEventLog());

    const created = await runInContext(['ssh-key:create'], () =>
      service.createSshKey({ name, key: `ssh-ed25519 ${body}` }),
    );

    const rows = await eventsFor(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource: 'ssh-key',
      action: 'created',
      actionKey: 'ssh-key.created',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      outcome: 'SUCCEEDED',
      targetId: created.id,
      targetLabel: name,
      actorId: userId,
      actorLabel: 'int@example.com',
    });
    expect(rows[0].metadata).toBeNull();
  });

  it('records no key material on the created row', async () => {
    const body = canaryBody();
    const service = buildService(realEventLog());

    const created = await runInContext(['ssh-key:create'], () =>
      service.createSshKey({ name: `it-nokey-${randomUUID().slice(0, 8)}`, key: `ssh-ed25519 ${body}` }),
    );

    const [row] = await eventsFor(created.id);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(body);
    expect(serialized).not.toContain(body.slice(0, 16));
    expect(serialized).not.toContain(created.fingerprint);
  });

  it('persists an atomic evidence row alongside the deleted key', async () => {
    const key = await makeKeyRow(`it-deleted-${randomUUID().slice(0, 8)}`);
    const service = buildService(realEventLog());

    await runInContext(['ssh-key:delete'], () => service.deleteSshKey(key.id));

    const rows = await eventsFor(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource: 'ssh-key',
      action: 'deleted',
      actionKey: 'ssh-key.deleted',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      outcome: 'SUCCEEDED',
      targetId: key.id,
      targetLabel: key.name,
    });
    expect(rows[0].metadata).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(key.body.slice(0, 16));
  });

  it('rolls the key creation back when the event write fails', async () => {
    const body = canaryBody();
    const service = buildService(throwingEventLog());
    const fingerprint = await buildService(realEventLog()).getFingerprint(`ssh-ed25519 ${body}`);

    await expect(
      runInContext(['ssh-key:create'], () =>
        service.createSshKey({ name: `it-rolled-${randomUUID().slice(0, 8)}`, key: `ssh-ed25519 ${body}` }),
      ),
    ).rejects.toThrow('event write failed');

    expect(await prisma.sshKeys.findMany({ where: { userId, fingerprint } })).toEqual([]);
  });

  it('rolls the key deletion back when the event write fails', async () => {
    const key = await makeKeyRow(`it-rolled-del-${randomUUID().slice(0, 8)}`);
    const service = buildService(throwingEventLog());

    await expect(runInContext(['ssh-key:delete'], () => service.deleteSshKey(key.id))).rejects.toThrow(
      'event write failed',
    );

    const row = await prisma.sshKeys.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.dateDeleted).toBeNull();
    expect(await eventsFor(key.id)).toEqual([]);
  });

  it('falls back to a tier 2 failure row carrying the tier 1 action key when the creation rolls back', async () => {
    const requestId = await createThroughInterceptor(throwingEventLog());

    const rows = await settledRowsFor(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource: 'ssh-key',
      action: 'create',
      actionKey: 'ssh-key.created',
      tier: 'ACTIVITY',
      durability: 'BEST_EFFORT',
      outcome: 'FAILED',
    });
  });

  it('records a denied creation under the same action key a success emits', async () => {
    const requestId = await createThroughInterceptor(realEventLog(), []);

    const rows = await settledRowsFor(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionKey: 'ssh-key.created', outcome: 'DENIED', tier: 'ACTIVITY' });
  });

  it('records a denied deletion under the same action key a success emits', async () => {
    const key = await makeKeyRow(`it-denied-del-${randomUUID().slice(0, 8)}`);

    const requestId = await deleteThroughInterceptor(realEventLog(), key.id, []);

    const rows = await settledRowsFor(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionKey: 'ssh-key.deleted', outcome: 'DENIED', tier: 'ACTIVITY' });
    expect(await prisma.sshKeys.findUniqueOrThrow({ where: { id: key.id } })).toMatchObject({ dateDeleted: null });
  });

  it('writes exactly one row for a successful creation, with no tier 2 duplicate', async () => {
    const requestId = await createThroughInterceptor(realEventLog());

    const rows = await settledRowsFor(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionKey: 'ssh-key.created', tier: 'EVIDENCE' });
    expect(rows.filter((row) => row.tier === 'ACTIVITY')).toEqual([]);
  });

  it('writes exactly one row for a successful deletion, with no tier 2 duplicate', async () => {
    const key = await makeKeyRow(`it-once-del-${randomUUID().slice(0, 8)}`);

    const requestId = await deleteThroughInterceptor(realEventLog(), key.id);

    const rows = await settledRowsFor(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionKey: 'ssh-key.deleted', tier: 'EVIDENCE', targetId: key.id });
    expect(rows.filter((row) => row.tier === 'ACTIVITY')).toEqual([]);
  });
});
