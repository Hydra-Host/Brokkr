import { DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { Buffer } from 'node:buffer';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import type { EventLogWrite } from 'src/event-log/event-log.types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceSecretAccessService, revealStashAad, revealStashKey } from '../device-secret-access.service';
import { deriveStashKey, encryptStash } from '../reveal-stash.crypto';

const DEVICE_ID = 'dev-1';
const ORGANIZATION_ID = 'org-operator';
const USER_ID = 'user-1';
const SECRET_PASSWORD = 'n0t-in-the-event-log-4f21';

interface RequestShape {
  method: string;
  path: string;
}

const WRITE_REQUEST: RequestShape = { method: 'POST', path: `/api/v1/devices/${DEVICE_ID}/secrets` };
const revealRequest = (version: number): RequestShape => ({
  method: 'POST',
  path: `/api/v1/devices/${DEVICE_ID}/secrets/BMC/versions/${version}/reveal`,
});
const statusRequest = (requestId: string): RequestShape => ({
  method: 'GET',
  path: `/api/v1/devices/${DEVICE_ID}/secrets/reveal/${requestId}`,
});

const SEALED = {
  zoneId: 'zone-1',
  zoneKeyId: 'zk-1',
  deviceId: DEVICE_ID,
  purpose: DeviceSecretPurpose.BMC,
  kind: DeviceSecretKind.USER,
  keyGen: 5,
  ephPub: 'AAAA',
  ciphertext: 'BBBB',
  tag: 'CCCC',
};

function build() {
  const writes: EventLogWrite[] = [];
  const order: string[] = [];
  const eventLog = {
    record: vi.fn(async (write: EventLogWrite) => {
      order.push('event');
      writes.push(write);
    }),
  };

  const deviceSecretService = {
    getRevealableVersion: vi.fn().mockResolvedValue(SEALED),
    write: vi.fn().mockResolvedValue({
      version: 3,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      createdById: USER_ID,
      invalidatedAt: null,
    }),
  };

  const auditEventStore = {
    findFirst: vi.fn().mockResolvedValue({
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      version: 7,
    }),
  };
  const prisma = {
    device: { findUnique: vi.fn().mockResolvedValue({ id: DEVICE_ID }) },
    deviceSecretAuditEvent: auditEventStore,
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
  };

  const redisStore = new Map<string, string>();
  const redis = {
    getdel: vi.fn(async (key: string) => {
      const value = redisStore.get(key) ?? null;
      redisStore.delete(key);
      return value;
    }),
  };

  const bridgeQueue = {
    enqueueSagaJob: vi.fn(async () => {
      order.push('enqueue');
    }),
  };
  const hubPriv = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
  const zoneCryptoConfig = { privateKey: hubPriv };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const atomPublisher = { publishCurrent: vi.fn().mockResolvedValue({ written: true }) };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const contextService = new ContextService(new DesignationOperatorPolicy());
  const service = new DeviceSecretAccessService(
    deviceSecretService as never,
    contextService as never,
    prisma as never,
    redis as never,
    bridgeQueue as never,
    zoneCryptoConfig as never,
    audit as never,
    atomPublisher as never,
    eventLog as never,
    logger as never,
  );

  const identity = {
    authType: AuthType.Session,
    role: 'Admin',
    organizationId: ORGANIZATION_ID,
    organization: { id: ORGANIZATION_ID },
    permissions: new Set(['device-secret:access']),
    session: { user: { id: USER_ID, email: 'operator@example.com' } },
  } as unknown as IdentityContext;

  const inContext = <T>(request: RequestShape, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId: 'req-1',
          identity,
          method: request.method,
          path: request.path,
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          fn().then(resolve, reject);
        },
      );
    });

  const stash = (requestId: string, secret: Record<string, string>, aadRequestId = requestId) =>
    redisStore.set(
      revealStashKey(DEVICE_ID, requestId),
      encryptStash(
        deriveStashKey(hubPriv),
        Buffer.from(JSON.stringify(secret), 'utf8'),
        revealStashAad(DEVICE_ID, aadRequestId),
      ),
    );

  return {
    service,
    contextService,
    eventLog,
    writes,
    order,
    audit,
    auditEventStore,
    bridgeQueue,
    logger,
    inContext,
    stash,
  };
}

type Harness = ReturnType<typeof build>;

const writeCall = (harness: Harness) =>
  harness.service.write(DEVICE_ID, {
    purpose: DeviceSecretPurpose.BMC,
    kind: DeviceSecretKind.USER,
    secret: { user: 'admin', pass: SECRET_PASSWORD },
  });

