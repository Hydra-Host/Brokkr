import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { Prisma } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as zoneUuid from '../zone-uuid';
import { ZoneRecord } from '../zone.record';
import { ZonesService } from '../zones.service';

const dto = { name: 'phx-az1' } as never;

function suffixConflict() {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 't',
    meta: { target: ['uuidSuffix'] },
  });
}

function makeService(
  overrides: {
    aclEnabled?: boolean;
    requirePermission?: ReturnType<typeof vi.fn>;
    queryRawResult?: unknown[];
  } = {},
) {
  const context = {
    buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'u', triggeredByEmail: 'a@b' }),
    requirePermission: overrides.requirePermission ?? vi.fn(),
    organizationId: 'org-1',
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const regionAssignment = { assignZoneSafe: vi.fn() };
  const prisma = {
    prefix: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    zoneRedisCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue(overrides.queryRawResult ?? []),
  };
  const zoneRedisAcl = {
    enabled: overrides.aclEnabled ?? false,
    provisionUser: vi.fn().mockImplementation((zoneId: string) =>
      Promise.resolve({
        username: `brokkr-spoke-${zoneId}`,
        password: 'plaintext-pass',
        passwordHash: 'hash-of-plaintext',
      }),
    ),
    deleteUser: vi.fn().mockResolvedValue(undefined),
    ensureUser: vi.fn().mockResolvedValue(undefined),
    convergeUserToDb: vi.fn().mockResolvedValue(undefined),
  };
  const prefixService = { clearVrrpVipsForZone: vi.fn().mockResolvedValue(undefined) };
  const dnsPublisher = { clearZoneDnsConfig: vi.fn().mockResolvedValue(undefined) };
  const service = new ZonesService(
    prisma as never,
    context as never,
    regionAssignment as never,
    {} as never,
    logger as never,
    zoneRedisAcl as never,
    prefixService as never,
    dnsPublisher as never,
    { republishForZone: vi.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, regionAssignment, zoneRedisAcl, prefixService, dnsPublisher, prisma, context, logger };
}

