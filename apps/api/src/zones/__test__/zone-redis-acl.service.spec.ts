import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoneRedisAclService } from '../zone-redis-acl.service';
import { generateZoneAclPassword, sha256Hex, zoneAclSetUserArgs, zoneIdFromAclUsername } from '../zone-redis-acl.util';
import { ZoneRecord } from '../zone.record';

const ZONE_ID = '11111111-2222-3333-4444-555555555555';

function setUserCalls(redis: { call: ReturnType<typeof vi.fn> }): unknown[][] {
  return redis.call.mock.calls.filter((c) => c[0] === 'ACL' && c[1] === 'SETUSER');
}

function makeService(
  overrides: { flag?: string; redisCall?: ReturnType<typeof vi.fn>; requirePermission?: ReturnType<typeof vi.fn> } = {},
) {
  const redis = { call: overrides.redisCall ?? vi.fn().mockResolvedValue('OK') };
  const configService = { get: vi.fn().mockReturnValue(overrides.flag) };
  const prisma = {
    zone: { findUnique: vi.fn().mockResolvedValue({ deletedAt: null }), findMany: vi.fn() },
    zoneRedisCredential: { upsert: vi.fn(), create: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma));
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const contextService = {
    requirePermission: overrides.requirePermission ?? vi.fn(),
    buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'user-1', triggeredByEmail: 'admin@brokkr.local' }),
  };
  const service = new ZoneRedisAclService(
    prisma as never,
    configService as never,
    redis as never,
    logger as never,
    contextService as never,
  );
  return { service, redis, configService, prisma, logger, contextService };
}

