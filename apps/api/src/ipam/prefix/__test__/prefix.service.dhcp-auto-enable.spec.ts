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

describe('PrefixService DHCP auto-enable on PRIMARY/MANAGEMENT role', () => {
  const repo = {
    restore: vi.fn(),
    normalizePrefix: vi.fn(),
    ensureVrf: vi.fn(),
    ensureZone: vi.fn(),
    ensurePrefixRole: vi.fn(),
    ensureGateway: vi.fn(),
    getDhcpConfig: vi.fn(),
    getDnsOverride: vi.fn(),
    createWithConflictGuard: vi.fn(),
    updateWithConflictGuard: vi.fn(),
    persistUnderLock: vi.fn(),
    replacePrefixVrrpBindings: vi.fn(),
    syncGatewayRecordOnSet: vi.fn(),
    syncGatewayRecordOnClear: vi.fn(),
    autoEnableAuthoritativeDhcp: vi.fn(),
    updateDhcpConfig: vi.fn(),
    updateDhcpConfigUnderZoneLock: vi.fn(),
  };
  const contextService = {
    requirePermission: vi.fn(),
    organizationId: 'org-1',
    buildAuditPayload: vi.fn().mockReturnValue({
      triggeredBy: 'user-1',
      triggeredByEmail: 'op@example.com',
      organizationId: 'org-1',
    }),
  };
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
    contextService.buildAuditPayload.mockReturnValue({
      triggeredBy: 'user-1',
      triggeredByEmail: 'op@example.com',
      organizationId: 'org-1',
    });
    repo.normalizePrefix.mockImplementation(async (prefix: string) => prefix);
    repo.ensureVrf.mockResolvedValue(undefined);
    repo.ensureZone.mockResolvedValue(undefined);
    repo.ensurePrefixRole.mockResolvedValue(undefined);
    repo.getDhcpConfig.mockResolvedValue({ dhcpMode: null });
    repo.getDnsOverride.mockResolvedValue({ serveDns: null, upstreamOverride: [] });
    repo.createWithConflictGuard.mockImplementation(async (entity) => ({
      ...(entity.state as IpamPrefix),
      id: PREFIX_ID,
    }));
    repo.updateWithConflictGuard.mockImplementation(async (entity, _before, _vrfChanged, afterSave) => {
      const row = entity.state as IpamPrefix;
      if (afterSave) await afterSave(row, FAKE_TX);
      return row;
    });
    repo.autoEnableAuthoritativeDhcp.mockResolvedValue('enabled');
    dhcpPublisher.republishOne.mockResolvedValue(true);
    dhcpWriter.clear.mockResolvedValue(undefined);
    dnsPublisher.publishPrefixDnsOverride.mockResolvedValue(true);
    dnsPublisher.clearPrefixDnsOverride.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('createPrefix', () => {
    it('auto-enables authoritative DHCP on a zoned PRIMARY-role create and publishes the atom', async () => {
      const created = await service.createPrefix({ prefix: '10.0.1.0/24', role: 'PRIMARY', zoneId: ZONE_ID });

      expect(repo.autoEnableAuthoritativeDhcp).toHaveBeenCalledWith(PREFIX_ID, ZONE_ID);
      expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('DHCP auto-enabled (AUTHORITATIVE)'));
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('ACTIVE IP range'));
      expect(created.role).toBe('PRIMARY');
    });

    it('auto-enables on a zoned MANAGEMENT-role create', async () => {
      await service.createPrefix({ prefix: '10.0.2.0/24', role: 'MANAGEMENT', zoneId: ZONE_ID });

      expect(repo.autoEnableAuthoritativeDhcp).toHaveBeenCalledWith(PREFIX_ID, ZONE_ID);
    });

    it('does not auto-enable on a non-qualifying role', async () => {
      await service.createPrefix({ prefix: '10.0.3.0/24', role: 'COMMON', zoneId: ZONE_ID });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
      expect(dhcpPublisher.republishOne).not.toHaveBeenCalled();
    });

    it('skips a zoneless PRIMARY-role create and logs the deferral', async () => {
      await service.createPrefix({ prefix: '10.0.4.0/24', role: 'PRIMARY' });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
      expect(dhcpPublisher.republishOne).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('DHCP auto-enable deferred'));
    });

    it('skips a non-IPv4 PRIMARY-role create', async () => {
      await service.createPrefix({ prefix: '2001:db8::/64', role: 'PRIMARY', zoneId: ZONE_ID });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
    });

    it('does not fail the create when auto-enable errors (logged outcome)', async () => {
      repo.autoEnableAuthoritativeDhcp.mockRejectedValue(new Error('zone lock timeout'));

      const created = await service.createPrefix({ prefix: '10.0.5.0/24', role: 'PRIMARY', zoneId: ZONE_ID });

      expect(created.id).toBe(PREFIX_ID);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DHCP auto-enable failed'));
      expect(dhcpPublisher.republishOne).not.toHaveBeenCalled();
    });
  });

  describe('updatePrefix role transition', () => {
    it('auto-enables when the role transitions to PRIMARY on a zoned prefix and publishes the atom', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'COMMON' }));

      await service.updatePrefix(PREFIX_ID, { role: 'PRIMARY' });

      expect(repo.autoEnableAuthoritativeDhcp).toHaveBeenCalledWith(PREFIX_ID, ZONE_ID);
      expect(dhcpPublisher.republishOne).toHaveBeenCalledWith(PREFIX_ID, expect.any(Function));
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('DHCP auto-enabled (AUTHORITATIVE)'));
    });

    it('auto-enables when the role transitions from unset to MANAGEMENT', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: null }));

      await service.updatePrefix(PREFIX_ID, { role: 'MANAGEMENT' });

      expect(repo.autoEnableAuthoritativeDhcp).toHaveBeenCalledWith(PREFIX_ID, ZONE_ID);
    });

    it('does not auto-enable when the role is written unchanged (no transition)', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'PRIMARY' }));

      await service.updatePrefix(PREFIX_ID, { role: 'PRIMARY' });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
    });

    it('does not auto-enable on a transition to a non-qualifying role', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'COMMON' }));

      await service.updatePrefix(PREFIX_ID, { role: 'ALLOCATION' });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
    });

    it('never auto-reverts when the role transitions away from PRIMARY', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'PRIMARY' }));

      await service.updatePrefix(PREFIX_ID, { role: 'COMMON' });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
      expect(repo.updateDhcpConfig).not.toHaveBeenCalled();
      expect(repo.updateDhcpConfigUnderZoneLock).not.toHaveBeenCalled();
    });

    it('defers a role transition on a zoneless prefix', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: null, zoneId: null }));

      await service.updatePrefix(PREFIX_ID, { role: 'PRIMARY' });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('DHCP auto-enable deferred'));
    });

    it('preserves an operator-set dhcpMode (repo reports already-configured; no auto-enable log)', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'COMMON' }));
      repo.autoEnableAuthoritativeDhcp.mockResolvedValue('already-configured');

      await service.updatePrefix(PREFIX_ID, { role: 'PRIMARY' });

      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('DHCP auto-enabled'));
      expect(repo.updateDhcpConfig).not.toHaveBeenCalled();
      expect(repo.updateDhcpConfigUnderZoneLock).not.toHaveBeenCalled();
    });

    it('warns on an ineligible outcome without failing the update', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'COMMON' }));
      repo.autoEnableAuthoritativeDhcp.mockResolvedValue('ineligible');

      const updated = await service.updatePrefix(PREFIX_ID, { role: 'PRIMARY' });

      expect(updated.role).toBe('PRIMARY');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DHCP auto-enable skipped'));
    });

    it('does not fail the update when auto-enable errors (logged outcome)', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'COMMON' }));
      repo.autoEnableAuthoritativeDhcp.mockRejectedValue(new Error('db down'));

      const updated = await service.updatePrefix(PREFIX_ID, { role: 'PRIMARY' });

      expect(updated.role).toBe('PRIMARY');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DHCP auto-enable failed'));
    });
  });

  describe('updatePrefix zone assignment', () => {
    it('auto-enables on zone assignment when the role already qualifies', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'MANAGEMENT', zoneId: null }));

      await service.updatePrefix(PREFIX_ID, { zoneId: ZONE_ID });

      expect(repo.autoEnableAuthoritativeDhcp).toHaveBeenCalledWith(PREFIX_ID, ZONE_ID);
    });

    it('auto-enables when role and zone are assigned in the same update', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: null, zoneId: null }));

      await service.updatePrefix(PREFIX_ID, { role: 'PRIMARY', zoneId: ZONE_ID });

      expect(repo.autoEnableAuthoritativeDhcp).toHaveBeenCalledWith(PREFIX_ID, ZONE_ID);
    });

    it('does not auto-enable on zone assignment when the role does not qualify', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'COMMON', zoneId: null }));

      await service.updatePrefix(PREFIX_ID, { zoneId: ZONE_ID });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
    });

    it('does not auto-enable on a zone-to-zone move', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'PRIMARY', zoneId: ZONE_ID }));

      await service.updatePrefix(PREFIX_ID, { zoneId: NEW_ZONE_ID });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
    });

    it('does not auto-enable when the zone is cleared', async () => {
      repo.restore.mockResolvedValue(makePrefix({ role: 'PRIMARY', zoneId: ZONE_ID }));

      await service.updatePrefix(PREFIX_ID, { zoneId: null });

      expect(repo.autoEnableAuthoritativeDhcp).not.toHaveBeenCalled();
    });
  });
});
