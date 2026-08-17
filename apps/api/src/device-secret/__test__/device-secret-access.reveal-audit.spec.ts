import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  DeviceSecretActorType,
  DeviceSecretAuditEventType,
  DeviceSecretKind,
  DeviceSecretPurpose,
} from '@repo/database';
import { Buffer } from 'node:buffer';
import { AuthType } from 'src/auth/identity-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceSecretAccessService, revealStashAad, revealStashKey } from '../device-secret-access.service';
import { deriveStashKey, encryptStash } from '../reveal-stash.crypto';

const SEALED = {
  zoneId: 'zone-1',
  zoneKeyId: 'zk-1',
  deviceId: 'dev-1',
  purpose: DeviceSecretPurpose.BMC,
  kind: DeviceSecretKind.USER,
  keyGen: 5,
  ephPub: 'AAAA',
  ciphertext: 'BBBB',
  tag: 'CCCC',
};

function makeHarness(opts: { privateKey?: Buffer | null } = {}) {
  const deviceSecretService = {
    getRevealableVersion: vi.fn().mockResolvedValue(SEALED),
    write: vi.fn().mockResolvedValue({
      version: 3,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      createdById: 'user-1',
      invalidatedAt: null,
    }),
  };
  const contextService = {
    userId: 'user-1',
    identity: { authType: AuthType.Session },
    buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'user-1', triggeredByEmail: 'a@b.c' }),
    requirePermission: vi.fn(),
  };
  const auditEventStore: { findFirst: ReturnType<typeof vi.fn> } = {
    findFirst: vi.fn().mockResolvedValue({
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      version: 7,
    }),
  };
  const prisma = {
    device: { findUnique: vi.fn().mockResolvedValue({ id: 'dev-1' }) },
    deviceSecretAuditEvent: auditEventStore,
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
  };
  const redisStore = new Map<string, string>();
  const redis = {
    getdel: vi.fn(async (k: string) => {
      const v = redisStore.get(k) ?? null;
      redisStore.delete(k);
      return v;
    }),
  };
  const bridgeQueue = { enqueueSagaJob: vi.fn().mockResolvedValue(undefined) };
  const hubPriv = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
  const zoneCryptoConfig = { privateKey: 'privateKey' in opts ? opts.privateKey : hubPriv };
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const audit = { record: auditRecord };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const atomPublisher = { publishCurrent: vi.fn().mockResolvedValue({ written: true }) };
  const service = new DeviceSecretAccessService(
    deviceSecretService as never,
    contextService as never,
    prisma as never,
    redis as never,
    bridgeQueue as never,
    zoneCryptoConfig as never,
    audit as never,
    atomPublisher as never,
    logger as never,
  );
  return {
    service,
    auditRecord,
    bridgeQueue,
    redisStore,
    redis,
    hubPriv,
    auditEventStore,
    contextService,
    deviceSecretService,
    atomPublisher,
    logger,
  };
}

