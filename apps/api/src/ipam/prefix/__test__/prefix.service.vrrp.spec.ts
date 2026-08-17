import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { IpamPrefix } from '@repo/api-client';
import type { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import type { DhcpConfigRedisWriterService } from 'src/brokkr-bridge/dhcp/dhcp-config-redis-writer.service';
import type { DhcpDerivationService } from 'src/brokkr-bridge/dhcp/dhcp-derivation.service';
import type { DhcpLeaseReaderService } from 'src/brokkr-bridge/dhcp/dhcp-lease-reader.service';
import { VrrpRedisWriterService } from 'src/brokkr-bridge/vrrp/vrrp-redis-writer.service';
import { ContextService } from 'src/common/context/context.service';
import { LoggerService } from 'src/logger/logger.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefixRepository } from '../prefix.repository';
import { PrefixService } from '../prefix.service';

const PREFIX_ID = 'prefix-1';
const ZONE_ID = '99999999-0000-0000-0000-000000000000';
const NEW_ZONE_ID = '99999999-1111-1111-1111-111111111111';
const VIP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const IFACE = 'eth0';
const BRIDGE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BINDINGS = [{ bridgeId: BRIDGE_ID, iface: IFACE }];
const IFACE_BY_BRIDGE = { [BRIDGE_ID]: IFACE };

function makePrefix(overrides?: Partial<IpamPrefix>): IpamPrefix {
  return {
    id: PREFIX_ID,
    prefix: '10.0.1.0/24',
    status: 'ACTIVE',
    isPool: false,
    role: null,
    organizationId: 'org-1',
    vrfId: null,
    parentId: null,
    vlanId: null,
    gatewayIpId: null,
    vrrpVipId: null,
    prefixRoleId: null,
    enableVlanTag: false,
    bondParameters: null,
    zoneId: ZONE_ID,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    ...overrides,
  };
}

describe('PrefixService VRRP VIP', () => {
  const repo = {
    restore: vi.fn(),
    normalizePrefix: vi.fn(),
    createWithConflictGuard: vi.fn(),
    ensureVrf: vi.fn(),
    ensureZone: vi.fn(),
    ensurePrefixRole: vi.fn(),
    ensureGateway: vi.fn(),
    requireLiveZone: vi.fn(),
    getDhcpConfig: vi.fn(),
    updateWithConflictGuard: vi.fn(),
    save: vi.fn(),
    persistUnderLock: vi.fn(),
    composeVrrpVip: vi.fn(),
    listVrrpVipBearingPrefixIdsInZone: vi.fn(),
    assertBridgesInZone: vi.fn(),
    replacePrefixVrrpBindings: vi.fn(),
    listPrefixVrrpBindings: vi.fn(),
    getDnsOverride: vi.fn().mockResolvedValue({ serveDns: null, upstreamOverride: [] }),
    syncGatewayRecordOnSet: vi.fn(),
    syncGatewayRecordOnClear: vi.fn(),
    autoEnableAuthoritativeDhcp: vi.fn(),
  };
  const contextService = { requirePermission: vi.fn(), organizationId: 'org-1' };
  const vrrpWriter = { set: vi.fn(), clear: vi.fn() };
  const dhcpWriter = { set: vi.fn(), clear: vi.fn() };
  const dhcpPublisher = { republishOne: vi.fn() };
  const dhcpLeaseReader = { listLeasesForPrefix: vi.fn().mockResolvedValue([]) };
  const dhcpDerivation = { listReservationsForPrefix: vi.fn().mockResolvedValue([]) };
  const dnsPublisher = {
    publishPrefixDnsOverride: vi.fn().mockResolvedValue(true),
    clearPrefixDnsOverride: vi.fn().mockResolvedValue(undefined),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new PrefixService(
    repo as unknown as PrefixRepository,
    contextService as unknown as ContextService,
    vrrpWriter as unknown as VrrpRedisWriterService,
    dhcpWriter as unknown as DhcpConfigRedisWriterService,
    dhcpPublisher as unknown as DhcpConfigPublisherService,
    dhcpLeaseReader as unknown as DhcpLeaseReaderService,
    dhcpDerivation as unknown as DhcpDerivationService,
    dnsPublisher as never,
    logger as unknown as LoggerService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    contextService.requirePermission.mockImplementation(() => undefined);
    repo.normalizePrefix.mockImplementation(async (p) => p);
    repo.createWithConflictGuard.mockImplementation(async (entity) => entity.state as IpamPrefix);
    repo.ensureVrf.mockResolvedValue(undefined);
    repo.ensureZone.mockResolvedValue(undefined);
    repo.ensurePrefixRole.mockResolvedValue(undefined);
    repo.requireLiveZone.mockResolvedValue(undefined);
    repo.getDhcpConfig.mockResolvedValue({ dhcpMode: null });
    repo.persistUnderLock.mockImplementation(async (entity, before, afterSave) => {
      const row = entity.state as IpamPrefix;
      if (afterSave) await afterSave(row, {} as never);
      return row;
    });
    repo.updateWithConflictGuard.mockImplementation(async (entity) => entity.state as IpamPrefix);
    repo.save.mockImplementation(async (entity) => entity.state as IpamPrefix);
    repo.syncGatewayRecordOnSet.mockResolvedValue({ action: 'created', customRowPreserved: false });
    repo.syncGatewayRecordOnClear.mockResolvedValue({ action: 'removed', customRowPreserved: false });
    repo.autoEnableAuthoritativeDhcp.mockResolvedValue('already-configured');
    repo.composeVrrpVip.mockResolvedValue({ vip: '10.0.1.1/24', ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 });
    repo.listVrrpVipBearingPrefixIdsInZone.mockResolvedValue([]);
    repo.assertBridgesInZone.mockResolvedValue(undefined);
    repo.replacePrefixVrrpBindings.mockResolvedValue(undefined);
    vrrpWriter.set.mockResolvedValue({ written: true });
    vrrpWriter.clear.mockResolvedValue(undefined);
    dhcpWriter.set.mockResolvedValue(undefined);
    dhcpWriter.clear.mockResolvedValue(undefined);
    dhcpPublisher.republishOne.mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('set: gates on ipam:update, validates, saves, and publishes the composed VIP', async () => {
    repo.restore.mockResolvedValue(makePrefix());

    await service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, BINDINGS);

    expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'update');
    expect(repo.updateWithConflictGuard).toHaveBeenCalled();
    expect(repo.updateWithConflictGuard.mock.calls[0][2]).toBe(false);
    expect(repo.composeVrrpVip).toHaveBeenCalledWith(PREFIX_ID);
    expect(vrrpWriter.set).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID, '10.0.1.1/24', IFACE_BY_BRIDGE, 5);
  });

  it('set: rejects before any repo access or Redis write when the permission gate throws', async () => {
    contextService.requirePermission.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, BINDINGS)).rejects.toThrow(ForbiddenException);
    expect(repo.restore).not.toHaveBeenCalled();
    expect(vrrpWriter.set).not.toHaveBeenCalled();
  });

  it('set: publishes under the COMMITTED zone, not the pre-lock snapshot (concurrent-relocation guard)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ zoneId: NEW_ZONE_ID, vrrpVipId: VIP_ID }));

    await service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, BINDINGS);

    expect(vrrpWriter.set).toHaveBeenCalledWith(NEW_ZONE_ID, PREFIX_ID, '10.0.1.1/24', IFACE_BY_BRIDGE, 5);
    expect(vrrpWriter.set).not.toHaveBeenCalledWith(ZONE_ID, PREFIX_ID, '10.0.1.1/24', IFACE_BY_BRIDGE, 5);
  });

  it('set: skips the publish when the committed row has no zone (concurrent zone-clear)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ zoneId: null, vrrpVipId: VIP_ID }));

    await service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, BINDINGS);

    expect(vrrpWriter.set).not.toHaveBeenCalled();
  });

  it('set: rethrows and logs when the atom publish fails after the row is committed', async () => {
    repo.restore.mockResolvedValue(makePrefix());
    vrrpWriter.set.mockRejectedValue(new Error('redis down'));

    await expect(service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, BINDINGS)).rejects.toThrow('redis down');
    expect(repo.updateWithConflictGuard).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('set: neither publishes NOR clears when the just-set VIP composes to null (empty bindings)', async () => {
    repo.restore.mockResolvedValue(makePrefix());
    repo.composeVrrpVip.mockResolvedValue(null);

    await service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, []);
    expect(vrrpWriter.set).not.toHaveBeenCalled();
    expect(vrrpWriter.clear).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('set: re-validates bindings against the COMMITTED zone in the locked tx (concurrent zone move)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockImplementationOnce(async (entity, before, vrfChanged, afterSave) => {
      const committed = makePrefix({ zoneId: NEW_ZONE_ID, vrrpVipId: VIP_ID });
      if (afterSave) await afterSave(committed, {} as never);
      return committed;
    });
    repo.assertBridgesInZone
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BadRequestException('wrong zone'));

    await expect(service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, BINDINGS)).rejects.toThrow(BadRequestException);
    expect(repo.assertBridgesInZone).toHaveBeenCalledWith(NEW_ZONE_ID, expect.any(Array));
    expect(repo.replacePrefixVrrpBindings).not.toHaveBeenCalled();
  });

  it('set: rejects (no Redis write, no save) when the prefix has no zone', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: null }));

    await expect(service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, BINDINGS)).rejects.toThrow(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
    expect(vrrpWriter.set).not.toHaveBeenCalled();
  });

  it('set: rejects duplicate bridgeIds with a 400 before any binding write', async () => {
    repo.restore.mockResolvedValue(makePrefix());
    const dupBindings = [
      { bridgeId: BRIDGE_ID, iface: 'eth0' },
      { bridgeId: BRIDGE_ID, iface: 'eth1' },
    ];

    await expect(service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, dupBindings)).rejects.toThrow(BadRequestException);
    expect(repo.updateWithConflictGuard).not.toHaveBeenCalled();
    expect(repo.replacePrefixVrrpBindings).not.toHaveBeenCalled();
    expect(vrrpWriter.set).not.toHaveBeenCalled();
  });

  it('set: logs (without rethrowing) when the atom write is skipped as stale', async () => {
    repo.restore.mockResolvedValue(makePrefix());
    vrrpWriter.set.mockResolvedValue({ written: false, reason: 'stale' });

    await expect(service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, BINDINGS)).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('clear: gates on ipam:update, saves under the IPAM lock, and withdraws the atom', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID }));

    await service.clearPrefixVrrpVip(PREFIX_ID);

    expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'update');
    expect(repo.persistUnderLock).toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
  });

  it('clear: rejects before any repo access or Redis DEL when the permission gate throws', async () => {
    contextService.requirePermission.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.clearPrefixVrrpVip(PREFIX_ID)).rejects.toThrow(ForbiddenException);
    expect(repo.restore).not.toHaveBeenCalled();
    expect(vrrpWriter.clear).not.toHaveBeenCalled();
  });

  it('clear: withdraws under the COMMITTED zone, not the pre-lock snapshot (concurrent-relocation guard)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID, vrrpVipId: VIP_ID }));
    repo.persistUnderLock.mockResolvedValueOnce(makePrefix({ zoneId: NEW_ZONE_ID }));

    await service.clearPrefixVrrpVip(PREFIX_ID);

    expect(vrrpWriter.clear).toHaveBeenCalledWith(NEW_ZONE_ID, PREFIX_ID);
    expect(vrrpWriter.clear).not.toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
  });

  it('clear: skips the Redis withdraw when the prefix has no zone', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: null, vrrpVipId: VIP_ID }));

    await service.clearPrefixVrrpVip(PREFIX_ID);
    expect(vrrpWriter.clear).not.toHaveBeenCalled();
  });

  it('getPrefixVrrpBindings: gates on ipam:read and returns the bindings for an existing prefix', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID }));
    repo.listPrefixVrrpBindings.mockResolvedValue(BINDINGS);

    await expect(service.getPrefixVrrpBindings(PREFIX_ID)).resolves.toEqual(BINDINGS);
    expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'read');
  });

  it('getPrefixVrrpBindings: 404s (via restore) for an unknown/archived/foreign prefix', async () => {
    repo.restore.mockRejectedValue(new NotFoundException('Prefix not found'));

    await expect(service.getPrefixVrrpBindings(PREFIX_ID)).rejects.toThrow(NotFoundException);
    expect(repo.listPrefixVrrpBindings).not.toHaveBeenCalled();
  });

  it('clearVrrpVipsForZone: withdraws the atom (DEL before DB clear) for each VIP-bearing prefix', async () => {
    repo.listVrrpVipBearingPrefixIdsInZone.mockResolvedValue(['p1', 'p2']);
    repo.restore.mockImplementation(async (id: string) => makePrefix({ id, vrrpVipId: VIP_ID }));

    await service.clearVrrpVipsForZone(ZONE_ID);

    expect(repo.listVrrpVipBearingPrefixIdsInZone).toHaveBeenCalledWith(ZONE_ID);
    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, 'p1');
    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, 'p2');
    expect(repo.persistUnderLock).toHaveBeenCalledTimes(2);
    expect(vrrpWriter.clear.mock.invocationCallOrder[0]).toBeLessThan(
      repo.persistUnderLock.mock.invocationCallOrder[0],
    );
  });

  it('clearVrrpVipsForZone: no-op when the zone has no VIP-bearing prefixes', async () => {
    repo.listVrrpVipBearingPrefixIdsInZone.mockResolvedValue([]);

    await service.clearVrrpVipsForZone(ZONE_ID);

    expect(vrrpWriter.clear).not.toHaveBeenCalled();
    expect(repo.persistUnderLock).not.toHaveBeenCalled();
  });

  it('clearVrrpVipsForZone: tolerates a prefix archived mid-cascade (skips it, does not 404 the zone delete)', async () => {
    repo.listVrrpVipBearingPrefixIdsInZone.mockResolvedValue(['p1', 'p2']);
    repo.restore.mockImplementation(async (id: string) => {
      if (id === 'p1') throw new NotFoundException('Prefix not found');
      return makePrefix({ id, vrrpVipId: VIP_ID });
    });

    await expect(service.clearVrrpVipsForZone(ZONE_ID)).resolves.toBeUndefined();
    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, 'p1');
    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, 'p2');
    expect(repo.persistUnderLock).toHaveBeenCalledTimes(1);
  });

  it('clearVrrpVipsForZone: skips a prefix relocated to another zone mid-cascade (does not destroy its VIP)', async () => {
    repo.listVrrpVipBearingPrefixIdsInZone.mockResolvedValue(['p1', 'p2']);
    repo.restore.mockImplementation(async (id: string) =>
      makePrefix({ id, vrrpVipId: VIP_ID, zoneId: id === 'p1' ? NEW_ZONE_ID : ZONE_ID }),
    );

    await service.clearVrrpVipsForZone(ZONE_ID);

    expect(repo.persistUnderLock).toHaveBeenCalledTimes(1);
    expect(repo.persistUnderLock.mock.calls[0][0].state.id).toBe('p2');
  });

  it('updatePrefix: relocates the VIP atom (publish new zone first, then withdraw old)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID, zoneId: ZONE_ID }));

    await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID });

    expect(vrrpWriter.set).toHaveBeenCalledWith(NEW_ZONE_ID, PREFIX_ID, '10.0.1.1/24', IFACE_BY_BRIDGE, 5);
    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
    expect(vrrpWriter.set.mock.invocationCallOrder[0]).toBeLessThan(vrrpWriter.clear.mock.invocationCallOrder[0]);
  });

  it('updatePrefix: skips old-zone VRRP clear when the new-zone publish fails (preserves old atom)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID, zoneId: ZONE_ID }));
    vrrpWriter.set.mockRejectedValue(new Error('redis down'));

    await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID });
    expect(vrrpWriter.set).toHaveBeenCalledWith(NEW_ZONE_ID, PREFIX_ID, '10.0.1.1/24', IFACE_BY_BRIDGE, 5);
    expect(vrrpWriter.clear).not.toHaveBeenCalled();
  });

  it('updatePrefix: relocates off the COMMITTED VIP, not the pre-lock snapshot (concurrent VIP-assign)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: null, zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID, zoneId: NEW_ZONE_ID }));

    await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID });

    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
    expect(vrrpWriter.set).toHaveBeenCalledWith(NEW_ZONE_ID, PREFIX_ID, '10.0.1.1/24', IFACE_BY_BRIDGE, 5);
  });

  it('updatePrefix: no relocation when the prefix carries no VIP', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: null, zoneId: ZONE_ID }));

    await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID });

    expect(vrrpWriter.clear).not.toHaveBeenCalled();
    expect(vrrpWriter.set).not.toHaveBeenCalled();
  });

  it('updatePrefix: unassigning the zone with a VIP set withdraws only (no publish)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID, zoneId: ZONE_ID }));

    await service.updatePrefix(PREFIX_ID, { zoneId: null });

    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
    expect(vrrpWriter.set).not.toHaveBeenCalled();
  });

  it('updatePrefix: a zone move on a VIP-bearing prefix clears the now-stale per-bridge bindings', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID, zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockImplementationOnce(async (entity, before, vrfChanged, afterSave) => {
      const updated = makePrefix({ vrrpVipId: VIP_ID, zoneId: NEW_ZONE_ID });
      if (afterSave) await afterSave(updated, {} as never);
      return updated;
    });

    await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID });

    expect(repo.replacePrefixVrrpBindings).toHaveBeenCalledWith(PREFIX_ID, [], expect.anything());
  });

  it('updatePrefix: a non-zone change with a VIP set touches no atom', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID, zoneId: ZONE_ID }));

    await service.updatePrefix(PREFIX_ID, { status: 'RESERVED' });

    expect(vrrpWriter.clear).not.toHaveBeenCalled();
    expect(vrrpWriter.set).not.toHaveBeenCalled();
  });

  it('updatePrefix: a status-only change does NOT wipe bindings even if the committed zone differs (concurrent move)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID, zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockImplementationOnce(async (entity, before, vrfChanged, afterSave) => {
      const updated = makePrefix({ vrrpVipId: VIP_ID, zoneId: NEW_ZONE_ID });
      if (afterSave) await afterSave(updated, {} as never);
      return updated;
    });

    await service.updatePrefix(PREFIX_ID, { status: 'RESERVED' });

    expect(repo.replacePrefixVrrpBindings).not.toHaveBeenCalled();
    expect(vrrpWriter.clear).not.toHaveBeenCalled();
    expect(vrrpWriter.set).not.toHaveBeenCalled();
  });

  it('updatePrefix: passes vrfChanged=true to the guard when the VRF actually moves', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrfId: null }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ vrfId: 'vrf-b' }));

    await service.updatePrefix(PREFIX_ID, { vrfId: 'vrf-b' });

    expect(repo.updateWithConflictGuard.mock.calls[0][2]).toBe(true);
  });

  it('updatePrefix: passes vrfChanged=false to the guard when the VRF is unchanged', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrfId: 'vrf-a' }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ vrfId: 'vrf-a', status: 'RESERVED' }));

    await service.updatePrefix(PREFIX_ID, { status: 'RESERVED' });

    expect(repo.updateWithConflictGuard.mock.calls[0][2]).toBe(false);
  });

  it('createPrefix: validates the prefix role (ensurePrefixRole) when prefixRoleId is set', async () => {
    const ROLE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await service.createPrefix({
      prefix: '10.0.1.0/24',
      status: 'ACTIVE',
      isPool: false,
      role: null,
      zoneId: null,
      vrfId: null,
      prefixRoleId: ROLE_ID,
      enableVlanTag: false,
      bondParameters: null,
    });
    expect(repo.ensurePrefixRole).toHaveBeenCalledTimes(1);
    expect(repo.ensurePrefixRole.mock.calls[0][0].state.prefixRoleId).toBe(ROLE_ID);
  });

  it('updatePrefix: validates the prefix role (ensurePrefixRole) when prefixRoleId changes', async () => {
    const ROLE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    repo.restore.mockResolvedValue(makePrefix({ prefixRoleId: null }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ prefixRoleId: ROLE_ID }));

    await service.updatePrefix(PREFIX_ID, { prefixRoleId: ROLE_ID });

    expect(repo.ensurePrefixRole).toHaveBeenCalledTimes(1);
    expect(repo.ensurePrefixRole.mock.calls[0][0].state.prefixRoleId).toBe(ROLE_ID);
  });

  it('set: rejects when the prefix zone is soft-deleted (no save, no publish)', async () => {
    repo.restore.mockResolvedValue(makePrefix());
    repo.requireLiveZone.mockRejectedValue(new NotFoundException('Zone not found'));

    await expect(service.setPrefixVrrpVip(PREFIX_ID, VIP_ID, BINDINGS)).rejects.toThrow(NotFoundException);
    expect(repo.updateWithConflictGuard).not.toHaveBeenCalled();
    expect(vrrpWriter.set).not.toHaveBeenCalled();
  });

  it('archive: clears the per-bridge bindings in-tx and withdraws the VIP atom post-commit', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID, zoneId: ZONE_ID }));

    await service.archivePrefix(PREFIX_ID);

    expect(repo.persistUnderLock).toHaveBeenCalled();
    expect(repo.replacePrefixVrrpBindings).toHaveBeenCalledWith(PREFIX_ID, [], expect.anything());
    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
  });

  it('archive: no atom teardown when the prefix carries no VIP', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: null, zoneId: ZONE_ID }));

    await service.archivePrefix(PREFIX_ID);

    expect(repo.persistUnderLock).toHaveBeenCalled();
    expect(vrrpWriter.clear).not.toHaveBeenCalled();
  });

  it('archive: tears down under the COMMITTED zone from the archived row (concurrent-relocation guard)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: VIP_ID, zoneId: ZONE_ID }));
    repo.persistUnderLock.mockImplementationOnce(async (entity, before, teardown) => {
      const archived = makePrefix({ vrrpVipId: VIP_ID, zoneId: NEW_ZONE_ID });
      if (teardown) await teardown(archived, {} as never);
      return archived;
    });

    await service.archivePrefix(PREFIX_ID);

    expect(vrrpWriter.clear).toHaveBeenCalledWith(NEW_ZONE_ID, PREFIX_ID);
    expect(vrrpWriter.clear).not.toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
  });

  it('archive: tears down a VIP committed by a concurrent assign after the pre-lock snapshot', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrrpVipId: null, zoneId: ZONE_ID }));
    repo.persistUnderLock.mockImplementationOnce(async (entity, before, teardown) => {
      const archived = makePrefix({ vrrpVipId: VIP_ID, zoneId: ZONE_ID });
      if (teardown) await teardown(archived, {} as never);
      return archived;
    });

    await service.archivePrefix(PREFIX_ID);

    expect(vrrpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
  });

  it('updatePrefix zone change relocates the DHCP atom (publish new zone first, then withdraw old)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ zoneId: NEW_ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(true);

    await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID } as never);

    expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
    expect(dhcpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
    expect(dhcpPublisher.republishOne.mock.invocationCallOrder[0]).toBeLessThan(
      dhcpWriter.clear.mock.invocationCallOrder[0],
    );
  });

  it('updatePrefix zone change: skips old-zone DHCP clear when republishOne returns false (preserves old atom)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ zoneId: NEW_ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(false);

    await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID } as never);

    expect(dhcpWriter.clear).not.toHaveBeenCalled();
  });

  it('updatePrefix zone change: skips old-zone DHCP clear when republishOne rejects', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ zoneId: NEW_ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(false);

    await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID } as never);

    expect(dhcpWriter.clear).not.toHaveBeenCalled();
  });

  it('updatePrefix zone change: clears old-zone DHCP atom when republishOne returns true (disabled — prefix not DHCP-eligible)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ zoneId: NEW_ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(true);

    await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID } as never);

    expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
    expect(dhcpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
  });

  it('updatePrefix zone unassign (newZoneId null) clears old DHCP atom even without a publish', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    repo.updateWithConflictGuard.mockResolvedValue(makePrefix({ zoneId: null }));

    await service.updatePrefix(PREFIX_ID, { zoneId: null } as never);

    expect(dhcpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
  });

  it('updatePrefix: rejects clearing the zone while DHCP is enabled (would strand the prefix)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    repo.getDhcpConfig.mockResolvedValue({ dhcpMode: 'AUTHORITATIVE' });

    await expect(service.updatePrefix(PREFIX_ID, { zoneId: null } as never)).rejects.toThrow(BadRequestException);
    expect(repo.updateWithConflictGuard).not.toHaveBeenCalled();
    expect(dhcpWriter.clear).not.toHaveBeenCalled();
  });

  it('archivePrefix clears the DHCP atom too (mirrors the VRRP teardown)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));

    await service.archivePrefix(PREFIX_ID);

    expect(dhcpWriter.clear).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
  });

  it('archivePrefix clears the DNS prefix-override atom', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));

    await service.archivePrefix(PREFIX_ID);

    expect(dnsPublisher.clearPrefixDnsOverride).toHaveBeenCalledWith(ZONE_ID, PREFIX_ID);
  });

  it('archivePrefix logs warning when DNS override clear fails', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    dnsPublisher.clearPrefixDnsOverride.mockRejectedValueOnce(new Error('redis down'));

    await service.archivePrefix(PREFIX_ID);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DNS prefix-override atom clear'));
  });

  it('setPrefixGateway republishes the DHCP atom (gateway feeds routers)', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(true);

    await service.setPrefixGateway(PREFIX_ID, 'gateway-ip-id');

    expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
  });

  it('clearPrefixGateway republishes the DHCP atom', async () => {
    repo.restore.mockResolvedValue(makePrefix({ zoneId: ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(true);

    await service.clearPrefixGateway(PREFIX_ID);

    expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
  });

  it('updatePrefix: role change (no zone change) republishes DHCP atom', async () => {
    repo.restore.mockResolvedValue(makePrefix({ role: 'COMMON', zoneId: ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(true);

    await service.updatePrefix(PREFIX_ID, { role: 'MANAGEMENT' } as never);

    expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
  });

  it('updatePrefix: vrfId change (no zone change) republishes DHCP atom', async () => {
    repo.restore.mockResolvedValue(makePrefix({ vrfId: null, zoneId: ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(true);

    await service.updatePrefix(PREFIX_ID, { vrfId: 'vrf-new' } as never);

    expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
  });

  it('updatePrefix: gatewayIpId change (no zone change) republishes DHCP atom', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: null, zoneId: ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(true);

    await service.updatePrefix(PREFIX_ID, { gatewayIpId: 'gw-ip-1' } as never);

    expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
  });

  it('updatePrefix: role change to ineligible delegates to publisher', async () => {
    repo.restore.mockResolvedValue(makePrefix({ role: 'COMMON', zoneId: ZONE_ID }));
    dhcpPublisher.republishOne.mockResolvedValue(true);

    await service.updatePrefix(PREFIX_ID, { role: 'NAT' } as never);

    expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
  });
});
