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
const OLD_GW = 'gw-ip-old';
const NEW_GW = 'gw-ip-new';
const VRF_ID = 'vrf-1';
const FAKE_TX = { queryRaw: vi.fn(), executeRaw: vi.fn(), createChangelog: vi.fn() };

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

describe('PrefixService gateway record sync', () => {
  const repo = {
    restore: vi.fn(),
    ensureVrf: vi.fn(),
    ensureZone: vi.fn(),
    ensurePrefixRole: vi.fn(),
    ensureGateway: vi.fn(),
    getDhcpConfig: vi.fn(),
    getDnsOverride: vi.fn(),
    updateWithConflictGuard: vi.fn(),
    persistUnderLock: vi.fn(),
    save: vi.fn(),
    replacePrefixVrrpBindings: vi.fn(),
    syncGatewayRecordOnSet: vi.fn(),
    syncGatewayRecordOnClear: vi.fn(),
  };
  const contextService = { requirePermission: vi.fn(), organizationId: 'org-1' };
  const vrrpWriter = { set: vi.fn(), clear: vi.fn() };
  const dhcpWriter = { set: vi.fn(), clear: vi.fn() };
  const dhcpPublisher = { republishOne: vi.fn() };
  const dhcpLeaseReader = { listLeasesForPrefix: vi.fn() };
  const dhcpDerivation = { listReservationsForPrefix: vi.fn() };
  const dnsPublisher = {
    publishPrefixDnsOverride: vi.fn(),
    clearPrefixDnsOverride: vi.fn(),
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
    repo.ensureVrf.mockResolvedValue(undefined);
    repo.ensureZone.mockResolvedValue(undefined);
    repo.ensurePrefixRole.mockResolvedValue(undefined);
    repo.getDhcpConfig.mockResolvedValue({ dhcpMode: null });
    repo.getDnsOverride.mockResolvedValue({ serveDns: null, upstreamOverride: [] });
    repo.updateWithConflictGuard.mockImplementation(async (entity, _before, _vrfChanged, afterSave) => {
      const row = entity.state as IpamPrefix;
      if (afterSave) await afterSave(row, FAKE_TX);
      return row;
    });
    repo.persistUnderLock.mockImplementation(async (entity, _before, afterSave) => {
      const row = entity.state as IpamPrefix;
      if (afterSave) await afterSave(row, FAKE_TX);
      return row;
    });
    repo.syncGatewayRecordOnSet.mockResolvedValue({ action: 'created', customRowPreserved: false });
    repo.syncGatewayRecordOnClear.mockResolvedValue({ action: 'removed', customRowPreserved: false });
    dhcpPublisher.republishOne.mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('setPrefixGateway upserts the Gateway record in the prefix-update tx', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: null }));

    await service.setPrefixGateway(PREFIX_ID, NEW_GW);

    expect(repo.updateWithConflictGuard).toHaveBeenCalledTimes(1);
    expect(repo.syncGatewayRecordOnSet).toHaveBeenCalledWith(PREFIX_ID, NEW_GW, null, null, FAKE_TX);
    expect(repo.syncGatewayRecordOnClear).not.toHaveBeenCalled();
  });

  it('setPrefixGateway on change passes the previous gateway ip and the prefix vrf', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: OLD_GW, vrfId: VRF_ID }));

    await service.setPrefixGateway(PREFIX_ID, NEW_GW);

    expect(repo.syncGatewayRecordOnSet).toHaveBeenCalledWith(PREFIX_ID, NEW_GW, OLD_GW, VRF_ID, FAKE_TX);
  });

  it('clearPrefixGateway removes the auto-managed Gateway record in the same tx', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: OLD_GW }));

    await service.clearPrefixGateway(PREFIX_ID);

    expect(repo.persistUnderLock).toHaveBeenCalledTimes(1);
    expect(repo.syncGatewayRecordOnClear).toHaveBeenCalledWith(PREFIX_ID, OLD_GW, FAKE_TX);
    expect(repo.syncGatewayRecordOnSet).not.toHaveBeenCalled();
  });

  it('updatePrefix with a new gatewayIpId syncs the Gateway record', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: null }));

    await service.updatePrefix(PREFIX_ID, { gatewayIpId: NEW_GW } as never);

    expect(repo.syncGatewayRecordOnSet).toHaveBeenCalledWith(PREFIX_ID, NEW_GW, null, null, FAKE_TX);
  });

  it('updatePrefix changing the gatewayIpId passes the previous value', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: OLD_GW }));

    await service.updatePrefix(PREFIX_ID, { gatewayIpId: NEW_GW } as never);

    expect(repo.syncGatewayRecordOnSet).toHaveBeenCalledWith(PREFIX_ID, NEW_GW, OLD_GW, null, FAKE_TX);
  });

  it('updatePrefix clearing the gatewayIpId removes the auto-managed record', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: OLD_GW }));

    await service.updatePrefix(PREFIX_ID, { gatewayIpId: null } as never);

    expect(repo.syncGatewayRecordOnClear).toHaveBeenCalledWith(PREFIX_ID, OLD_GW, FAKE_TX);
    expect(repo.syncGatewayRecordOnSet).not.toHaveBeenCalled();
  });

  it('updatePrefix with an unchanged gatewayIpId does not sync', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: OLD_GW }));

    await service.updatePrefix(PREFIX_ID, { gatewayIpId: OLD_GW } as never);

    expect(repo.syncGatewayRecordOnSet).not.toHaveBeenCalled();
    expect(repo.syncGatewayRecordOnClear).not.toHaveBeenCalled();
  });

  it('updatePrefix without gatewayIpId in the input does not sync', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: OLD_GW }));

    await service.updatePrefix(PREFIX_ID, { status: 'RESERVED' } as never);

    expect(repo.syncGatewayRecordOnSet).not.toHaveBeenCalled();
    expect(repo.syncGatewayRecordOnClear).not.toHaveBeenCalled();
  });

  it('setPrefixGateway logs when an operator-customized row is preserved', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: OLD_GW }));
    repo.syncGatewayRecordOnSet.mockResolvedValue({ action: 'created', customRowPreserved: true });

    await service.setPrefixGateway(PREFIX_ID, NEW_GW);

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('operator-customized'));
  });

  it('clearPrefixGateway logs when an operator-customized row is preserved', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: OLD_GW }));
    repo.syncGatewayRecordOnClear.mockResolvedValue({ action: 'noop', customRowPreserved: true });

    await service.clearPrefixGateway(PREFIX_ID);

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('operator-customized'));
  });

  it('setPrefixGateway does not log preservation on a clean sync', async () => {
    repo.restore.mockResolvedValue(makePrefix({ gatewayIpId: null }));

    await service.setPrefixGateway(PREFIX_ID, NEW_GW);

    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('operator-customized'));
  });
});
