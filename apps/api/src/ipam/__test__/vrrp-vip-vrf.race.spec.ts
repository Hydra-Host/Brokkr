import { ConflictException } from '@nestjs/common';
import { IpAddress, IpamRole } from '@repo/api-client';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpAddressEntity } from '../ip-address/ip-address.entity';
import { IpAddressRepository } from '../ip-address/ip-address.repository';
import { PrefixEntity } from '../prefix/prefix.entity';
import { PrefixRepository } from '../prefix/prefix.repository';

const ORG_ID = 'org-1';
const PREFIX_ID = 'prefix-1';
const IP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const SCOPE_PREFIX = (vrfId: string | null) => `ipam:prefix:${ORG_ID}:${vrfId ?? 'default'}`;
const SCOPE_IP = (vrfId: string | null) => `ipam:ip-address:${ORG_ID}:${vrfId ?? 'default'}`;
const PREFIX_LOCK = `ipam:prefix-id:${ORG_ID}:${PREFIX_ID}`;
const IP_LOCK = `ipam:ip-vip:${ORG_ID}:${IP_ID}`;

function makeTx(queryResults: unknown[]) {
  const lockKeys: string[] = [];
  let queryIdx = 0;
  const $executeRaw = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('');
    if (sql.includes('pg_advisory_xact_lock')) {
      lockKeys.push(String(values[0]));
    }
    return Promise.resolve(0);
  });
  const $queryRaw = vi.fn(() => Promise.resolve(queryResults[queryIdx++] ?? []));
  const changelog = { create: vi.fn(() => Promise.resolve({})) };
  return { tx: { $executeRaw, $queryRaw, changelog }, lockKeys };
}

function ipAddressRow(vrfId: string | null): IpAddress {
  return {
    id: IP_ID,
    address: '10.0.1.5',
    status: 'ACTIVE',
    dnsName: null,
    organizationId: ORG_ID,
    vrfId,
    interfaceId: null,
    assignedObjectType: null,
    assignedObjectId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  };
}