describe('ZonesService.createZone uuidSuffix dedup', () => {
  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ zone: {} }, () => ({
      organizationId: 'org-1',
      permissions: new Set(['zone:create', 'zone:update', 'zone:delete']),
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('regenerates the id on a uuidSuffix collision, then succeeds with the fresh id', async () => {
    vi.spyOn(zoneUuid, 'generateZoneId')
      .mockReturnValueOnce({ id: 'collide-aaaa1', uuidSuffix: 'aaaa1' })
      .mockReturnValueOnce({ id: 'fresh-bbbb2', uuidSuffix: 'bbbb2' });
    const tx = vi
      .spyOn(ActiveRecordRegistry, 'transaction')
      .mockRejectedValueOnce(suffixConflict())
      .mockResolvedValueOnce(undefined);
    const { service, regionAssignment } = makeService();

    const result = await service.createZone(dto);

    expect(tx).toHaveBeenCalledTimes(2);
    expect(result.id).toBe('fresh-bbbb2');
    expect(regionAssignment.assignZoneSafe).toHaveBeenCalledTimes(1);
    expect(regionAssignment.assignZoneSafe).toHaveBeenCalledWith('fresh-bbbb2');
  });

  it('throws ConflictException after exhausting all attempts', async () => {
    const tx = vi.spyOn(ActiveRecordRegistry, 'transaction').mockRejectedValue(suffixConflict());
    const { service } = makeService();

    await expect(service.createZone(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(tx).toHaveBeenCalledTimes(zoneUuid.MAX_UUID_SUFFIX_ATTEMPTS);
  });

  it('rethrows a non-suffix error immediately without retrying', async () => {
    const other = new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 't' });
    const tx = vi.spyOn(ActiveRecordRegistry, 'transaction').mockRejectedValue(other);
    const { service } = makeService();

    await expect(service.createZone(dto)).rejects.toBe(other);
    expect(tx).toHaveBeenCalledTimes(1);
  });
});

describe('ZonesService createZone Redis ACL integration', () => {
  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ zone: {} }, () => ({
      organizationId: 'org-1',
      permissions: new Set(['zone:create', 'zone:update', 'zone:delete']),
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not touch the ACL service and omits the credential when the flag is off', async () => {
    vi.spyOn(ActiveRecordRegistry, 'transaction').mockResolvedValue(undefined);
    const { service, zoneRedisAcl } = makeService({ aclEnabled: false });

    const result = await service.createZone(dto);

    expect(zoneRedisAcl.provisionUser).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('redisCredential');
  });

  it('provisions the ACL user before persisting and returns the show-once credential', async () => {
    vi.spyOn(zoneUuid, 'generateZoneId').mockReturnValue({ id: 'zone-cccc3', uuidSuffix: 'cccc3' });
    const order: string[] = [];
    vi.spyOn(ActiveRecordRegistry, 'transaction').mockImplementation(async () => {
      order.push('persist');
    });
    const { service, zoneRedisAcl } = makeService({ aclEnabled: true });
    zoneRedisAcl.provisionUser.mockImplementation(async (zoneId: string) => {
      order.push('provision');
      return { username: `brokkr-spoke-${zoneId}`, password: 'plaintext-pass', passwordHash: 'h' };
    });

    const result = await service.createZone(dto);

    expect(order).toEqual(['provision', 'persist']);
    expect(result.redisCredential).toEqual({ username: 'brokkr-spoke-zone-cccc3', password: 'plaintext-pass' });
    expect(zoneRedisAcl.deleteUser).not.toHaveBeenCalled();
  });

  it('compensates (deletes the ACL user) when the persist fails, then rethrows', async () => {
    vi.spyOn(zoneUuid, 'generateZoneId').mockReturnValue({ id: 'zone-dddd4', uuidSuffix: 'dddd4' });
    const persistError = new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 't' });
    vi.spyOn(ActiveRecordRegistry, 'transaction').mockRejectedValue(persistError);
    const { service, zoneRedisAcl } = makeService({ aclEnabled: true });

    await expect(service.createZone(dto)).rejects.toBe(persistError);
    expect(zoneRedisAcl.deleteUser).toHaveBeenCalledWith('zone-dddd4');
  });

  it('compensates and re-provisions with the fresh id on a uuidSuffix collision', async () => {
    vi.spyOn(zoneUuid, 'generateZoneId')
      .mockReturnValueOnce({ id: 'collide-aaaa1', uuidSuffix: 'aaaa1' })
      .mockReturnValueOnce({ id: 'fresh-bbbb2', uuidSuffix: 'bbbb2' });
    vi.spyOn(ActiveRecordRegistry, 'transaction')
      .mockRejectedValueOnce(suffixConflict())
      .mockResolvedValueOnce(undefined);
    const { service, zoneRedisAcl } = makeService({ aclEnabled: true });

    const result = await service.createZone(dto);

    expect(zoneRedisAcl.provisionUser).toHaveBeenNthCalledWith(1, 'collide-aaaa1');
    expect(zoneRedisAcl.deleteUser).toHaveBeenCalledWith('collide-aaaa1');
    expect(zoneRedisAcl.provisionUser).toHaveBeenNthCalledWith(2, 'fresh-bbbb2');
    expect(result.redisCredential?.username).toBe('brokkr-spoke-fresh-bbbb2');
  });

  it('surfaces the original persist error even when the compensation itself fails', async () => {
    vi.spyOn(zoneUuid, 'generateZoneId').mockReturnValue({ id: 'zone-eeee5', uuidSuffix: 'eeee5' });
    const persistError = new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 't' });
    vi.spyOn(ActiveRecordRegistry, 'transaction').mockRejectedValue(persistError);
    const { service, zoneRedisAcl } = makeService({ aclEnabled: true });
    zoneRedisAcl.deleteUser.mockRejectedValue(new Error('redis down'));

    await expect(service.createZone(dto)).rejects.toBe(persistError);
  });
});

