import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrefixRepository } from '../prefix.repository';

class TestContextService extends ContextService {
  override get organizationId(): string {
    return '11111111-1111-1111-1111-111111111111';
  }
}

const ORG_ID = '11111111-1111-1111-1111-111111111111';

class TestVipRepository extends PrefixRepository {
  runValidateVrrpVip(vrrpVipId: string) {
    return this.validatePrefixVrrpVip({
      prefixId: 'prefix-1',
      vrrpVipId,
      candidatePrefix: '10.0.0.0/24',
      candidateVrfId: null,
    });
  }
}

function makeVipRepo(queryRawMock: ReturnType<typeof vi.fn>): TestVipRepository {
  return new TestVipRepository(
    { $queryRaw: queryRawMock } as unknown as PrismaClient,
    new TestContextService(new DesignationOperatorPolicy()),
  );
}

function makeVipIpRow(overrides?: Record<string, unknown>) {
  return { id: 'vip-1', vrfId: null, address: '10.0.0.5', ...overrides };
}

function makePrefixRow(overrides?: Record<string, unknown>) {
  return {
    id: 'prefix-1',
    prefix: '10.0.0.0/24',
    status: 'ACTIVE',
    isPool: false,
    role: null,
    zoneId: null,
    organizationId: ORG_ID,
    vrfId: null,
    parentId: null,
    vlanId: null,
    gatewayIpId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe('PrefixRepository validation methods', () => {
  const createModule = async (queryRawMock: ReturnType<typeof vi.fn>) => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PrefixRepository,
        {
          provide: PrismaClient,
          useValue: {
            $queryRaw: queryRawMock,
            $executeRaw: vi.fn(),
            $transaction: vi.fn(),
            vrf: {
              findMany: vi.fn(),
              create: vi.fn(),
              update: vi.fn(),
              findFirst: vi.fn(),
            },
            device: {
              findMany: vi.fn(),
              findUnique: vi.fn(),
            },
            changelog: {
              findMany: vi.fn(),
              create: vi.fn(),
            },
          },
        },
        {
          provide: ContextService,
          useValue: new TestContextService(new DesignationOperatorPolicy()),
        },
      ],
    }).compile();

    return moduleRef;
  };

  afterEach(() => vi.clearAllMocks());

  it('normalizePrefix returns normalized CIDR from postgres', async () => {
    const queryRawSpy = vi.fn().mockResolvedValueOnce([{ normalized: '10.0.0.0/24' }]);
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const result = await repo.normalizePrefix('10.0.0.5/24');
    expect(result).toBe('10.0.0.0/24');
  });

  it('normalizePrefix rejects invalid CIDR', async () => {
    const queryRawSpy = vi.fn().mockRejectedValueOnce(new Error('invalid input syntax for type cidr'));
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    await expect(repo.normalizePrefix('not-a-cidr')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normalizePrefix rejects when query returns empty', async () => {
    const queryRawSpy = vi.fn().mockResolvedValueOnce([]);
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    await expect(repo.normalizePrefix('10.0.0.0/24')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ensureVrf is a no-op when entity does not require vrf validation', async () => {
    const queryRawSpy = vi.fn();
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);
    const prisma = moduleRef.get(PrismaClient);
    const vrfFindFirstSpy = prisma.vrf.findFirst as ReturnType<typeof vi.fn>;

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create({ prefix: '10.0.0.0/24' }, ORG_ID, '10.0.0.0/24');

    await repo.ensureVrf(entity);
    expect(vrfFindFirstSpy).not.toHaveBeenCalled();
  });

  it('ensureVrf throws NotFoundException when VRF does not exist', async () => {
    const queryRawSpy = vi.fn();
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);
    const prisma = moduleRef.get(PrismaClient);
    const vrfFindFirstSpy = prisma.vrf.findFirst as ReturnType<typeof vi.fn>;
    vrfFindFirstSpy.mockResolvedValueOnce(null);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create(
      { prefix: '10.0.0.0/24', vrfId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      ORG_ID,
      '10.0.0.0/24',
    );

    await expect(repo.ensureVrf(entity)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ensureZone is a no-op when zoneId is null', async () => {
    const queryRawSpy = vi.fn();
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create({ prefix: '10.0.0.0/24' }, ORG_ID, '10.0.0.0/24');

    await repo.ensureZone(entity);
    expect(queryRawSpy).not.toHaveBeenCalled();
  });

  it('ensureZone throws NotFoundException when the zone is not in the org', async () => {
    const queryRawSpy = vi.fn().mockResolvedValueOnce([]);
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create(
      { prefix: '10.0.0.0/24', zoneId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
      ORG_ID,
      '10.0.0.0/24',
    );

    await expect(repo.ensureZone(entity)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ensurePrefixRole is a no-op when prefixRoleId is null', async () => {
    const queryRawSpy = vi.fn();
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create({ prefix: '10.0.0.0/24' }, ORG_ID, '10.0.0.0/24');

    await repo.ensurePrefixRole(entity);
    expect(queryRawSpy).not.toHaveBeenCalled();
  });

  it('ensurePrefixRole throws NotFoundException when the role does not exist', async () => {
    const queryRawSpy = vi.fn().mockResolvedValueOnce([]);
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create(
      { prefix: '10.0.0.0/24', prefixRoleId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
      ORG_ID,
      '10.0.0.0/24',
    );

    await expect(repo.ensurePrefixRole(entity)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ensurePrefixRole passes when the role exists', async () => {
    const queryRawSpy = vi.fn().mockResolvedValueOnce([{ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }]);
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create(
      { prefix: '10.0.0.0/24', prefixRoleId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
      ORG_ID,
      '10.0.0.0/24',
    );

    await expect(repo.ensurePrefixRole(entity)).resolves.toBeUndefined();
  });

  it('ensureParent is a no-op when parentId is null on create', async () => {
    const queryRawSpy = vi.fn();
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create({ prefix: '10.0.0.0/24' }, ORG_ID, '10.0.0.0/24');

    await repo.ensureParent(entity, null);
    expect(queryRawSpy).not.toHaveBeenCalled();
  });

  it('ensureParent throws NotFoundException when parent does not exist', async () => {
    const queryRawSpy = vi.fn().mockResolvedValueOnce([]);
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create(
      { prefix: '10.0.0.0/25', parentId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      ORG_ID,
      '10.0.0.0/25',
    );

    await expect(repo.ensureParent(entity, null)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ensureParent throws BadRequestException when VRF scopes differ', async () => {
    const queryRawSpy = vi.fn().mockResolvedValueOnce([
      {
        id: 'parent-1',
        prefix: '10.0.0.0/16',
        vrfId: 'vrf-different',
      },
    ]);
    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create(
      { prefix: '10.0.0.0/24', parentId: 'parent-1', vrfId: null },
      ORG_ID,
      '10.0.0.0/24',
    );

    await expect(repo.ensureParent(entity, null)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ensureParent throws BadRequestException when child is not contained', async () => {
    const queryRawSpy = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'parent-1', prefix: '10.0.0.0/24', vrfId: null }])
      .mockResolvedValueOnce([{ contained: false }]);

    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create(
      { prefix: '192.168.1.0/24', parentId: 'parent-1', vrfId: null },
      ORG_ID,
      '192.168.1.0/24',
    );

    await expect(repo.ensureParent(entity, null)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ensureNoCreateConflict throws ConflictException on overlapping prefix', async () => {
    const queryRawSpy = vi.fn().mockResolvedValueOnce([{ id: 'overlap-1', prefix: '10.0.0.0/16' }]);

    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create({ prefix: '10.0.0.0/24' }, ORG_ID, '10.0.0.0/24');

    await expect(repo.ensureNoCreateConflict(entity)).rejects.toBeInstanceOf(ConflictException);
  });

  it('ensureNoCreateConflict throws ConflictException on exact duplicate prefix', async () => {
    const queryRawSpy = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'dup-1', prefix: '10.0.0.0/24' }]);

    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create({ prefix: '10.0.0.0/24' }, ORG_ID, '10.0.0.0/24');

    await expect(repo.ensureNoCreateConflict(entity)).rejects.toBeInstanceOf(ConflictException);
  });

  it('ensureNoCreateConflict passes when no overlap and no duplicate', async () => {
    const queryRawSpy = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const { PrefixEntity } = await import('../prefix.entity');
    const entity = PrefixEntity.create({ prefix: '10.0.0.0/24' }, ORG_ID, '10.0.0.0/24');

    await expect(repo.ensureNoCreateConflict(entity)).resolves.toBeUndefined();
  });

  it('reports invalid gateway when IP is outside the prefix', async () => {
    const queryRawSpy = vi
      .fn()
      .mockResolvedValueOnce([makePrefixRow()])
      .mockResolvedValueOnce([{ id: 'gw-1', vrfId: null, address: '192.168.1.1' }])
      .mockResolvedValueOnce([{ contained: false }]);

    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const result = await repo.validatePrefixGatewayRequest({
      prefixId: 'prefix-1',
      gatewayIpId: 'gw-1',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('within the target prefix');
  });

  it('reports invalid gateway when VRF scopes do not match', async () => {
    const queryRawSpy = vi
      .fn()
      .mockResolvedValueOnce([makePrefixRow({ vrfId: 'vrf-a' })])
      .mockResolvedValueOnce([{ id: 'gw-1', vrfId: 'vrf-b', address: '10.0.0.1' }]);

    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const result = await repo.validatePrefixGatewayRequest({
      prefixId: 'prefix-1',
      gatewayIpId: 'gw-1',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('VRF scope must match');
  });

  it('rejects a non-IPv4 (IPv6) VRRP VIP', async () => {
    const queryRawSpy = vi
      .fn()
      .mockResolvedValueOnce([makeVipIpRow({ address: '2001:db8::5' })])
      .mockResolvedValueOnce([{ contained: true }])
      .mockResolvedValueOnce([{ family: 6, interfaceId: null, assignedObjectId: null }]);

    const repo = makeVipRepo(queryRawSpy);

    await expect(repo.runValidateVrrpVip('vip-1')).rejects.toThrow('must be an IPv4 address');
    expect(queryRawSpy).toHaveBeenCalledTimes(3);
  });

  it('rejects a VRRP VIP whose IP is bound to a device interface', async () => {
    const queryRawSpy = vi
      .fn()
      .mockResolvedValueOnce([makeVipIpRow()])
      .mockResolvedValueOnce([{ contained: true }])
      .mockResolvedValueOnce([{ family: 4, interfaceId: 'iface-1', assignedObjectId: null }]);

    const repo = makeVipRepo(queryRawSpy);

    await expect(repo.runValidateVrrpVip('vip-1')).rejects.toThrow('assigned to a device interface');
    expect(queryRawSpy).toHaveBeenCalledTimes(3);
  });

  it('accepts an IPv4 VRRP VIP that is unassigned and unique', async () => {
    const queryRawSpy = vi
      .fn()
      .mockResolvedValueOnce([makeVipIpRow()])
      .mockResolvedValueOnce([{ contained: true }])
      .mockResolvedValueOnce([{ family: 4, interfaceId: null, assignedObjectId: null }])
      .mockResolvedValueOnce([]);

    const repo = makeVipRepo(queryRawSpy);

    await expect(repo.runValidateVrrpVip('vip-1')).resolves.toBeUndefined();
    expect(queryRawSpy).toHaveBeenCalledTimes(4);
  });

  it('tags the allocateNextPrefix changelog row with the created prefix org (not null)', async () => {
    const childRow = makePrefixRow({
      id: 'child-1',
      prefix: '10.0.0.0/25',
      parentId: 'parent-1',
      organizationId: ORG_ID,
    });
    const txQueryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ prefix: '10.0.0.0/24', vrfId: null, organizationId: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([childRow]);
    const changelogCreate = vi.fn().mockResolvedValue({});
    const tx = { $queryRaw: txQueryRaw, $executeRaw: vi.fn(), changelog: { create: changelogCreate } };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PrefixRepository,
        {
          provide: PrismaClient,
          useValue: { $transaction: (cb: (t: typeof tx) => unknown) => cb(tx) },
        },
        { provide: ContextService, useValue: new TestContextService(new DesignationOperatorPolicy()) },
      ],
    }).compile();
    const repo = moduleRef.get(PrefixRepository);

    await repo.allocateNextPrefix('parent-1', { targetMask: 25 });

    expect(changelogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tableName: 'Prefix', pk: 'child-1', organizationId: ORG_ID }),
    });
    expect(changelogCreate.mock.calls[0][0].data.organizationId).not.toBeNull();
  });

  it('rejects a target mask equal to the parent mask (would otherwise self-collide → 500)', async () => {
    const txQueryRaw = vi.fn().mockResolvedValueOnce([{ prefix: '10.0.0.0/24', vrfId: null, organizationId: ORG_ID }]);
    const tx = { $queryRaw: txQueryRaw, $executeRaw: vi.fn(), changelog: { create: vi.fn() } };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PrefixRepository,
        { provide: PrismaClient, useValue: { $transaction: (cb: (t: typeof tx) => unknown) => cb(tx) } },
        { provide: ContextService, useValue: new TestContextService(new DesignationOperatorPolicy()) },
      ],
    }).compile();
    const repo = moduleRef.get(PrefixRepository);

    await expect(repo.allocateNextPrefix('parent-1', { targetMask: 24 })).rejects.toBeInstanceOf(BadRequestException);
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('reports valid gateway when IP is inside prefix and VRF matches', async () => {
    const queryRawSpy = vi
      .fn()
      .mockResolvedValueOnce([makePrefixRow()])
      .mockResolvedValueOnce([{ id: 'gw-1', vrfId: null, address: '10.0.0.1' }])
      .mockResolvedValueOnce([{ contained: true }])
      .mockResolvedValueOnce([]);

    const moduleRef = await createModule(queryRawSpy);
    const repo = moduleRef.get(PrefixRepository);

    const result = await repo.validatePrefixGatewayRequest({
      prefixId: 'prefix-1',
      gatewayIpId: 'gw-1',
    });

    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
  });
});
