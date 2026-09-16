import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@repo/database';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { NetplanLiveInvalidatorService } from 'src/brokkr-bridge/netplan/netplan-live-invalidator.service';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { describe, expect, it, vi } from 'vitest';
import { IpamChangelogRepository } from '../changelog/changelog.repository';
import { IpAddressRepository } from '../ip-address/ip-address.repository';
import { IpAddressService } from '../ip-address/ip-address.service';
import { IpRangeRepository } from '../ip-range/ip-range.repository';
import { PrefixRepository } from '../prefix/prefix.repository';
import { VlanRepository } from '../vlan/vlan.repository';
import { VlanService } from '../vlan/vlan.service';
import { VrfRepository } from '../vrf/vrf.repository';
import { VrfService } from '../vrf/vrf.service';

class TestContextService extends ContextService {
  override requirePermission(): undefined {
    return undefined;
  }
  override get organizationId(): string {
    return '11111111-1111-1111-1111-111111111111';
  }
}

describe('IPAM resource repositories validations', () => {
  const makeVlanRow = (overrides?: Record<string, unknown>) => ({
    id: 'vlan-1',
    name: 'prod',
    vid: 100,
    description: 'before',
    status: 'ACTIVE',
    organizationId: '11111111-1111-1111-1111-111111111111',
    vrfId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  });

  const createModule = async (queryRawMock: ReturnType<typeof vi.fn>) => {
    const executeRawMock = vi.fn().mockResolvedValue(1);
    const changelogCreateMock = vi.fn().mockResolvedValue({});
    const txClient = {
      $queryRaw: queryRawMock,
      $executeRaw: executeRawMock,
      changelog: {
        create: changelogCreateMock,
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        VlanRepository,
        VlanService,
        IpAddressService,
        {
          provide: DhcpConfigPublisherService,
          useValue: {
            republishForIpAddress: vi.fn(),
            republishForReservation: vi.fn(),
          },
        },
        { provide: NetplanLiveInvalidatorService, useValue: { forInterface: vi.fn() } },
        PrefixRepository,
        IpRangeRepository,
        IpAddressRepository,
        VrfService,
        VrfRepository,
        IpamChangelogRepository,
        {
          provide: PrismaClient,
          useValue: {
            queryRaw: queryRawMock,
            $queryRaw: queryRawMock,
            $executeRaw: executeRawMock,
            $transaction: vi.fn((handler: (tx: typeof txClient) => Promise<unknown>) => handler(txClient)),
            vrf: {
              findMany: vi.fn().mockResolvedValue([]),
              create: vi.fn(),
              update: vi.fn(),
              findFirst: vi.fn(),
            },
            prefix: {
              findMany: vi.fn().mockResolvedValue([]),
            },
            ipAddress: {
              findMany: vi.fn().mockResolvedValue([]),
            },
            vlan: {
              findMany: vi.fn().mockResolvedValue([]),
            },
            ipRange: {
              findMany: vi.fn().mockResolvedValue([]),
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

  it('rejects VLAN creation when active scope already has same VID or name', async () => {
    const queryRawSpy = vi.fn();
    queryRawSpy.mockResolvedValueOnce([{ id: 'existing-vlan-id' }]);
    const moduleRef = await createModule(queryRawSpy);
    const service = moduleRef.get(VlanService);

    await expect(
      service.createVlan({
        name: 'prod-vlan',
        vid: 100,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns ConflictException when the database rejects a raced VLAN duplicate', async () => {
    const queryRawSpy = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2010',
          clientVersion: 'test',
          meta: { code: '23505' },
        }),
      );
    const moduleRef = await createModule(queryRawSpy);
    const service = moduleRef.get(VlanService);

    await expect(
      service.createVlan({
        name: 'prod-vlan',
        vid: 100,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects VLAN update when uniqueness check finds conflict', async () => {
    const queryRawSpy = vi.fn();
    queryRawSpy.mockResolvedValueOnce([makeVlanRow()]).mockResolvedValueOnce([{ id: 'existing-vlan-id' }]);
    const moduleRef = await createModule(queryRawSpy);
    const service = moduleRef.get(VlanService);

    await expect(
      service.updateVlan('vlan-1', {
        name: 'prod-vlan',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates VLAN without uniqueness query for description-only change', async () => {
    const queryRawSpy = vi.fn();
    queryRawSpy.mockResolvedValueOnce([makeVlanRow()]).mockResolvedValueOnce([makeVlanRow({ description: null })]);
    const moduleRef = await createModule(queryRawSpy);
    const service = moduleRef.get(VlanService);

    const updated = await service.updateVlan('vlan-1', { description: null });

    expect(updated.description).toBeNull();
    expect(queryRawSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects VLAN vrf-only move when target scope has same vid or name', async () => {
    const queryRawSpy = vi.fn();
    queryRawSpy
      .mockResolvedValueOnce([makeVlanRow({ vrfId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })])
      .mockResolvedValueOnce([{ id: 'existing-vlan-id' }]);
    const moduleRef = await createModule(queryRawSpy);
    const service = moduleRef.get(VlanService);

    await expect(
      service.updateVlan('vlan-1', {
        vrfId: null,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects VRF creation when name or RD already exists', async () => {
    const queryRawSpy = vi.fn();
    queryRawSpy.mockResolvedValueOnce([{ id: 'existing-vrf-id' }]);

    const moduleRef = await createModule(queryRawSpy);
    const service = moduleRef.get(VrfService);

    await expect(
      service.createVrf({
        name: 'prod-vrf',
        rd: '65000:1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports invalid gateway when IP is outside the prefix', async () => {
    const queryRawSpy = vi.fn();
    queryRawSpy
      .mockResolvedValueOnce([
        {
          id: 'prefix-id',
          prefix: '10.0.0.0/24',
          status: 'ACTIVE',
          isPool: false,
          organizationId: '11111111-1111-1111-1111-111111111111',
          vrfId: null,
          parentId: null,
          vlanId: null,
          gatewayIpId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'gateway-ip',
          vrfId: null,
          address: '192.168.1.1',
        },
      ])
      .mockResolvedValueOnce([{ contained: false }]);

    const moduleRef = await createModule(queryRawSpy);
    const repository = moduleRef.get(PrefixRepository);
    const result = await repository.validatePrefixGatewayRequest({
      prefixId: 'prefix-id',
      gatewayIpId: 'gateway-ip',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('within the target prefix');
  });

  it('detects overlapping IP range inside same prefix scope', async () => {
    const queryRawSpy = vi.fn();
    queryRawSpy
      .mockResolvedValueOnce([
        {
          id: 'prefix-id',
          prefix: '10.0.0.0/24',
          status: 'ACTIVE',
          isPool: true,
          organizationId: '11111111-1111-1111-1111-111111111111',
          vrfId: null,
          parentId: null,
          vlanId: null,
          gatewayIpId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
      ])
      .mockResolvedValueOnce([{ normalized: '10.0.0.10' }])
      .mockResolvedValueOnce([{ normalized: '10.0.0.20' }])
      .mockResolvedValueOnce([{ valid: true }])
      .mockResolvedValueOnce([{ startContained: true, endContained: true }])
      .mockResolvedValueOnce([
        {
          id: 'range-1',
          start: '10.0.0.15',
          end: '10.0.0.25',
        },
      ]);

    const moduleRef = await createModule(queryRawSpy);
    const repository = moduleRef.get(IpRangeRepository);
    const result = await repository.detectIpRangeOverlap({
      prefixId: 'prefix-id',
      start: '10.0.0.10',
      end: '10.0.0.20',
    });

    expect(result.hasOverlap).toBe(true);
    expect(result.conflictingRangeId).toBe('range-1');
  });

  it('scopes changelog reads directly by organizationId without owned-PK prefetch', async () => {
    const queryRawSpy = vi.fn();
    const moduleRef = await createModule(queryRawSpy);
    const repository = moduleRef.get(IpamChangelogRepository);
    const prisma = moduleRef.get(PrismaClient);

    const prefixFindMany = vi.fn();
    const vlanFindMany = vi.fn();
    Reflect.set(Reflect.get(prisma, 'prefix'), 'findMany', prefixFindMany);
    Reflect.set(Reflect.get(prisma, 'vlan'), 'findMany', vlanFindMany);

    const changelog = Reflect.get(prisma, 'changelog');
    const findManyMock = vi.fn().mockResolvedValue([]);
    Reflect.set(changelog, 'findMany', findManyMock);

    await repository.listIpamChangelog({}, '11111111-1111-1111-1111-111111111111');

    expect(findManyMock).toHaveBeenCalledWith({
      where: {
        organizationId: '11111111-1111-1111-1111-111111111111',
        tableName: { in: ['Vrf', 'Prefix', 'IpAddress', 'Vlan', 'IpRange'] },
      },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });
    expect(prefixFindMany).not.toHaveBeenCalled();
    expect(vlanFindMany).not.toHaveBeenCalled();
  });

  it('narrows by tableName + pk while keeping the org filter (tenant isolation via DB)', async () => {
    const queryRawSpy = vi.fn();
    const moduleRef = await createModule(queryRawSpy);
    const repository = moduleRef.get(IpamChangelogRepository);
    const prisma = moduleRef.get(PrismaClient);

    const changelog = Reflect.get(prisma, 'changelog');
    const findManyMock = vi.fn().mockResolvedValue([]);
    Reflect.set(changelog, 'findMany', findManyMock);

    await repository.listIpamChangelog(
      { tableName: 'Prefix', pk: 'pfx-foreign' },
      '11111111-1111-1111-1111-111111111111',
    );

    expect(findManyMock).toHaveBeenCalledWith({
      where: {
        organizationId: '11111111-1111-1111-1111-111111111111',
        tableName: { in: ['Prefix'] },
        pk: 'pfx-foreign',
      },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });
  });
});