describe('zone-redis-acl.util', () => {
  it('generates a 24-char password satisfying the terraform policy', () => {
    for (let i = 0; i < 50; i++) {
      const password = generateZoneAclPassword();
      expect(password).toHaveLength(24);
      expect(password.match(/[a-z]/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
      expect(password.match(/[A-Z]/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
      expect(password.match(/[0-9]/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
      expect(password.match(/[!#$&*+\-=?_~]/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(password).toMatch(/^[a-zA-Z0-9!#$&*+\-=?_~]+$/);
    }
  });

  it('builds SETUSER args mirroring the zone-service terraform rule', () => {
    const hash = sha256Hex('secret');
    expect(zoneAclSetUserArgs(ZONE_ID, hash)).toEqual([
      'SETUSER',
      `brokkr-spoke-${ZONE_ID}`,
      'reset',
      'on',
      `#${hash}`,
      `~${ZONE_ID}:*`,
      '~results:*',
      `&${ZONE_ID}:*`,
      '&results:*',
      '+@all',
      '-@admin',
      '-@dangerous',
      '+keys',
      '+info',
    ]);
  });

  it('extracts zone ids only from managed usernames', () => {
    expect(zoneIdFromAclUsername(`brokkr-spoke-${ZONE_ID}`)).toBe(ZONE_ID);
    expect(zoneIdFromAclUsername('default')).toBeNull();
    expect(zoneIdFromAclUsername('some-other-user')).toBeNull();
  });
});

describe('ZoneRedisAclService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enabled', () => {
    it('is true only when the flag is exactly "true"', () => {
      expect(makeService({ flag: 'true' }).service.enabled).toBe(true);
      expect(makeService({ flag: 'false' }).service.enabled).toBe(false);
      expect(makeService({ flag: undefined }).service.enabled).toBe(false);
      expect(makeService({ flag: '1' }).service.enabled).toBe(false);
    });
  });

  describe('provisionUser', () => {
    it('applies SETUSER with the hash of the returned plaintext', async () => {
      const { service, redis } = makeService();

      const credential = await service.provisionUser(ZONE_ID);

      expect(credential.username).toBe(`brokkr-spoke-${ZONE_ID}`);
      expect(credential.passwordHash).toBe(sha256Hex(credential.password));
      expect(redis.call).toHaveBeenCalledWith('ACL', ...zoneAclSetUserArgs(ZONE_ID, credential.passwordHash));
    });

    it('wraps redis errors with context', async () => {
      const { service } = makeService({ redisCall: vi.fn().mockRejectedValue(new Error('NOPERM')) });
      await expect(service.provisionUser(ZONE_ID)).rejects.toThrow(/Failed to apply Redis ACL user/);
    });
  });

  describe('deleteUser', () => {
    it('issues ACL DELUSER for the zone user', async () => {
      const { service, redis } = makeService();
      await service.deleteUser(ZONE_ID);
      expect(redis.call).toHaveBeenCalledWith('ACL', 'DELUSER', `brokkr-spoke-${ZONE_ID}`);
    });
  });

  describe('rotateCredential', () => {
    afterEach(() => vi.restoreAllMocks());

    it('rejects a caller without zone:update BEFORE any feature detection, lookup, or Redis work', async () => {
      const findSpy = vi.spyOn(ZoneRecord, 'findActiveById');
      const requirePermission = vi.fn(() => {
        throw new ForbiddenException();
      });
      const { service, redis, configService, prisma } = makeService({ flag: 'true', requirePermission });

      await expect(service.rotateCredential(ZONE_ID)).rejects.toBeInstanceOf(ForbiddenException);

      expect(requirePermission).toHaveBeenCalledWith('zone', 'update');
      expect(configService.get).not.toHaveBeenCalled();
      expect(findSpy).not.toHaveBeenCalled();
      expect(redis.call).not.toHaveBeenCalled();
      expect(prisma.zoneRedisCredential.upsert).not.toHaveBeenCalled();
    });

    it('503s when the flag is off', async () => {
      const { service, redis, contextService } = makeService({ flag: 'false' });
      await expect(service.rotateCredential(ZONE_ID)).rejects.toThrow(ServiceUnavailableException);
      expect(contextService.requirePermission).toHaveBeenCalledWith('zone', 'update');
      expect(redis.call).not.toHaveBeenCalled();
    });

    it('404s on a zone the org-scoped lookup cannot see, without touching redis', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue(null);
      const { service, redis } = makeService({ flag: 'true' });

      await expect(service.rotateCredential(ZONE_ID)).rejects.toThrow(NotFoundException);
      expect(redis.call).not.toHaveBeenCalled();
    });

    it('applies a new password and upserts its hash', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const { service, prisma, redis } = makeService({ flag: 'true' });

      const credential = await service.rotateCredential(ZONE_ID);

      expect(redis.call).toHaveBeenCalledWith('ACL', ...zoneAclSetUserArgs(ZONE_ID, credential.passwordHash));
      expect(prisma.zoneRedisCredential.upsert).toHaveBeenCalledWith({
        where: { zoneId: ZONE_ID },
        create: { zoneId: ZONE_ID, passwordHash: credential.passwordHash },
        update: { passwordHash: credential.passwordHash, rotatedAt: expect.any(Date) },
      });
    });

    it('serializes SETUSER and the upsert under one advisory lock: lock → liveness → SETUSER → upsert', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const { service, prisma, redis } = makeService({ flag: 'true' });

      await service.rotateCredential(ZONE_ID);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const [sqlParts, boundValue] = prisma.$executeRaw.mock.calls[0] as [ReadonlyArray<string>, string];
      expect(sqlParts.join('?')).toContain('pg_advisory_xact_lock(hashtext(');
      expect(boundValue).toBe(`zone_redis_acl:${ZONE_ID}`);
      const lockOrder = prisma.$executeRaw.mock.invocationCallOrder[0];
      const livenessOrder = prisma.zone.findUnique.mock.invocationCallOrder[0];
      const setUserOrder = redis.call.mock.invocationCallOrder[0];
      const upsertOrder = prisma.zoneRedisCredential.upsert.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(livenessOrder);
      expect(livenessOrder).toBeLessThan(setUserOrder);
      expect(setUserOrder).toBeLessThan(upsertOrder);
    });

    it('never runs SETUSER when the zone is soft-deleted inside the locked window', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const { service, prisma, redis } = makeService({ flag: 'true' });
      prisma.zone.findUnique.mockResolvedValue({ deletedAt: new Date() });

      await expect(service.rotateCredential(ZONE_ID)).rejects.toThrow(NotFoundException);

      expect(prisma.zoneRedisCredential.upsert).not.toHaveBeenCalled();
      expect(setUserCalls(redis)).toHaveLength(0);
      const lastCall = redis.call.mock.calls.at(-1);
      expect(lastCall).toEqual(['ACL', 'DELUSER', `brokkr-spoke-${ZONE_ID}`]);
    });

    it('404s and converges when the zone row vanished entirely inside the locked window', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const { service, prisma, redis } = makeService({ flag: 'true' });
      prisma.zone.findUnique.mockResolvedValue(null);

      await expect(service.rotateCredential(ZONE_ID)).rejects.toThrow(NotFoundException);

      expect(prisma.zoneRedisCredential.upsert).not.toHaveBeenCalled();
      expect(setUserCalls(redis)).toHaveLength(0);
      const lastCall = redis.call.mock.calls.at(-1);
      expect(lastCall).toEqual(['ACL', 'DELUSER', `brokkr-spoke-${ZONE_ID}`]);
    });

    it('logs an attributable audit actor on success', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const { service, logger, contextService } = makeService({ flag: 'true' });

      await service.rotateCredential(ZONE_ID);

      expect(contextService.buildAuditPayload).toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('actor=admin@brokkr.local (user-1)'));
    });

    it('restores the previous hash in Redis when the DB upsert fails', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const oldHash = sha256Hex('previous');
      const dbError = new Error('db down');
      const { service, prisma, redis } = makeService({ flag: 'true' });
      prisma.zoneRedisCredential.findUnique.mockResolvedValue({ zoneId: ZONE_ID, passwordHash: oldHash });
      prisma.zoneRedisCredential.upsert.mockRejectedValue(dbError);

      await expect(service.rotateCredential(ZONE_ID)).rejects.toBe(dbError);

      const lastCall = redis.call.mock.calls.at(-1);
      expect(lastCall).toEqual(['ACL', ...zoneAclSetUserArgs(ZONE_ID, oldHash)]);
    });

    it('rollback converges to the CURRENT DB hash, not the pre-rotate snapshot (concurrent rotate)', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const snapshotHash = sha256Hex('snapshot');
      const concurrentHash = sha256Hex('concurrent-rotate-won');
      const dbError = new Error('db down');
      const { service, prisma, redis } = makeService({ flag: 'true' });
      prisma.zoneRedisCredential.findUnique
        .mockResolvedValueOnce({ zoneId: ZONE_ID, passwordHash: snapshotHash })
        .mockResolvedValueOnce({ zoneId: ZONE_ID, passwordHash: concurrentHash });
      prisma.zoneRedisCredential.upsert.mockRejectedValue(dbError);

      await expect(service.rotateCredential(ZONE_ID)).rejects.toBe(dbError);

      const lastCall = redis.call.mock.calls.at(-1);
      expect(lastCall).toEqual(['ACL', ...zoneAclSetUserArgs(ZONE_ID, concurrentHash)]);
    });

    it('rollback falls back to the snapshot when the DB re-read also fails', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const snapshotHash = sha256Hex('snapshot');
      const dbError = new Error('db down');
      const { service, prisma, redis } = makeService({ flag: 'true' });
      prisma.zoneRedisCredential.findUnique
        .mockResolvedValueOnce({ zoneId: ZONE_ID, passwordHash: snapshotHash })
        .mockRejectedValueOnce(new Error('still down'));
      prisma.zoneRedisCredential.upsert.mockRejectedValue(dbError);

      await expect(service.rotateCredential(ZONE_ID)).rejects.toBe(dbError);

      const lastCall = redis.call.mock.calls.at(-1);
      expect(lastCall).toEqual(['ACL', ...zoneAclSetUserArgs(ZONE_ID, snapshotHash)]);
    });

    it('removes the Redis user when the DB upsert fails and there was no prior credential', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const dbError = new Error('db down');
      const { service, prisma, redis } = makeService({ flag: 'true' });
      prisma.zoneRedisCredential.findUnique.mockResolvedValue(null);
      prisma.zoneRedisCredential.upsert.mockRejectedValue(dbError);

      await expect(service.rotateCredential(ZONE_ID)).rejects.toBe(dbError);
      expect(redis.call).toHaveBeenCalledWith('ACL', 'DELUSER', `brokkr-spoke-${ZONE_ID}`);
    });

    it('surfaces the DB error even when the Redis rollback itself fails', async () => {
      vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: ZONE_ID } } as never);
      const dbError = new Error('db down');
      const redisCall = vi
        .fn()
        .mockResolvedValueOnce('OK')
        .mockRejectedValue(new Error('redis down'));
      const { service, prisma, logger } = makeService({ flag: 'true', redisCall });
      prisma.zoneRedisCredential.findUnique.mockResolvedValue({ zoneId: ZONE_ID, passwordHash: sha256Hex('p') });
      prisma.zoneRedisCredential.upsert.mockRejectedValue(dbError);

      await expect(service.rotateCredential(ZONE_ID)).rejects.toBe(dbError);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to restore Redis ACL state'));
    });
  });

  describe('onApplicationBootstrap', () => {
    it('does nothing when the flag is off', async () => {
      const { service, prisma, redis } = makeService({ flag: undefined });
      await service.onApplicationBootstrap();
      expect(prisma.zone.findMany).not.toHaveBeenCalled();
      expect(redis.call).not.toHaveBeenCalled();
    });

    it('reconciles when the flag is on and survives a total reconcile failure', async () => {
      const { service, prisma, logger } = makeService({ flag: 'true' });
      prisma.zone.findMany.mockRejectedValue(new Error('db down'));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('startup reconcile failed'));
    });
  });

  describe('reconcileAll', () => {
    it('re-applies stored hashes, provisions locked users for credential-less zones, and drops orphans', async () => {
      const storedHash = sha256Hex('known');
      const orphanZoneId = '99999999-9999-9999-9999-999999999999';
      const bareZoneId = '22222222-2222-2222-2222-222222222222';

      const redisCall = vi.fn().mockImplementation((_acl: string, subcommand: string) => {
        if (subcommand === 'USERS') {
          return Promise.resolve(['default', `brokkr-spoke-${ZONE_ID}`, `brokkr-spoke-${orphanZoneId}`]);
        }
        return Promise.resolve('OK');
      });
      const { service, prisma, redis } = makeService({ redisCall });
      prisma.zone.findMany.mockResolvedValue([
        { id: ZONE_ID, redisCredential: { passwordHash: storedHash } },
        { id: bareZoneId, redisCredential: null },
      ]);

      await service.reconcileAll();

      expect(redis.call).toHaveBeenCalledWith('ACL', ...zoneAclSetUserArgs(ZONE_ID, storedHash));
      expect(prisma.zoneRedisCredential.create).toHaveBeenCalledWith({
        data: { zoneId: bareZoneId, passwordHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      });
      const createdHash = (prisma.zoneRedisCredential.create.mock.calls[0][0] as { data: { passwordHash: string } })
        .data.passwordHash;
      expect(redis.call).toHaveBeenCalledWith('ACL', ...zoneAclSetUserArgs(bareZoneId, createdHash));
      const createOrder = prisma.zoneRedisCredential.create.mock.invocationCallOrder[0];
      const setUserOrder = redisCall.mock.calls.findIndex(
        ([, sub, username]) => sub === 'SETUSER' && username === `brokkr-spoke-${bareZoneId}`,
      );
      expect(redisCall.mock.invocationCallOrder[setUserOrder]).toBeGreaterThan(createOrder);
      expect(redis.call).toHaveBeenCalledWith('ACL', 'DELUSER', `brokkr-spoke-${orphanZoneId}`);
      const delusers = redisCall.mock.calls.filter(([, sub]) => sub === 'DELUSER');
      expect(delusers).toHaveLength(1);
    });

    it('does not touch Redis for a credential-less zone whose row create fails', async () => {
      const bareZoneId = '22222222-2222-2222-2222-222222222222';
      const redisCall = vi.fn().mockImplementation((_acl: string, subcommand: string) => {
        if (subcommand === 'USERS') return Promise.resolve([]);
        return Promise.resolve('OK');
      });
      const { service, prisma, logger, redis } = makeService({ redisCall });
      prisma.zone.findMany.mockResolvedValue([{ id: bareZoneId, redisCredential: null }]);
      prisma.zoneRedisCredential.create.mockRejectedValue(new Error('db down'));

      await service.reconcileAll();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(bareZoneId));
      const setusers = redis.call.mock.calls.filter(([, sub]: string[]) => sub === 'SETUSER');
      expect(setusers).toHaveLength(0);
    });

    it('continues past per-zone failures', async () => {
      const failingZone = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const redisCall = vi.fn().mockImplementation((_acl: string, subcommand: string, username?: string) => {
        if (subcommand === 'USERS') return Promise.resolve([]);
        if (subcommand === 'SETUSER' && username === `brokkr-spoke-${failingZone}`) {
          return Promise.reject(new Error('NOPERM'));
        }
        return Promise.resolve('OK');
      });
      const { service, prisma, logger, redis } = makeService({ redisCall });
      prisma.zone.findMany.mockResolvedValue([
        { id: failingZone, redisCredential: { passwordHash: sha256Hex('x') } },
        { id: ZONE_ID, redisCredential: { passwordHash: sha256Hex('y') } },
      ]);

      await service.reconcileAll();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(failingZone));
      expect(redis.call).toHaveBeenCalledWith('ACL', ...zoneAclSetUserArgs(ZONE_ID, sha256Hex('y')));
    });
  });
});