describe('ZonesService.deleteZone Redis ACL integration', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockActiveZone(zoneId: string) {
    const zone = { data: { id: zoneId, name: 'phx-az1' }, delete: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue(zone as never);
    return zone;
  }

  function mockTransaction(credential: { zoneId: string; passwordHash: string } | null = null) {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      prefix: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      zoneRedisCredential: {
        findUnique: vi.fn().mockResolvedValue(credential),
        deleteMany: vi.fn().mockResolvedValue({ count: credential ? 1 : 0 }),
      },
      dnsRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dnsDomain: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const spy = vi.spyOn(ActiveRecordRegistry, 'transaction').mockImplementation(async (cb) => {
      await cb(tx as never);
    });
    return { tx, spy };
  }

  function expectAdvisoryLock(tx: { $executeRaw: ReturnType<typeof vi.fn> }, zoneId: string) {
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [sqlParts, boundValue] = tx.$executeRaw.mock.calls[0] as [ReadonlyArray<string>, string];
    expect(sqlParts.join('?')).toContain('pg_advisory_xact_lock(hashtext(');
    expect(boundValue).toBe(`zone_redis_acl:${zoneId}`);
  }

  it('revokes the ACL user, then removes the credential row and soft-deletes, all under the per-zone advisory lock', async () => {
    const zone = mockActiveZone('zone-1');
    const { tx } = mockTransaction({ zoneId: 'zone-1', passwordHash: 'stored-hash' });
    const { service, zoneRedisAcl } = makeService({ aclEnabled: true });

    await service.deleteZone('zone-1');

    expectAdvisoryLock(tx, 'zone-1');
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.zoneRedisCredential.findUnique.mock.invocationCallOrder[0],
    );
    expect(zoneRedisAcl.deleteUser).toHaveBeenCalledWith('zone-1');
    expect(tx.zoneRedisCredential.deleteMany).toHaveBeenCalledWith({ where: { zoneId: 'zone-1' } });
    expect(zone.delete).toHaveBeenCalledWith({ tx });
  });

  it('revokes the ACL user even when the flag is OFF, as long as a credential row exists', async () => {
    const zone = mockActiveZone('zone-1');
    const { tx } = mockTransaction({ zoneId: 'zone-1', passwordHash: 'stored-hash' });
    const { service, zoneRedisAcl } = makeService({ aclEnabled: false });

    await service.deleteZone('zone-1');

    expect(zoneRedisAcl.deleteUser).toHaveBeenCalledWith('zone-1');
    expect(tx.zoneRedisCredential.deleteMany).toHaveBeenCalledWith({ where: { zoneId: 'zone-1' } });
    expect(zone.delete).toHaveBeenCalledWith({ tx });
  });

  it('aborts the delete when ACL revocation fails, without converging', async () => {
    const zone = mockActiveZone('zone-1');
    const { tx } = mockTransaction({ zoneId: 'zone-1', passwordHash: 'stored-hash' });
    const { service, zoneRedisAcl } = makeService({ aclEnabled: true });
    zoneRedisAcl.deleteUser.mockRejectedValue(new Error('redis down'));

    await expect(service.deleteZone('zone-1')).rejects.toThrow('redis down');
    expect(tx.zoneRedisCredential.deleteMany).not.toHaveBeenCalled();
    expect(zone.delete).not.toHaveBeenCalled();
    expect(zoneRedisAcl.convergeUserToDb).not.toHaveBeenCalled();
  });

  it('rejects a caller without zone:delete BEFORE the Redis revocation fires', async () => {
    const zone = mockActiveZone('zone-1');
    const requirePermission = vi.fn(() => {
      throw new ForbiddenException();
    });
    const txSpy = vi.spyOn(ActiveRecordRegistry, 'transaction');
    const { service, zoneRedisAcl } = makeService({ aclEnabled: true, requirePermission });

    await expect(service.deleteZone('zone-1')).rejects.toBeInstanceOf(ForbiddenException);

    expect(requirePermission).toHaveBeenCalledWith('zone', 'delete');
    expect(txSpy).not.toHaveBeenCalled();
    expect(zoneRedisAcl.deleteUser).not.toHaveBeenCalled();
    expect(zone.delete).not.toHaveBeenCalled();
  });

  it('converges the ACL user back to the DB when the transaction fails after DELUSER', async () => {
    const zone = mockActiveZone('zone-1');
    const dbError = new Error('db down');
    mockTransaction({ zoneId: 'zone-1', passwordHash: 'stored-hash' });
    const { service, zoneRedisAcl } = makeService({ aclEnabled: true });
    zone.delete.mockRejectedValue(dbError);

    await expect(service.deleteZone('zone-1')).rejects.toBe(dbError);

    expect(zoneRedisAcl.deleteUser).toHaveBeenCalledWith('zone-1');
    expect(zoneRedisAcl.convergeUserToDb).toHaveBeenCalledWith('zone-1', 'stored-hash', 'delete');
  });

  it('soft-deletes with no Redis calls when the locked lookup finds no credential row', async () => {
    const zone = mockActiveZone('zone-1');
    const { tx } = mockTransaction(null);
    const { service, zoneRedisAcl } = makeService({ aclEnabled: true });

    await service.deleteZone('zone-1');

    expectAdvisoryLock(tx, 'zone-1');
    expect(zoneRedisAcl.deleteUser).not.toHaveBeenCalled();
    expect(tx.zoneRedisCredential.deleteMany).not.toHaveBeenCalled();
    expect(zone.delete).toHaveBeenCalledWith({ tx });
  });
});

