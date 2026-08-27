import { Reflector } from '@nestjs/core';
import { DeviceSecretAuditEventType, DeviceSecretKind, DeviceSecretPurpose, createPrismaClientOptions } from '@repo/database';
import { randomUUID } from 'crypto';
import { Buffer } from 'node:buffer';
import { from } from 'rxjs';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { EventLogInterceptor } from 'src/event-log/event-log.interceptor';
import { EventLogRepository } from 'src/event-log/event-log.repository';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeviceSecretAccessService, revealStashAad, revealStashKey } from '../device-secret-access.service';
import { DeviceSecretAuditService } from '../device-secret-audit.service';
import { deriveStashKey, encryptStash } from '../reveal-stash.crypto';

const connectionString = process.env.DATABASE_URL;
const SECRET_PASSWORD = 'int-n0t-in-the-event-log-8b2d';
const HUB_PRIVATE_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

describe.skipIf(!connectionString)('device secret event capture (integration, live DB)', () => {
  let prisma: PrismaClient;
  let contextService: ContextService;
  let organizationId: string;
  let deviceId: string;
  let userId: string;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  const realEventLog = () => new EventLogService(new EventLogRepository(prisma), logger as never, contextService);

  const throwingEventLog = () =>
    ({ record: vi.fn().mockRejectedValue(new Error('event write failed')) }) as unknown as EventLogService;

  const sealed = () => ({
    zoneId: randomUUID(),
    zoneKeyId: randomUUID(),
    deviceId,
    purpose: DeviceSecretPurpose.BMC,
    kind: DeviceSecretKind.USER,
    keyGen: 5,
    ephPub: 'AAAA',
    ciphertext: 'BBBB',
    tag: 'CCCC',
  });

  function buildService(eventLog: EventLogService, redisStore: Map<string, string>) {
    const deviceSecretService = {
      getRevealableVersion: vi.fn().mockResolvedValue(sealed()),
      write: vi.fn().mockResolvedValue({
        version: 3,
        purpose: DeviceSecretPurpose.BMC,
        kind: DeviceSecretKind.USER,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        createdById: userId,
        invalidatedAt: null,
      }),
    };
    const redis = {
      getdel: vi.fn(async (key: string) => {
        const value = redisStore.get(key) ?? null;
        redisStore.delete(key);
        return value;
      }),
    };
    return new DeviceSecretAccessService(
      deviceSecretService as never,
      contextService,
      prisma,
      redis as never,
      { enqueueSagaJob: vi.fn().mockResolvedValue(undefined) } as never,
      { privateKey: HUB_PRIVATE_KEY } as never,
      new DeviceSecretAuditService(prisma, logger as never),
      { publishCurrent: vi.fn().mockResolvedValue({ written: true }) } as never,
      eventLog,
      logger as never,
    );
  }

  function identity(): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Admin',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(['device-secret:access']),
      session: { user: { id: userId, email: 'int-operator@example.com' } },
    } as unknown as IdentityContext;
  }

  async function throughInterceptor(args: {
    serviceEventLog: EventLogService;
    redisStore?: Map<string, string>;
    request: { method: string; path: string };
    invoke: (service: DeviceSecretAccessService) => Promise<unknown>;
  }): Promise<string> {
    const service = buildService(args.serviceEventLog, args.redisStore ?? new Map<string, string>());
    const interceptor = new EventLogInterceptor(contextService, realEventLog(), new Reflector(), logger as never);
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: args.request.method,
          path: args.request.path,
          params: { deviceId },
          ip: '203.0.113.9',
          headers: { 'user-agent': 'vitest' },
        }),
      }),
      getHandler: () => function handler() {},
    };

    const requestId = `req-${randomUUID()}`;
    await new Promise<void>((resolve) => {
      contextService.run(
        {
          requestId,
          identity: identity(),
          method: args.request.method,
          path: args.request.path,
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

  function stash(store: Map<string, string>, requestId: string): void {
    store.set(
      revealStashKey(deviceId, requestId),
      encryptStash(
        deriveStashKey(HUB_PRIVATE_KEY),
        Buffer.from(JSON.stringify({ user: 'admin', pass: SECRET_PASSWORD }), 'utf8'),
        revealStashAad(deviceId, requestId),
      ),
    );
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function settledRows(requestId: string) {
    const query = () =>
      prisma.eventLog.findMany({ where: { organizationId, requestId }, orderBy: { createdAt: 'asc' } });
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await query()).length > 0) break;
      await sleep(20);
    }
    await sleep(150);
    return query();
  }

  const auditRows = () => prisma.deviceSecretAuditEvent.findMany({ where: { deviceId } });

  const writeRequest = () => ({ method: 'POST', path: `/api/v1/devices/${deviceId}/secrets` });
  const revealRequest = (version: number) => ({
    method: 'POST',
    path: `/api/v1/devices/${deviceId}/secrets/BMC/versions/${version}/reveal`,
  });
  const statusRequest = (revealRequestId: string) => ({
    method: 'GET',
    path: `/api/v1/devices/${deviceId}/secrets/reveal/${revealRequestId}`,
  });

  beforeAll(async () => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    contextService = new ContextService(new DesignationOperatorPolicy());
    organizationId = randomUUID();
    const [device, user] = await Promise.all([
      prisma.device.create({ data: { name: `it-secret-evlog-${randomUUID().slice(0, 8)}` } }),
      prisma.user.create({ data: { email: `int-secret-op-${randomUUID().slice(0, 8)}@example.com` } }),
    ]);
    deviceId = device.id;
    userId = user.id;
  }, 60_000);

  afterEach(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.deviceSecretAuditEvent.deleteMany({ where: { deviceId } });
  });

  afterAll(async () => {
    await prisma.device.deleteMany({ where: { id: deviceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('persists exactly one MIRROR row when a secret is written', async () => {
    const requestId = await throughInterceptor({
      serviceEventLog: realEventLog(),
      request: writeRequest(),
      invoke: (service) =>
        service.write(deviceId, {
          purpose: DeviceSecretPurpose.BMC,
          kind: DeviceSecretKind.USER,
          secret: { user: 'admin', pass: SECRET_PASSWORD },
        }),
    });

    const persisted = await settledRows(requestId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      tier: 'EVIDENCE',
      durability: 'MIRROR',
      resource: 'device-secret',
      action: 'written',
      actionKey: 'device-secret.written',
      outcome: 'SUCCEEDED',
      targetId: deviceId,
      targetLabel: null,
      actorId: userId,
      path: writeRequest().path,
      metadata: { purpose: 'BMC', version: 3 },
    });
  });

  it('persists exactly one MIRROR row when a reveal is requested', async () => {
    const requestId = await throughInterceptor({
      serviceEventLog: realEventLog(),
      request: revealRequest(7),
      invoke: (service) => service.requestReveal(deviceId, DeviceSecretPurpose.BMC, 7),
    });

    const persisted = await settledRows(requestId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      tier: 'EVIDENCE',
      durability: 'MIRROR',
      actionKey: 'device-secret.reveal-requested',
      outcome: 'SUCCEEDED',
      path: revealRequest(7).path,
    });
    const requested = await auditRows();
    expect(requested.map((row) => row.event)).toEqual([DeviceSecretAuditEventType.REVEAL_REQUESTED]);
    expect(persisted[0].metadata).toEqual({ purpose: 'BMC', version: 7, revealRequestId: requested[0].requestId });
    expect(persisted[0].path).not.toContain(requested[0].requestId);
  });

  it('persists exactly one MIRROR row beside the audit event when plaintext is delivered', async () => {
    const redisStore = new Map<string, string>();
    const revealRequestId = randomUUID();
    stash(redisStore, revealRequestId);

    const requestId = await throughInterceptor({
      serviceEventLog: realEventLog(),
      redisStore,
      request: statusRequest(revealRequestId),
      invoke: (service) => service.getRevealStatus(deviceId, revealRequestId),
    });

    const persisted = await settledRows(requestId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      tier: 'EVIDENCE',
      durability: 'MIRROR',
      actionKey: 'device-secret.revealed',
      outcome: 'SUCCEEDED',
      targetId: deviceId,
      path: statusRequest(revealRequestId).path,
      metadata: { purpose: null, version: null, revealRequestId },
    });
    expect((await auditRows()).map((row) => row.event)).toEqual([DeviceSecretAuditEventType.REVEAL_DELIVERED]);
  });

  it('persists the reveal id that the reveal-status path already spells out, and joins it to the audit row', async () => {
    const redisStore = new Map<string, string>();
    const revealRequestId = randomUUID();
    stash(redisStore, revealRequestId);
    await prisma.deviceSecretAuditEvent.create({
      data: {
        deviceId,
        event: DeviceSecretAuditEventType.REVEAL_REQUESTED,
        purpose: DeviceSecretPurpose.BMC,
        kind: DeviceSecretKind.USER,
        version: 9,
        actorType: 'USER',
        actor: userId,
        requestId: revealRequestId,
      },
    });

    const requestId = await throughInterceptor({
      serviceEventLog: realEventLog(),
      redisStore,
      request: statusRequest(revealRequestId),
      invoke: (service) => service.getRevealStatus(deviceId, revealRequestId),
    });

    const persisted = await settledRows(requestId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].path).toBe(`/api/v1/devices/${deviceId}/secrets/reveal/${revealRequestId}`);
    expect(persisted[0].metadata).toEqual({ purpose: 'BMC', version: 9, revealRequestId });
    const delivered = await prisma.deviceSecretAuditEvent.findMany({
      where: { deviceId, requestId: revealRequestId, event: DeviceSecretAuditEventType.REVEAL_DELIVERED },
    });
    expect(delivered).toHaveLength(1);
  });

  it('keeps the revealed secret out of both the event row and the audit row', async () => {
    const redisStore = new Map<string, string>();
    const revealRequestId = randomUUID();
    stash(redisStore, revealRequestId);

    const requestId = await throughInterceptor({
      serviceEventLog: realEventLog(),
      redisStore,
      request: statusRequest(revealRequestId),
      invoke: (service) => service.getRevealStatus(deviceId, revealRequestId),
    });

    expect(JSON.stringify(await settledRows(requestId))).not.toContain(SECRET_PASSWORD);
    expect(JSON.stringify(await auditRows())).not.toContain(SECRET_PASSWORD);
  });

  it('delivers the plaintext and falls back to a tier 2 row when the projection fails', async () => {
    const redisStore = new Map<string, string>();
    const revealRequestId = randomUUID();
    stash(redisStore, revealRequestId);
    let status: unknown;

    const requestId = await throughInterceptor({
      serviceEventLog: throwingEventLog(),
      redisStore,
      request: statusRequest(revealRequestId),
      invoke: async (service) => {
        status = await service.getRevealStatus(deviceId, revealRequestId);
        return status;
      },
    });

    expect(status).toEqual({ status: 'ready', secret: { user: 'admin', pass: SECRET_PASSWORD } });
    const persisted = await settledRows(requestId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      tier: 'ACTIVITY',
      durability: 'BEST_EFFORT',
      resource: 'device-secret',
      action: 'access',
      actionKey: 'device-secret.access',
      outcome: 'SUCCEEDED',
    });
    expect((await auditRows()).map((row) => row.event)).toEqual([DeviceSecretAuditEventType.REVEAL_DELIVERED]);
  });

  it('projects no mirror row while the reveal is still pending, leaving the poll to tier 2', async () => {
    const pendingRevealId = randomUUID();
    const requestId = await throughInterceptor({
      serviceEventLog: realEventLog(),
      request: statusRequest(pendingRevealId),
      invoke: (service) => service.getRevealStatus(deviceId, pendingRevealId),
    });

    const persisted = await settledRows(requestId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ tier: 'ACTIVITY', actionKey: 'device-secret.access' });
  });
});