describe('DeviceSecretAccessService reveal auditing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits REVEAL_REQUESTED with a USER actor and the minted requestId before enqueuing', async () => {
    const { service, auditRecord, bridgeQueue } = makeHarness();
    const { requestId } = await service.requestReveal('dev-1', DeviceSecretPurpose.BMC, 7);

    expect(auditRecord).toHaveBeenCalledOnce();
    const input = auditRecord.mock.calls[0][0];
    expect(input).toMatchObject({
      deviceId: 'dev-1',
      event: DeviceSecretAuditEventType.REVEAL_REQUESTED,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      version: 7,
      requestId,
      actor: { type: DeviceSecretActorType.USER, id: 'user-1' },
    });
    expect(auditRecord.mock.invocationCallOrder[0]).toBeLessThan(
      bridgeQueue.enqueueSagaJob.mock.invocationCallOrder[0],
    );
  });

  it('emits REVEAL_DELIVERED at the disclosure point, correlating purpose/version from the request row', async () => {
    const { service, auditRecord, redisStore, hubPriv } = makeHarness();
    const requestId = 'req-42';
    const stash = encryptStash(
      deriveStashKey(hubPriv),
      Buffer.from(JSON.stringify({ user: 'admin', pass: 'p' }), 'utf8'),
      revealStashAad('dev-1', requestId),
    );
    redisStore.set(revealStashKey('dev-1', requestId), stash);

    const status = await service.getRevealStatus('dev-1', requestId);

    expect(status.status).toBe('ready');
    expect(auditRecord).toHaveBeenCalledOnce();
    const input = auditRecord.mock.calls[0][0];
    expect(input).toMatchObject({
      deviceId: 'dev-1',
      event: DeviceSecretAuditEventType.REVEAL_DELIVERED,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      version: 7,
      requestId,
      actor: { type: DeviceSecretActorType.USER, id: 'user-1' },
    });
  });

  it('does NOT emit a delivery event while the reveal is still pending', async () => {
    const { service, auditRecord } = makeHarness();
    const status = await service.getRevealStatus('dev-1', 'req-none');
    expect(status.status).toBe('pending');
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('flags correlationMissing when delivering without a preceding request row', async () => {
    const { service, auditRecord, redisStore, hubPriv, auditEventStore } = makeHarness();
    auditEventStore.findFirst.mockResolvedValueOnce(null);
    const requestId = 'req-orphan';
    redisStore.set(
      revealStashKey('dev-1', requestId),
      encryptStash(
        deriveStashKey(hubPriv),
        Buffer.from(JSON.stringify({ token: 't' }), 'utf8'),
        revealStashAad('dev-1', requestId),
      ),
    );

    const status = await service.getRevealStatus('dev-1', requestId);

    expect(status.status).toBe('ready');
    expect(auditRecord.mock.calls[0][0]).toMatchObject({
      event: DeviceSecretAuditEventType.REVEAL_DELIVERED,
      payload: { correlationMissing: true },
    });
  });

  it('still delivers the secret when the delivery audit write fails', async () => {
    const { service, auditRecord, redisStore, hubPriv } = makeHarness();
    const requestId = 'req-audit-fail';
    auditRecord.mockRejectedValueOnce(new Error('db down'));
    redisStore.set(
      revealStashKey('dev-1', requestId),
      encryptStash(
        deriveStashKey(hubPriv),
        Buffer.from(JSON.stringify({ user: 'admin', pass: 'p' }), 'utf8'),
        revealStashAad('dev-1', requestId),
      ),
    );

    const status = await service.getRevealStatus('dev-1', requestId);

    expect(status).toEqual({ status: 'ready', secret: { user: 'admin', pass: 'p' } });
  });

  it('returns unavailable without consuming the stash when hub crypto is dormant', async () => {
    const { service, auditRecord, redis } = makeHarness({ privateKey: null });
    const status = await service.getRevealStatus('dev-1', 'req-dormant');
    expect(status).toEqual({ status: 'unavailable', secret: null });
    expect(redis.getdel).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('rejects a reveal request when hub crypto is dormant, before auditing or enqueuing', async () => {
    const { service, auditRecord, bridgeQueue } = makeHarness({ privateKey: null });
    await expect(service.requestReveal('dev-1', DeviceSecretPurpose.BMC, 7)).rejects.toThrow('Hub crypto is dormant');
    expect(auditRecord).not.toHaveBeenCalled();
    expect(bridgeQueue.enqueueSagaJob).not.toHaveBeenCalled();
  });

  it('rejects with NotFound when the requested secret version is missing, without auditing or enqueuing', async () => {
    const { service, auditRecord, bridgeQueue, deviceSecretService } = makeHarness();
    deviceSecretService.getRevealableVersion.mockResolvedValueOnce('missing');
    await expect(service.requestReveal('dev-1', DeviceSecretPurpose.BMC, 7)).rejects.toThrow(NotFoundException);
    expect(auditRecord).not.toHaveBeenCalled();
    expect(bridgeQueue.enqueueSagaJob).not.toHaveBeenCalled();
  });

  it('rejects with Conflict when the requested secret is invalidated, without auditing or enqueuing', async () => {
    const { service, auditRecord, bridgeQueue, deviceSecretService } = makeHarness();
    deviceSecretService.getRevealableVersion.mockResolvedValueOnce('invalidated');
    await expect(service.requestReveal('dev-1', DeviceSecretPurpose.BMC, 7)).rejects.toThrow(ConflictException);
    expect(auditRecord).not.toHaveBeenCalled();
    expect(bridgeQueue.enqueueSagaJob).not.toHaveBeenCalled();
  });
});

describe('DeviceSecretAccessService write refreshes the Redis atom', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes the current sealed-secret atom after a successful write', async () => {
    const { service, atomPublisher } = makeHarness();
    await service.write('dev-1', {
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      secret: { user: 'admin', pass: 'p' },
    });
    expect(atomPublisher.publishCurrent).toHaveBeenCalledWith('dev-1', DeviceSecretPurpose.BMC, DeviceSecretKind.USER, {
      type: DeviceSecretActorType.USER,
      id: 'user-1',
    });
  });

  it('does not publish when the write itself fails', async () => {
    const { service, atomPublisher, deviceSecretService } = makeHarness();
    deviceSecretService.write.mockRejectedValueOnce(new Error('seal failed'));
    await expect(
      service.write('dev-1', {
        purpose: DeviceSecretPurpose.BMC,
        kind: DeviceSecretKind.USER,
        secret: { user: 'admin', pass: 'p' },
      }),
    ).rejects.toThrow('seal failed');
    expect(atomPublisher.publishCurrent).not.toHaveBeenCalled();
  });

  it('warns but still returns when the atom publish reports not-written', async () => {
    const { service, atomPublisher, logger } = makeHarness();
    atomPublisher.publishCurrent.mockResolvedValueOnce({ written: false, reason: 'no-secret' });
    const meta = await service.write('dev-1', {
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      secret: { user: 'admin', pass: 'p' },
    });
    expect(meta.version).toBe(3);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('warns but still returns the written version when the atom publish throws', async () => {
    const { service, atomPublisher, logger } = makeHarness();
    atomPublisher.publishCurrent.mockRejectedValueOnce(new Error('redis down'));
    const meta = await service.write('dev-1', {
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      secret: { user: 'admin', pass: 'p' },
    });
    expect(meta.version).toBe(3);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toContain('redis down');
  });
});