describe('ZonesService.deleteZone VRRP teardown', () => {
  afterEach(() => vi.restoreAllMocks());

  it('withdraws the zone VIPs AFTER the tombstone transaction commits', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({
      data: { id: 'z1', name: 'phx-az1' },
      delete: del,
    } as never);
    const fakeTx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      prefix: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      zoneRedisCredential: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() },
      dnsRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dnsDomain: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const txSpy = vi.spyOn(ActiveRecordRegistry, 'transaction').mockImplementation(async (cb) => cb(fakeTx as never));
    const { service, prefixService } = makeService();

    await service.deleteZone('z1');

    expect(prefixService.clearVrrpVipsForZone).toHaveBeenCalledWith('z1');
    expect(del).toHaveBeenCalled();
    expect(txSpy.mock.invocationCallOrder[0]).toBeLessThan(
      prefixService.clearVrrpVipsForZone.mock.invocationCallOrder[0],
    );
  });

  it('still tombstones the zone if post-commit VIP teardown fails (cleanup is best-effort)', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({
      data: { id: 'z1', name: 'phx-az1' },
      delete: del,
    } as never);
    const fakeTx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      prefix: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      zoneRedisCredential: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() },
      dnsRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dnsDomain: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    vi.spyOn(ActiveRecordRegistry, 'transaction').mockImplementation(async (cb) => cb(fakeTx as never));
    const { service, prefixService } = makeService();
    prefixService.clearVrrpVipsForZone.mockRejectedValue(new Error('redis down'));

    // Cleanup is best-effort: a post-commit teardown failure must not surface to the caller — the
    // zone is already tombstoned and the reconciler heals stale atoms on its next tick.
    await expect(service.deleteZone('z1')).resolves.toEqual({ success: true });
    expect(del).toHaveBeenCalled();
  });

  it('does not clear VIPs when the in-tx DHCP guard rejects (concurrent-enable race)', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({
      data: { id: 'z1', name: 'phx-az1' },
      delete: vi.fn().mockResolvedValue(undefined),
    } as never);
    const earlyCount = vi.fn().mockResolvedValue(0);
    const txPrefixCount = vi.fn().mockResolvedValue(1);
    const fakeTx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      prefix: { count: txPrefixCount, updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      zoneRedisCredential: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() },
      dnsRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dnsDomain: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    vi.spyOn(ActiveRecordRegistry, 'transaction').mockImplementation(async (cb) => cb(fakeTx as never));
    const clearVrrpVips = vi.fn().mockResolvedValue(undefined);
    const service = new ZonesService(
      { prefix: { count: earlyCount } } as never,
      {
        requirePermission: vi.fn(),
        buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'u', triggeredByEmail: 'a@b' }),
      } as never,
      { assignZoneSafe: vi.fn() } as never,
      {} as never,
      { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { enabled: false } as never,
      { clearVrrpVipsForZone: clearVrrpVips } as never,
      { clearZoneDnsConfig: vi.fn().mockResolvedValue(undefined) } as never,
      { republishForZone: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(service.deleteZone('z1')).rejects.toBeInstanceOf(BadRequestException);
    expect(clearVrrpVips).not.toHaveBeenCalled();
  });

  it('gates zone:delete BEFORE the VIP teardown (an unauthorized caller must not destroy VIP state)', async () => {
    const { service, prefixService, context } = makeService();
    context.requirePermission.mockImplementation(() => {
      throw new ForbiddenException();
    });
    const findSpy = vi.spyOn(ZoneRecord, 'findActiveById');

    await expect(service.deleteZone('z1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(context.requirePermission).toHaveBeenCalledWith('zone', 'delete');
    expect(prefixService.clearVrrpVipsForZone).not.toHaveBeenCalled();
    expect(findSpy).not.toHaveBeenCalled();
  });
});