describe('VRRP VIP / IP-VRF cross-aggregate lock', () => {
  const contextService = {
    organizationId: ORG_ID,
    resolveActor: () => ({ actorId: 'user-1', actorType: 'USER' }),
    identity: { organizationId: ORG_ID },
  } as unknown as ContextService;

  describe('PrefixRepository.updateWithConflictGuard (VIP assign)', () => {
    let prisma: { $transaction: ReturnType<typeof vi.fn> };
    let repo: PrefixRepository;

    function buildVipEntity(prefixVrfId: string | null, role: IpamRole | null = 'PRIMARY'): PrefixEntity {
      const entity = PrefixEntity.restore({
        id: PREFIX_ID,
        prefix: '10.0.1.0/24',
        status: 'ACTIVE',
        isPool: false,
        role,
        organizationId: ORG_ID,
        vrfId: prefixVrfId,
        parentId: null,
        vlanId: null,
        gatewayIpId: null,
        vrrpVipId: null,
        prefixRoleId: null,
        enableVlanTag: false,
        bondParameters: null,
        zoneId: 'zone-1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      });
      entity.setVrrpVip(IP_ID);
      return entity;
    }

    beforeEach(() => {
      prisma = { $transaction: vi.fn() };
      repo = new PrefixRepository(prisma as unknown as PrismaClient, contextService);
    });

    it('locks scope→prefix→ip in the documented global order before validating', async () => {
      const entity = buildVipEntity(null);
      const { tx, lockKeys } = makeTx([
        [{ vrfId: null, role: 'PRIMARY' }],
        [{ id: IP_ID, vrfId: null, address: '10.0.1.5' }],
        [{ contained: true }],
        [],
        [],
        [
          {
            id: PREFIX_ID,
            prefix: '10.0.1.0/24',
            status: 'ACTIVE',
            isPool: false,
            organizationId: ORG_ID,
            vrfId: null,
            parentId: null,
            vlanId: null,
            gatewayIpId: null,
            vrrpVipId: IP_ID,
            prefixRoleId: null,
            enableVlanTag: false,
            bondParameters: null,
            zoneId: 'zone-1',
            createdAt: new Date(0),
            updatedAt: new Date(0),
            deletedAt: null,
          },
        ],
      ]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await repo.updateWithConflictGuard(entity, entity.state);

      expect(lockKeys).toContain(SCOPE_PREFIX(null));
      expect(lockKeys).toContain(PREFIX_LOCK);
      expect(lockKeys).toContain(IP_LOCK);
      expect(lockKeys.indexOf(SCOPE_PREFIX(null))).toBeLessThan(lockKeys.indexOf(PREFIX_LOCK));
      expect(lockKeys.indexOf(PREFIX_LOCK)).toBeLessThan(lockKeys.indexOf(IP_LOCK));
    });

    it('validates the VIP against the CURRENT committed VRF, not the stale snapshot', async () => {
      const entity = buildVipEntity(null);
      const { tx } = makeTx([[{ vrfId: 'vrf-b', role: 'PRIMARY' }], [{ id: IP_ID, vrfId: null, address: '10.0.1.5' }]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state)).rejects.toThrow(
        /VRF scope must match prefix VRF scope/,
      );
    });

    it('rejects when a committed VRF change makes the VIP IP cross-VRF (loser sees committed state)', async () => {
      const entity = buildVipEntity(null);
      const { tx } = makeTx([[{ vrfId: null, role: 'PRIMARY' }], [{ id: IP_ID, vrfId: 'vrf-b', address: '10.0.1.5' }]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state)).rejects.toThrow(
        /VRF scope must match prefix VRF scope/,
      );
    });

    it('rejects a VIP assign against the COMMITTED role, catching a role change after the snapshot', async () => {
      const entity = buildVipEntity(null);
      const { tx } = makeTx([[{ vrfId: null, role: 'COMMON' }]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state)).rejects.toThrow(/PRIMARY-role prefix/);
    });

    it('rejects assigning a VIP to a prefix with no role set', async () => {
      const entity = buildVipEntity(null);
      const { tx } = makeTx([[{ vrfId: null, role: null }]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state)).rejects.toThrow(/PRIMARY-role prefix/);
    });

    it('allows clearing a VIP on a non-PRIMARY prefix (role gate never blocks a null VIP)', async () => {
      const entity = PrefixEntity.restore({
        id: PREFIX_ID,
        prefix: '10.0.1.0/24',
        status: 'ACTIVE',
        isPool: false,
        role: 'COMMON',
        organizationId: ORG_ID,
        vrfId: null,
        parentId: null,
        vlanId: null,
        gatewayIpId: null,
        vrrpVipId: IP_ID,
        prefixRoleId: null,
        enableVlanTag: false,
        bondParameters: null,
        zoneId: 'zone-1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      });
      entity.clearVrrpVip();
      const savedRow = {
        id: PREFIX_ID,
        prefix: '10.0.1.0/24',
        status: 'ACTIVE',
        isPool: false,
        role: 'COMMON',
        organizationId: ORG_ID,
        vrfId: null,
        parentId: null,
        vlanId: null,
        gatewayIpId: null,
        vrrpVipId: null,
        prefixRoleId: null,
        enableVlanTag: false,
        bondParameters: null,
        zoneId: 'zone-1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      };
      const { tx } = makeTx([[savedRow]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state)).resolves.toMatchObject({ vrrpVipId: null });
    });

    it('rejects moving a VIP-bearing prefix off PRIMARY (role change, re-reads committed VIP)', async () => {
      const entity = PrefixEntity.restore({
        id: PREFIX_ID,
        prefix: '10.0.1.0/24',
        status: 'ACTIVE',
        isPool: false,
        role: 'PRIMARY',
        organizationId: ORG_ID,
        vrfId: null,
        parentId: null,
        vlanId: null,
        gatewayIpId: null,
        vrrpVipId: IP_ID,
        prefixRoleId: null,
        enableVlanTag: false,
        bondParameters: null,
        zoneId: 'zone-1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      });
      entity.applyUpdate({ role: 'COMMON' });
      const { tx } = makeTx([[{ vrrpVipId: IP_ID }], [{ vrfId: null, role: 'PRIMARY' }]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state)).rejects.toThrow(/PRIMARY-role prefix/);
    });

    it('rejects a VRF-changing update that leaves an existing VIP IP in the old VRF', async () => {
      const entity = PrefixEntity.restore({
        id: PREFIX_ID,
        prefix: '10.0.1.0/24',
        status: 'ACTIVE',
        isPool: false,
        role: 'PRIMARY',
        organizationId: ORG_ID,
        vrfId: 'vrf-a',
        parentId: null,
        vlanId: null,
        gatewayIpId: null,
        vrrpVipId: IP_ID,
        prefixRoleId: null,
        enableVlanTag: false,
        bondParameters: null,
        zoneId: 'zone-1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      });
      entity.applyUpdate({ vrfId: 'vrf-b' });
      const { tx } = makeTx([
        [{ vrrpVipId: IP_ID }],
        [{ vrfId: 'vrf-a', role: 'PRIMARY' }],
        [{ id: IP_ID, vrfId: 'vrf-a', address: '10.0.1.5' }],
      ]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state, true)).rejects.toThrow(
        /VRF scope must match prefix VRF scope/,
      );
    });

    it('re-reads the committed VIP on a VRF change and rejects one assigned cross-VRF after the snapshot', async () => {
      const entity = PrefixEntity.restore({
        id: PREFIX_ID,
        prefix: '10.0.1.0/24',
        status: 'ACTIVE',
        isPool: false,
        role: 'PRIMARY',
        organizationId: ORG_ID,
        vrfId: 'vrf-a',
        parentId: null,
        vlanId: null,
        gatewayIpId: null,
        vrrpVipId: null,
        prefixRoleId: null,
        enableVlanTag: false,
        bondParameters: null,
        zoneId: 'zone-1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      });
      entity.applyUpdate({ vrfId: 'vrf-b' });
      const { tx } = makeTx([
        [{ vrrpVipId: IP_ID }],
        [{ vrfId: 'vrf-a', role: 'PRIMARY' }],
        [{ id: IP_ID, vrfId: 'vrf-a', address: '10.0.1.5' }],
      ]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state, true)).rejects.toThrow(
        /VRF scope must match prefix VRF scope/,
      );
    });

    it('takes the prefix-id lock when a VRF-changing update has no VIP (serializes with VIP-assign)', async () => {
      const entity = PrefixEntity.restore({
        id: PREFIX_ID,
        prefix: '10.0.1.0/24',
        status: 'ACTIVE',
        isPool: false,
        role: null,
        organizationId: ORG_ID,
        vrfId: null,
        parentId: null,
        vlanId: null,
        gatewayIpId: null,
        vrrpVipId: null,
        prefixRoleId: null,
        enableVlanTag: false,
        bondParameters: null,
        zoneId: 'zone-1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      });
      entity.applyUpdate({ vrfId: 'vrf-b' });
      const { tx, lockKeys } = makeTx([
        [{ vrrpVipId: null }],
        [
          {
            id: PREFIX_ID,
            prefix: '10.0.1.0/24',
            status: 'ACTIVE',
            isPool: false,
            organizationId: ORG_ID,
            vrfId: 'vrf-b',
            parentId: null,
            vlanId: null,
            gatewayIpId: null,
            vrrpVipId: null,
            prefixRoleId: null,
            enableVlanTag: false,
            bondParameters: null,
            zoneId: 'zone-1',
            createdAt: new Date(0),
            updatedAt: new Date(0),
            deletedAt: null,
          },
        ],
      ]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await repo.updateWithConflictGuard(entity, entity.state, true);

      expect(lockKeys).toContain(SCOPE_PREFIX('vrf-b'));
      expect(lockKeys).toContain(PREFIX_LOCK);
      expect(lockKeys.indexOf(SCOPE_PREFIX('vrf-b'))).toBeLessThan(lockKeys.indexOf(PREFIX_LOCK));
    });
  });

  describe('IpAddressRepository.updateWithConflictGuard (IP VRF change)', () => {
    let prisma: { $transaction: ReturnType<typeof vi.fn> };
    let repo: IpAddressRepository;

    function buildVrfChangeEntity(): IpAddressEntity {
      const entity = IpAddressEntity.restore(ipAddressRow(null));
      entity.applyUpdate({ vrfId: 'vrf-b' });
      return entity;
    }

    function buildInterfaceAssignEntity(): IpAddressEntity {
      const entity = IpAddressEntity.restore(ipAddressRow(null));
      entity.applyUpdate({ interfaceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
      return entity;
    }

    beforeEach(() => {
      prisma = { $transaction: vi.fn() };
      repo = new IpAddressRepository(prisma as unknown as PrismaClient, contextService);
    });

    it('locks the shared IP after the IP scope and re-asserts not-in-use within the tx', async () => {
      const entity = buildVrfChangeEntity();
      const { tx, lockKeys } = makeTx([[], [], [ipAddressRow('vrf-b')]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await repo.updateWithConflictGuard(entity, entity.state, true);

      expect(lockKeys).toContain(SCOPE_IP('vrf-b'));
      expect(lockKeys).toContain(IP_LOCK);
      expect(lockKeys.indexOf(SCOPE_IP('vrf-b'))).toBeLessThan(lockKeys.indexOf(IP_LOCK));
    });

    it('rejects the VRF change when a committed VIP assign now references the IP', async () => {
      const entity = buildVrfChangeEntity();
      const { tx } = makeTx([[{ id: PREFIX_ID }]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state, true)).rejects.toThrow(ConflictException);
    });

    it('takes the shared IP lock for an interface-assign (vrfChanged=false) and re-asserts in-tx', async () => {
      const entity = buildInterfaceAssignEntity();
      const { tx, lockKeys } = makeTx([[], [ipAddressRow(null)]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await repo.updateWithConflictGuard(entity, entity.state, false);

      expect(lockKeys).toContain(SCOPE_IP(null));
      expect(lockKeys).toContain(IP_LOCK);
      expect(lockKeys.indexOf(SCOPE_IP(null))).toBeLessThan(lockKeys.indexOf(IP_LOCK));
    });

    it('rejects an interface-assign when a committed VIP assign now references the IP', async () => {
      const entity = buildInterfaceAssignEntity();
      const { tx } = makeTx([[{ id: PREFIX_ID }]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await expect(repo.updateWithConflictGuard(entity, entity.state, false)).rejects.toThrow(ConflictException);
    });

    it('does not take the IP lock when the VRF is unchanged', async () => {
      const entity = IpAddressEntity.restore(ipAddressRow(null));
      entity.applyUpdate({ status: 'RESERVED' });
      const { tx, lockKeys } = makeTx([[ipAddressRow(null)]]);
      prisma.$transaction.mockImplementation((handler) => handler(tx));

      await repo.updateWithConflictGuard(entity, entity.state, false);

      expect(lockKeys).toContain(SCOPE_IP(null));
      expect(lockKeys).not.toContain(IP_LOCK);
    });
  });
});