const revealCall = (harness: Harness, version = 7) =>
  harness.service.requestReveal(DEVICE_ID, DeviceSecretPurpose.BMC, version);

const statusCall = (harness: Harness, requestId: string) => harness.service.getRevealStatus(DEVICE_ID, requestId);

const drainAfter = (harness: Harness, request: RequestShape, call: () => Promise<unknown>) =>
  harness.inContext(request, async () => {
    await call().catch(() => undefined);
    return harness.contextService.drainIntents();
  });

describe('DeviceSecretAccessService mirror projections', () => {
  beforeEach(() => vi.clearAllMocks());

  it('projects device-secret.written as a MIRROR evidence row', async () => {
    const harness = build();

    await harness.inContext(WRITE_REQUEST, () => writeCall(harness));

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toMatchObject({
      organizationId: ORGANIZATION_ID,
      tier: 'EVIDENCE',
      durability: 'MIRROR',
      resource: 'device-secret',
      action: 'written',
      actionKey: 'device-secret.written',
      targetId: DEVICE_ID,
      outcome: 'SUCCEEDED',
      actorId: USER_ID,
      requestId: 'req-1',
      method: 'POST',
      path: WRITE_REQUEST.path,
      metadata: { purpose: DeviceSecretPurpose.BMC, version: 3 },
    });
  });

  it('projects device-secret.reveal-requested only after the saga job is enqueued', async () => {
    const harness = build();

    const result = await harness.inContext(revealRequest(7), () => revealCall(harness));

    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toMatchObject({
      tier: 'EVIDENCE',
      durability: 'MIRROR',
      actionKey: 'device-secret.reveal-requested',
      targetId: DEVICE_ID,
      metadata: { purpose: DeviceSecretPurpose.BMC, version: 7, revealRequestId: result.requestId },
    });
    expect(harness.order).toEqual(['enqueue', 'event']);
  });

  it('carries the minted reveal id that the request URL cannot supply', async () => {
    const harness = build();

    const result = await harness.inContext(revealRequest(7), () => revealCall(harness));

    expect(harness.writes[0].path).toBe(revealRequest(7).path);
    expect(harness.writes[0].path).not.toContain(result.requestId);
    expect(harness.writes[0].metadata).toEqual({
      purpose: DeviceSecretPurpose.BMC,
      version: 7,
      revealRequestId: result.requestId,
    });
  });

  it('projects device-secret.revealed on the branch that returns plaintext', async () => {
    const harness = build();
    harness.stash('req-ready', { user: 'admin', pass: SECRET_PASSWORD });

    const status = await harness.inContext(statusRequest('req-ready'), () => statusCall(harness, 'req-ready'));

    expect(status.status).toBe('ready');
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toMatchObject({
      tier: 'EVIDENCE',
      durability: 'MIRROR',
      actionKey: 'device-secret.revealed',
      targetId: DEVICE_ID,
      metadata: { purpose: DeviceSecretPurpose.BMC, version: 7, revealRequestId: 'req-ready' },
    });
  });

  it('records the reveal id in metadata that the reveal-status path already spells out', async () => {
    const harness = build();
    harness.stash('req-ready', { user: 'admin', pass: SECRET_PASSWORD });

    await harness.inContext(statusRequest('req-ready'), () => statusCall(harness, 'req-ready'));

    expect(harness.writes[0].path).toBe(`/api/v1/devices/${DEVICE_ID}/secrets/reveal/req-ready`);
    expect(harness.writes[0].path).toContain('req-ready');
    expect(harness.writes[0].metadata).toEqual({
      purpose: DeviceSecretPurpose.BMC,
      version: 7,
      revealRequestId: 'req-ready',
    });
  });

  it('projects nothing while the reveal is still pending', async () => {
    const harness = build();

    const status = await harness.inContext(statusRequest('req-pending'), () => statusCall(harness, 'req-pending'));

    expect(status.status).toBe('pending');
    expect(harness.writes).toEqual([]);
  });

  it('projects nothing when the stash is unreadable', async () => {
    const harness = build();
    harness.stash('req-broken', { user: 'admin', pass: SECRET_PASSWORD }, 'req-other');

    const status = await harness.inContext(statusRequest('req-broken'), () => statusCall(harness, 'req-broken'));

    expect(status).toEqual({ status: 'unavailable', secret: null });
    expect(harness.writes).toEqual([]);
  });

  it('projects a null purpose and version when no reveal request row correlates', async () => {
    const harness = build();
    harness.auditEventStore.findFirst.mockResolvedValueOnce(null);
    harness.stash('req-orphan', { token: 't' });

    await harness.inContext(statusRequest('req-orphan'), () => statusCall(harness, 'req-orphan'));

    expect(harness.writes[0].metadata).toEqual({ purpose: null, version: null, revealRequestId: 'req-orphan' });
  });

  it('leaves targetLabel null because no device name is loaded on these paths', async () => {
    const harness = build();
    harness.stash('req-ready', { user: 'admin', pass: SECRET_PASSWORD });

    await harness.inContext(WRITE_REQUEST, () => writeCall(harness));
    await harness.inContext(revealRequest(7), () => revealCall(harness));
    await harness.inContext(statusRequest('req-ready'), () => statusCall(harness, 'req-ready'));

    expect(harness.writes.map((write) => write.targetLabel)).toEqual([null, null, null]);
  });

  it('keeps the secret out of every projected field', async () => {
    const harness = build();
    harness.stash('req-ready', { user: 'admin', pass: SECRET_PASSWORD });

    await harness.inContext(WRITE_REQUEST, () => writeCall(harness));
    await harness.inContext(statusRequest('req-ready'), () => statusCall(harness, 'req-ready'));

    expect(harness.writes).toHaveLength(2);
    expect(JSON.stringify(harness.writes)).not.toContain(SECRET_PASSWORD);
    expect(JSON.stringify(harness.audit.record.mock.calls)).not.toContain(SECRET_PASSWORD);
  });

  it('supersedes the device-secret access intent once each projection lands', async () => {
    const written = build();
    const requested = build();
    const revealed = build();
    revealed.stash('req-ready', { user: 'admin', pass: SECRET_PASSWORD });

    const writtenIntents = await drainAfter(written, WRITE_REQUEST, () => writeCall(written));
    const requestedIntents = await drainAfter(requested, revealRequest(7), () => revealCall(requested));
    const revealedIntents = await drainAfter(revealed, statusRequest('req-ready'), () =>
      statusCall(revealed, 'req-ready'),
    );

    expect(writtenIntents).toEqual([]);
    expect(requestedIntents).toEqual([]);
    expect(revealedIntents).toEqual([]);
  });

  it('leaves the access intent for tier 2 when the projection fails', async () => {
    const harness = build();
    harness.eventLog.record.mockRejectedValueOnce(new Error('event write failed'));
    harness.stash('req-ready', { user: 'admin', pass: SECRET_PASSWORD });

    const pending = await drainAfter(harness, statusRequest('req-ready'), () => statusCall(harness, 'req-ready'));

    expect(pending).toEqual([
      expect.objectContaining({ resource: 'device-secret', action: 'access', denied: false, finalized: false }),
    ]);
  });

  it('still delivers the plaintext when the projection fails', async () => {
    const harness = build();
    harness.eventLog.record.mockRejectedValueOnce(new Error('event write failed'));
    harness.stash('req-ready', { user: 'admin', pass: SECRET_PASSWORD });

    const status = await harness.inContext(statusRequest('req-ready'), () => statusCall(harness, 'req-ready'));

    expect(status).toEqual({ status: 'ready', secret: { user: 'admin', pass: SECRET_PASSWORD } });
    expect(harness.logger.error).toHaveBeenCalledOnce();
  });

  it('still returns the written version when the projection fails', async () => {
    const harness = build();
    harness.eventLog.record.mockRejectedValueOnce(new Error('event write failed'));

    const meta = await harness.inContext(WRITE_REQUEST, () => writeCall(harness));

    expect(meta.version).toBe(3);
  });

  it('still enqueues the reveal saga when the projection fails', async () => {
    const harness = build();
    harness.eventLog.record.mockRejectedValueOnce(new Error('event write failed'));

    const result = await harness.inContext(revealRequest(7), () => revealCall(harness));

    expect(result.status).toBe('pending');
    expect(harness.bridgeQueue.enqueueSagaJob).toHaveBeenCalledOnce();
  });

  it('records the DeviceSecretAuditEvent before its mirror projection', async () => {
    const harness = build();
    harness.stash('req-ready', { user: 'admin', pass: SECRET_PASSWORD });

    await harness.inContext(statusRequest('req-ready'), () => statusCall(harness, 'req-ready'));

    expect(harness.audit.record.mock.invocationCallOrder[0]).toBeLessThan(
      harness.eventLog.record.mock.invocationCallOrder[0],
    );
  });
});