describe('ZonesService.deleteZone DNS teardown', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clears zone DNS config after the tombstone transaction commits', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({
      data: { id: 'z1', name: 'phx-az1' },
      delete: del,
    } as never);
    const fakeTx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      prefix: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      zoneRedisCredential: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() },
      dnsRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dnsDomain: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const txSpy = vi.spyOn(ActiveRecordRegistry, 'transaction').mockImplementation(async (cb) => cb(fakeTx as never));
    const { service, dnsPublisher } = makeService();

    await service.deleteZone('z1');

    expect(dnsPublisher.clearZoneDnsConfig).toHaveBeenCalledWith('z1');
    expect(txSpy.mock.invocationCallOrder[0]).toBeLessThan(dnsPublisher.clearZoneDnsConfig.mock.invocationCallOrder[0]);
  });
});

// Address/contact writes bypass ZoneRecord (raw Prisma), so the policy proxy can't gate them —
// the service must enforce zone:update itself, before any data access.
describe('ZonesService.deleteZone DNS override reset', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resets per-prefix dns overrides inside the tombstone transaction', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({
      data: { id: 'z1', name: 'phx-az1' },
      delete: del,
    } as never);
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const fakeTx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      prefix: { count: vi.fn().mockResolvedValue(0), updateMany },
      dnsRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dnsDomain: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      zoneRedisCredential: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() },
    };
    vi.spyOn(ActiveRecordRegistry, 'transaction').mockImplementation(async (cb) => cb(fakeTx as never));
    const { service } = makeService();

    await service.deleteZone('z1');

    expect(updateMany).toHaveBeenCalledWith({
      where: { zoneId: 'z1', deletedAt: null },
      data: { dnsServeDns: null, dnsUpstreamOverride: [] },
    });
  });
});

describe('ZonesService zone:update gate on address and contact writes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects every write path before touching records or prisma when the permission is missing', async () => {
    const requirePermission = vi.fn(() => {
      throw new ForbiddenException();
    });
    const prisma = { $transaction: vi.fn(), contact: { create: vi.fn(), update: vi.fn() } };
    const service = new ZonesService(
      prisma as never,
      { requirePermission } as never,
      { assignZoneSafe: vi.fn() } as never,
      {} as never,
      { log: vi.fn(), warn: vi.fn() } as never,
      { enabled: false } as never,
      { clearVrrpVipsForZone: vi.fn() } as never,
      { clearZoneDnsConfig: vi.fn().mockResolvedValue(undefined) } as never,
      { republishForZone: vi.fn().mockResolvedValue(undefined) } as never,
    );
    const findSpy = vi.spyOn(ZoneRecord, 'findActiveById');

    await expect(service.updatePrimaryAddress('z1', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updateShippingAddress('z1', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.createContact('z1', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updateContact('z1', 'c1', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.deleteContact('z1', 'c1')).rejects.toBeInstanceOf(ForbiddenException);

    expect(requirePermission).toHaveBeenCalledTimes(5);
    expect(requirePermission).toHaveBeenCalledWith('zone', 'update');
    expect(findSpy).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });
});

describe('ZonesService.deleteZone DHCP guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects early when DHCP-enabled prefixes exist, without clearing VIPs or entering the tx', async () => {
    const del = vi.fn();
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({
      data: { id: 'z1', name: 'phx-az1' },
      delete: del,
    } as never);
    const clearVrrpVips = vi.fn().mockResolvedValue(undefined);
    const txSpy = vi.spyOn(ActiveRecordRegistry, 'transaction');
    const earlyCount = vi.fn().mockResolvedValue(2);
    const service = new ZonesService(
      { prefix: { count: earlyCount } } as never,
      { requirePermission: vi.fn(), buildAuditPayload: vi.fn() } as never,
      { assignZoneSafe: vi.fn() } as never,
      {} as never,
      { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { enabled: false } as never,
      { clearVrrpVipsForZone: clearVrrpVips } as never,
      { clearZoneDnsConfig: vi.fn().mockResolvedValue(undefined) } as never,
      { republishForZone: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(service.deleteZone('z1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.deleteZone('z1')).rejects.toThrow(/DHCP enabled/);
    expect(earlyCount).toHaveBeenCalledWith({
      where: { zoneId: 'z1', deletedAt: null, dhcpMode: { notIn: ['OFF'] } },
    });
    expect(clearVrrpVips).not.toHaveBeenCalled();
    expect(txSpy).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('still runs the in-transaction DHCP count as the atomic backstop, without clearing VIPs on rejection', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({
      data: { id: 'z1', name: 'phx-az1' },
      delete: vi.fn().mockResolvedValue(undefined),
    } as never);
    const earlyCount = vi.fn().mockResolvedValue(0);
    const txPrefixCount = vi.fn().mockResolvedValue(1);
    const fakeTx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      prefix: { count: txPrefixCount, updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      zoneRedisCredential: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() },
      dnsRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dnsDomain: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    vi.spyOn(ActiveRecordRegistry, 'transaction').mockImplementation(async (cb) => cb(fakeTx as never));
    const clearVrrpVips = vi.fn().mockResolvedValue(undefined);
    const service = new ZonesService(
      { prefix: { count: earlyCount } } as never,
      { requirePermission: vi.fn(), buildAuditPayload: vi.fn() } as never,
      { assignZoneSafe: vi.fn() } as never,
      {} as never,
      { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { enabled: false } as never,
      { clearVrrpVipsForZone: clearVrrpVips } as never,
      { clearZoneDnsConfig: vi.fn().mockResolvedValue(undefined) } as never,
      { republishForZone: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(service.deleteZone('z1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.deleteZone('z1')).rejects.toThrow(/DHCP enabled/);
    expect(earlyCount).toHaveBeenCalled();
    expect(txPrefixCount).toHaveBeenCalledWith({
      where: { zoneId: 'z1', deletedAt: null, dhcpMode: { notIn: ['OFF'] } },
    });
    expect(clearVrrpVips).not.toHaveBeenCalled();
  });

  it('allows deletion when no DHCP-enabled prefixes remain', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({
      data: { id: 'z1', name: 'phx-az1' },
      delete: vi.fn().mockResolvedValue(undefined),
    } as never);
    const earlyCount = vi.fn().mockResolvedValue(0);
    const txPrefixCount = vi.fn().mockResolvedValue(0);
    const fakeTx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      prefix: { count: txPrefixCount, updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      zoneRedisCredential: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() },
      dnsRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dnsDomain: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    vi.spyOn(ActiveRecordRegistry, 'transaction').mockImplementation(async (cb) => cb(fakeTx as never));
    const service = new ZonesService(
      { prefix: { count: earlyCount } } as never,
      {
        requirePermission: vi.fn(),
        buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'u', triggeredByEmail: 'a@b' }),
      } as never,
      { assignZoneSafe: vi.fn() } as never,
      {} as never,
      { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { enabled: false } as never,
      { clearVrrpVipsForZone: vi.fn().mockResolvedValue(undefined) } as never,
      { clearZoneDnsConfig: vi.fn().mockResolvedValue(undefined) } as never,
      { republishForZone: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await service.deleteZone('z1');

    expect(earlyCount).toHaveBeenCalledWith({
      where: { zoneId: 'z1', deletedAt: null, dhcpMode: { notIn: ['OFF'] } },
    });
    expect(txPrefixCount).toHaveBeenCalledWith({
      where: { zoneId: 'z1', deletedAt: null, dhcpMode: { notIn: ['OFF'] } },
    });
  });
});

describe('ZonesService.getDhcpPrefixSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws NotFoundException when the zone does not exist', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue(null);
    const { service } = makeService();

    await expect(service.getDhcpPrefixSummary('no-such-zone')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns an empty array when the zone has no prefixes', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: 'z1' } } as never);
    const { service } = makeService({ queryRawResult: [] });

    const result = await service.getDhcpPrefixSummary('z1');
    expect(result).toEqual([]);
  });

  it('maps rows and computes dhcpEligible correctly', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: 'z1' } } as never);
    const P1 = '00000000-0000-4000-8000-000000000001';
    const P2 = '00000000-0000-4000-8000-000000000002';
    const P3 = '00000000-0000-4000-8000-000000000003';
    const P4 = '00000000-0000-4000-8000-000000000004';
    const rows = [
      { prefixId: P1, cidr: '10.0.0.0/24', role: 'PRIMARY', dhcpMode: 'AUTHORITATIVE' },
      { prefixId: P2, cidr: '10.0.1.0/24', role: 'NAT', dhcpMode: null },
      { prefixId: P3, cidr: 'fd00::/64', role: 'MANAGEMENT', dhcpMode: null },
      { prefixId: P4, cidr: '10.0.2.0/24', role: null, dhcpMode: 'OFF' },
    ];
    const { service } = makeService({ queryRawResult: rows });

    const result = await service.getDhcpPrefixSummary('z1');

    expect(result).toHaveLength(4);

    expect(result[0]).toEqual({
      prefixId: P1,
      cidr: '10.0.0.0/24',
      role: 'PRIMARY',
      dhcpMode: 'AUTHORITATIVE',
      dhcpEligible: true,
    });

    expect(result[1]).toEqual({
      prefixId: P2,
      cidr: '10.0.1.0/24',
      role: 'NAT',
      dhcpMode: null,
      dhcpEligible: false,
    });

    expect(result[2]).toEqual({
      prefixId: P3,
      cidr: 'fd00::/64',
      role: 'MANAGEMENT',
      dhcpMode: null,
      dhcpEligible: false,
    });

    expect(result[3]).toEqual({
      prefixId: P4,
      cidr: '10.0.2.0/24',
      role: null,
      dhcpMode: 'OFF',
      dhcpEligible: true,
    });
  });

  it('passes zoneId and organizationId to the raw query', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: 'z1' } } as never);
    const { service, prisma } = makeService({ queryRawResult: [] });

    await service.getDhcpPrefixSummary('z1');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const callArgs = prisma.$queryRaw.mock.calls[0];
    const templateStrings = callArgs[0] as TemplateStringsArray;
    const sqlText = templateStrings.join('?');
    expect(sqlText).toContain('"zoneId"');
    expect(sqlText).toContain('"organizationId"');
    expect(sqlText).toContain('"deletedAt" IS NULL');
    const interpolated = callArgs.slice(1);
    expect(interpolated).toContain('z1');
    expect(interpolated).toContain('org-1');
  });
});

describe('ZonesService.getVrrpPrefixSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws NotFoundException when the zone does not exist', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue(null);
    const { service } = makeService();

    await expect(service.getVrrpPrefixSummary('no-such-zone')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns an empty array when the zone has no VIP-bearing prefixes', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: 'z1' } } as never);
    const { service } = makeService({ queryRawResult: [] });

    const result = await service.getVrrpPrefixSummary('z1');
    expect(result).toEqual([]);
  });

  it('maps rows correctly including prefixes with no bindings', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: 'z1' } } as never);
    const P1 = '00000000-0000-4000-8000-000000000001';
    const P2 = '00000000-0000-4000-8000-000000000002';
    const rows = [
      { prefixId: P1, cidr: '10.0.0.0/24', role: 'PRIMARY', vip: '10.0.0.1/24', ifaceByBridge: { 'bridge-1': 'eth0' } },
      { prefixId: P2, cidr: '10.0.1.0/24', role: 'MANAGEMENT', vip: '10.0.1.1/24', ifaceByBridge: {} },
    ];
    const { service } = makeService({ queryRawResult: rows });

    const result = await service.getVrrpPrefixSummary('z1');

    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      prefixId: P1,
      cidr: '10.0.0.0/24',
      role: 'PRIMARY',
      vip: '10.0.0.1/24',
      ifaceByBridge: { 'bridge-1': 'eth0' },
    });

    expect(result[1]).toEqual({
      prefixId: P2,
      cidr: '10.0.1.0/24',
      role: 'MANAGEMENT',
      vip: '10.0.1.1/24',
      ifaceByBridge: {},
    });
  });

  it('includes a prefix with null vip (soft-deleted VIP IpAddress)', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: 'z1' } } as never);
    const P1 = '00000000-0000-4000-8000-000000000001';
    const P2 = '00000000-0000-4000-8000-000000000002';
    const rows = [
      { prefixId: P1, cidr: '10.0.0.0/24', role: 'PRIMARY', vip: '10.0.0.1/24', ifaceByBridge: { 'bridge-1': 'eth0' } },
      { prefixId: P2, cidr: '10.0.2.0/24', role: 'PRIMARY', vip: null, ifaceByBridge: { 'bridge-1': 'eth1' } },
    ];
    const { service, logger } = makeService({ queryRawResult: rows });

    const result = await service.getVrrpPrefixSummary('z1');

    expect(result).toHaveLength(2);
    expect(result[1].vip).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips malformed rows and logs a warning', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: 'z1' } } as never);
    const P1 = '00000000-0000-4000-8000-000000000001';
    const goodRow = { prefixId: P1, cidr: '10.0.0.0/24', role: 'PRIMARY', vip: '10.0.0.1/24', ifaceByBridge: {} };
    const badRow = {
      prefixId: 'not-a-uuid',
      cidr: '10.0.1.0/24',
      role: 'PRIMARY',
      vip: '10.0.1.1/24',
      ifaceByBridge: {},
    };
    const { service, logger } = makeService({ queryRawResult: [goodRow, badRow] });

    const result = await service.getVrrpPrefixSummary('z1');

    expect(result).toHaveLength(1);
    expect(result[0].prefixId).toBe(P1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping malformed VRRP prefix'));
  });

  it('passes zoneId and organizationId to the raw query', async () => {
    vi.spyOn(ZoneRecord, 'findActiveById').mockResolvedValue({ data: { id: 'z1' } } as never);
    const { service, prisma } = makeService({ queryRawResult: [] });

    await service.getVrrpPrefixSummary('z1');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const callArgs = prisma.$queryRaw.mock.calls[0];
    const templateStrings = callArgs[0] as TemplateStringsArray;
    const sqlText = templateStrings.join('?');
    expect(sqlText).toContain('"zoneId"');
    expect(sqlText).toContain('"organizationId"');
    expect(sqlText).toContain('"deletedAt" IS NULL');
    expect(sqlText).toContain('"vrrpVipId" IS NOT NULL');
    const interpolated = callArgs.slice(1);
    expect(interpolated).toContain('z1');
    expect(interpolated).toContain('org-1');
  });
});
