import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrefixDhcpConfig, UpdatePrefixDhcpConfig } from '@repo/api-client';
import type { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import type { DhcpConfigRedisWriterService } from 'src/brokkr-bridge/dhcp/dhcp-config-redis-writer.service';
import type { DhcpDerivationService } from 'src/brokkr-bridge/dhcp/dhcp-derivation.service';
import type { DhcpLeaseReaderService } from 'src/brokkr-bridge/dhcp/dhcp-lease-reader.service';
import type { DnsConfigPublisherService } from 'src/brokkr-bridge/dns/dns-config-publisher.service';
import type { VrrpRedisWriterService } from 'src/brokkr-bridge/vrrp/vrrp-redis-writer.service';
import type { ContextService } from 'src/common/context/context.service';
import type { LoggerService } from 'src/logger/logger.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrefixRepository } from '../prefix.repository';
import { PrefixService } from '../prefix.service';

const STORED_CONFIG: PrefixDhcpConfig = {
  dhcpMode: 'AUTHORITATIVE',
  dhcpLeaseTtlSeconds: 7200,
  ipxeBuildTarget: 'IPXE',
  dhcpOptions: [{ code: 12, value: 'myhost' }],
  dhcpProxyAllowedMacs: [],
  dhcpProxyPeerAuthoritative: false,
  dhcpRelayAgentIp: null,
};

describe('PrefixService DHCP config', () => {
  const repo = {
    getDhcpConfig: vi.fn(),
    updateDhcpConfig: vi.fn(),
    updateDhcpConfigUnderZoneLock: vi.fn(),
    restore: vi.fn(),
    requireLiveZone: vi.fn().mockResolvedValue(undefined),
    getAssociatedPrefixId: vi.fn().mockResolvedValue(null),
    loadDhcpServingAddresses: vi.fn().mockResolvedValue({ vipAddress: null, bridgeIps: [] }),
  };
  const contextService = { requirePermission: vi.fn(), organizationId: 'org-1' };
  const vrrpWriter = { set: vi.fn(), clear: vi.fn() };
  const dhcpWriter = { set: vi.fn(), clear: vi.fn() };
  const dhcpPublisher = { republishOne: vi.fn() };
  const dhcpLeaseReader = { listLeasesForPrefix: vi.fn().mockResolvedValue([]) };
  const dhcpDerivation = { listReservationsForPrefix: vi.fn().mockResolvedValue([]) };
  const dnsConfigPublisher = {
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
    dnsConfigPublisher as unknown as DnsConfigPublisherService,
    logger as unknown as LoggerService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    contextService.requirePermission.mockImplementation(() => undefined);
    repo.getDhcpConfig.mockResolvedValue(STORED_CONFIG);
    const dhcpConfigFromInput = async (_id: string, _zoneIdOrInput: unknown, maybeInput?: UpdatePrefixDhcpConfig) => {
      const input = maybeInput ?? (_zoneIdOrInput as UpdatePrefixDhcpConfig);
      return {
        dhcpMode: input.dhcpMode,
        dhcpLeaseTtlSeconds: input.dhcpLeaseTtlSeconds,
        ipxeBuildTarget: input.ipxeBuildTarget,
        dhcpOptions: input.dhcpOptions,
        dhcpProxyAllowedMacs: input.dhcpProxyAllowedMacs,
        dhcpRelayAgentIp: input.dhcpRelayAgentIp,
      };
    };
    repo.updateDhcpConfig.mockImplementation(dhcpConfigFromInput);
    repo.updateDhcpConfigUnderZoneLock.mockImplementation(dhcpConfigFromInput);
    dhcpPublisher.republishOne.mockResolvedValue(true);
    repo.restore.mockResolvedValue({
      zoneId: 'zone-1',
      prefix: '10.0.1.0/24',
      role: 'COMMON',
      status: 'ACTIVE',
      vrrpVipId: null,
      organizationId: 'org-1',
      vrfId: null,
    });
    repo.loadDhcpServingAddresses.mockResolvedValue({ vipAddress: null, bridgeIps: [] });
  });

  describe('getDhcpConfig', () => {
    it('returns the stored DHCP config', async () => {
      const result = await service.getDhcpConfig('prefix-1');
      expect(result).toEqual(STORED_CONFIG);
      expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'read');
    });

    it('propagates NotFoundException from repo', async () => {
      repo.getDhcpConfig.mockRejectedValue(new NotFoundException('Prefix not found'));
      await expect(service.getDhcpConfig('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateDhcpConfig', () => {
    const validInput: UpdatePrefixDhcpConfig = {
      dhcpMode: 'AUTHORITATIVE',
      dhcpLeaseTtlSeconds: 3600,
      ipxeBuildTarget: 'SNP',
      dhcpOptions: [{ code: 12, value: 'myhost' }],
      dhcpProxyAllowedMacs: [],
      dhcpProxyPeerAuthoritative: false,
      dhcpRelayAgentIp: null,
    };

    it('updates and returns the new config', async () => {
      const result = await service.updateDhcpConfig('prefix-1', validInput);
      expect(result.dhcpMode).toBe('AUTHORITATIVE');
      expect(result.ipxeBuildTarget).toBe('SNP');
      expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'update');
    });

    it('delegates to the publisher after a successful update', async () => {
      await service.updateDhcpConfig('prefix-1', validInput);
      expect(dhcpPublisher.republishOne).toHaveBeenCalledWith('prefix-1', expect.any(Function));
    });

    it('leaves the atom untouched on a publisher error (non-throwing)', async () => {
      dhcpPublisher.republishOne.mockResolvedValue(false);
      await service.updateDhcpConfig('prefix-1', validInput);
      expect(dhcpPublisher.republishOne).toHaveBeenCalledWith('prefix-1', expect.any(Function));
    });

    it('rejects enabling DHCP on a zoneless prefix (atoms are per-zone; it would never serve)', async () => {
      repo.restore.mockResolvedValue({ zoneId: null });
      await expect(service.updateDhcpConfig('prefix-1', validInput)).rejects.toThrow(BadRequestException);
      expect(repo.updateDhcpConfig).not.toHaveBeenCalled();
      expect(dhcpPublisher.republishOne).not.toHaveBeenCalled();
    });

    it('allows disabling DHCP (mode OFF) on a zoneless prefix', async () => {
      repo.restore.mockResolvedValue({ zoneId: null });
      await service.updateDhcpConfig('prefix-1', { ...validInput, dhcpMode: 'OFF' });
      expect(repo.updateDhcpConfig).toHaveBeenCalled();
      expect(repo.updateDhcpConfigUnderZoneLock).not.toHaveBeenCalled();
    });

    it('serializes a zoned DHCP update via the advisory-locked path (closes deleteZone TOCTOU)', async () => {
      await service.updateDhcpConfig('prefix-1', validInput);
      expect(repo.updateDhcpConfigUnderZoneLock).toHaveBeenCalledWith('prefix-1', 'zone-1', validInput);
      expect(repo.updateDhcpConfig).not.toHaveBeenCalled();
    });

    it('uses the plain (unlocked) path when the prefix has no zone', async () => {
      repo.restore.mockResolvedValue({ zoneId: null, prefix: '10.0.1.0/24', role: 'COMMON' });
      const offInput = { ...validInput, dhcpMode: 'OFF' as const };
      await service.updateDhcpConfig('prefix-1', offInput);
      expect(repo.updateDhcpConfig).toHaveBeenCalledWith('prefix-1', offInput);
      expect(repo.updateDhcpConfigUnderZoneLock).not.toHaveBeenCalled();
    });

    it('rejects enabling DHCP on a NAT-role prefix (derivation excludes NAT; it would never serve)', async () => {
      repo.restore.mockResolvedValue({ zoneId: 'zone-1', prefix: '10.0.1.0/24', role: 'NAT' });
      await expect(service.updateDhcpConfig('prefix-1', validInput)).rejects.toThrow(BadRequestException);
      expect(repo.updateDhcpConfig).not.toHaveBeenCalled();
      expect(dhcpPublisher.republishOne).not.toHaveBeenCalled();
    });

    it('rejects enabling DHCP on a non-IPv4 prefix (derivation is IPv4-only)', async () => {
      repo.restore.mockResolvedValue({ zoneId: 'zone-1', prefix: '2001:db8::/64', role: 'COMMON' });
      await expect(service.updateDhcpConfig('prefix-1', validInput)).rejects.toThrow(BadRequestException);
      expect(repo.updateDhcpConfig).not.toHaveBeenCalled();
      expect(dhcpPublisher.republishOne).not.toHaveBeenCalled();
    });

    it('rejects enabling DHCP when the prefix points at a soft-deleted/missing zone', async () => {
      repo.restore.mockResolvedValue({ zoneId: 'zone-gone', prefix: '10.0.1.0/24', role: 'COMMON' });
      repo.requireLiveZone.mockRejectedValueOnce(new NotFoundException('Zone not found'));
      await expect(service.updateDhcpConfig('prefix-1', validInput)).rejects.toThrow(NotFoundException);
      expect(repo.requireLiveZone).toHaveBeenCalledWith('zone-gone');
      expect(repo.updateDhcpConfig).not.toHaveBeenCalled();
      expect(dhcpPublisher.republishOne).not.toHaveBeenCalled();
    });

    it('rejects an active relayed prefix without a DHCP relay agent IP', async () => {
      repo.getAssociatedPrefixId.mockResolvedValueOnce('associated-prefix-1');
      await expect(service.updateDhcpConfig('prefix-1', validInput)).rejects.toThrow(
        'An active relayed prefix requires a DHCP relay agent IP.',
      );
      expect(repo.updateDhcpConfigUnderZoneLock).not.toHaveBeenCalled();
    });

    it('accepts an active relayed prefix with a DHCP relay agent IP', async () => {
      repo.getAssociatedPrefixId.mockResolvedValueOnce('associated-prefix-1');
      const input = { ...validInput, dhcpRelayAgentIp: '10.0.1.254' };
      const result = await service.updateDhcpConfig('prefix-1', input);
      expect(result.dhcpRelayAgentIp).toBe('10.0.1.254');
    });

    it('rejects reserved option code 51 (lease time)', async () => {
      const input: UpdatePrefixDhcpConfig = {
        ...validInput,
        dhcpOptions: [{ code: 51, value: '3600' }],
      };
      const error = await service.updateDhcpConfig('prefix-1', input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).toMatchObject({ message: expect.stringMatching(/option 51/) });
    });

    it('rejects reserved option code 54 (server identifier)', async () => {
      const input: UpdatePrefixDhcpConfig = {
        ...validInput,
        dhcpOptions: [{ code: 54, value: '10.0.0.1' }],
      };
      await expect(service.updateDhcpConfig('prefix-1', input)).rejects.toThrow(BadRequestException);
    });

    it('rejects reserved option code 43 (vendor encap — bridge PXE-manages it)', async () => {
      const input: UpdatePrefixDhcpConfig = {
        ...validInput,
        dhcpOptions: [{ code: 43, value: 'aa:bb' }],
      };
      const error = await service.updateDhcpConfig('prefix-1', input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).toMatchObject({ message: expect.stringMatching(/option 43/) });
    });

    it('rejects reserved option code 60 (vendor class — bridge PXE-manages it)', async () => {
      const input: UpdatePrefixDhcpConfig = {
        ...validInput,
        dhcpOptions: [{ code: 60, value: 'PXEClient' }],
      };
      const error = await service.updateDhcpConfig('prefix-1', input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).toMatchObject({ message: expect.stringMatching(/option 60/) });
    });

    it('rejects reserved option code 1 (subnet mask)', async () => {
      const input: UpdatePrefixDhcpConfig = {
        ...validInput,
        dhcpOptions: [{ code: 1, value: '255.255.255.0' }],
      };
      await expect(service.updateDhcpConfig('prefix-1', input)).rejects.toThrow(BadRequestException);
    });

    it('rejects reserved option code 6 (DNS)', async () => {
      const input: UpdatePrefixDhcpConfig = {
        ...validInput,
        dhcpOptions: [{ code: 6, value: '8.8.8.8' }],
      };
      await expect(service.updateDhcpConfig('prefix-1', input)).rejects.toThrow(BadRequestException);
    });

    it('rejects reserved option code 3 (routers)', async () => {
      const input: UpdatePrefixDhcpConfig = {
        ...validInput,
        dhcpOptions: [{ code: 3, value: '10.0.0.1' }],
      };
      await expect(service.updateDhcpConfig('prefix-1', input)).rejects.toThrow(BadRequestException);
    });

    it('accepts non-reserved custom option codes', async () => {
      const input: UpdatePrefixDhcpConfig = {
        ...validInput,
        dhcpOptions: [
          { code: 12, value: 'myhost' },
          { code: 15, value: 'example.com' },
          { code: 150, value: '10.0.0.1' },
        ],
      };
      const result = await service.updateDhcpConfig('prefix-1', input);
      expect(result.dhcpOptions).toEqual(input.dhcpOptions);
    });

    it('does not publish the atom when the disable-path repo call throws (no stale-atom leak)', async () => {
      repo.restore.mockResolvedValue({ zoneId: 'zone-1', prefix: '10.0.1.0/24', role: 'COMMON' });
      repo.updateDhcpConfig.mockRejectedValueOnce(new Error('audit insert failed'));
      const offInput: UpdatePrefixDhcpConfig = {
        dhcpMode: 'OFF',
        dhcpLeaseTtlSeconds: null,
        ipxeBuildTarget: null,
        dhcpOptions: [],
        dhcpProxyAllowedMacs: [],
        dhcpProxyPeerAuthoritative: false,
        dhcpRelayAgentIp: null,
      };
      await expect(service.updateDhcpConfig('prefix-1', offInput)).rejects.toThrow('audit insert failed');
      expect(dhcpPublisher.republishOne).not.toHaveBeenCalled();
    });

    it('accepts null dhcpMode (disable DHCP) and uses the plain (unlocked) repo path', async () => {
      const input: UpdatePrefixDhcpConfig = {
        ...validInput,
        dhcpMode: null,
        dhcpLeaseTtlSeconds: null,
        ipxeBuildTarget: null,
        dhcpOptions: [],
      };
      const result = await service.updateDhcpConfig('prefix-1', input);
      expect(result.dhcpMode).toBeNull();
      expect(repo.updateDhcpConfig).toHaveBeenCalledWith('prefix-1', input);
      expect(repo.updateDhcpConfigUnderZoneLock).not.toHaveBeenCalled();
    });

    it('round-trips PROXY mode', async () => {
      const input: UpdatePrefixDhcpConfig = {
        dhcpMode: 'PROXY',
        dhcpLeaseTtlSeconds: null,
        ipxeBuildTarget: 'SNP',
        dhcpOptions: [],
        dhcpProxyAllowedMacs: [],
        dhcpProxyPeerAuthoritative: false,
        dhcpRelayAgentIp: null,
      };
      const result = await service.updateDhcpConfig('prefix-1', input);
      expect(result.dhcpMode).toBe('PROXY');
      expect(result.ipxeBuildTarget).toBe('SNP');
      expect(result.dhcpLeaseTtlSeconds).toBeNull();
    });

    it('round-trips OFF mode', async () => {
      const input: UpdatePrefixDhcpConfig = {
        dhcpMode: 'OFF',
        dhcpLeaseTtlSeconds: null,
        ipxeBuildTarget: null,
        dhcpOptions: [],
        dhcpProxyAllowedMacs: [],
        dhcpProxyPeerAuthoritative: false,
        dhcpRelayAgentIp: null,
      };
      const result = await service.updateDhcpConfig('prefix-1', input);
      expect(result.dhcpMode).toBe('OFF');
      expect(result.ipxeBuildTarget).toBeNull();
    });

    it('round-trips dhcpProxyAllowedMacs', async () => {
      const input: UpdatePrefixDhcpConfig = {
        dhcpMode: 'PROXY',
        dhcpLeaseTtlSeconds: null,
        ipxeBuildTarget: 'SNP',
        dhcpOptions: [],
        dhcpProxyAllowedMacs: ['aa:bb:cc:dd:ee:01', '11:22:33:44:55:66'],
        dhcpProxyPeerAuthoritative: false,
        dhcpRelayAgentIp: null,
      };
      const result = await service.updateDhcpConfig('prefix-1', input);
      expect(result.dhcpProxyAllowedMacs).toEqual(['aa:bb:cc:dd:ee:01', '11:22:33:44:55:66']);
    });
  });

  describe('getDhcpLeases', () => {
    it('returns [] for a zoneless prefix without touching the lease store', async () => {
      repo.restore.mockResolvedValue({ zoneId: null });
      const result = await service.getDhcpLeases('prefix-1');
      expect(result).toEqual([]);
      expect(dhcpLeaseReader.listLeasesForPrefix).not.toHaveBeenCalled();
    });

    it('delegates to the lease reader with the prefix zone + CIDR', async () => {
      repo.restore.mockResolvedValue({ zoneId: 'zone-1', prefix: '10.0.1.0/24' });
      const leases = [{ ip: '10.0.1.5', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'host', expiresAt: 123 }];
      dhcpLeaseReader.listLeasesForPrefix.mockResolvedValue(leases);
      const result = await service.getDhcpLeases('prefix-1');
      expect(dhcpLeaseReader.listLeasesForPrefix).toHaveBeenCalledWith('zone-1', '10.0.1.0/24');
      expect(result).toEqual(leases);
    });
  });

  describe('getDhcpReservations', () => {
    it('404s a missing prefix (via restore) before deriving', async () => {
      repo.restore.mockRejectedValue(new NotFoundException('Prefix not found'));
      await expect(service.getDhcpReservations('missing')).rejects.toThrow(NotFoundException);
      expect(dhcpDerivation.listReservationsForPrefix).not.toHaveBeenCalled();
    });

    it('delegates to the derivation service for an existing prefix (no zone gate — pure IPAM derivation)', async () => {
      repo.restore.mockResolvedValue({ zoneId: null });
      const reservations = [
        {
          mac: 'aa:bb:cc:dd:ee:01',
          ip: '10.0.1.50',
          hostname: 'gpu-1',
          ipxeBuildTarget: null,
          deviceId: 'd',
          interfaceId: 'i',
        },
      ];
      dhcpDerivation.listReservationsForPrefix.mockResolvedValue(reservations);
      const result = await service.getDhcpReservations('prefix-1');
      expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'read');
      expect(dhcpDerivation.listReservationsForPrefix).toHaveBeenCalledWith('prefix-1', 'org-1');
      expect(result).toEqual(reservations);
    });
  });

  describe('getDhcpServing', () => {
    it('returns VIP as nextServer and dnsServers when the prefix has a VRRP VIP', async () => {
      repo.restore.mockResolvedValue({
        zoneId: 'zone-1',
        prefix: '10.0.1.0/24',
        role: 'PRIMARY',
        vrrpVipId: 'vip-ip-id',
        organizationId: 'org-1',
        vrfId: null,
      });
      repo.loadDhcpServingAddresses.mockResolvedValue({ vipAddress: '10.0.1.1', bridgeIps: [] });

      const result = await service.getDhcpServing('prefix-1');

      expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'read');
      expect(repo.loadDhcpServingAddresses).toHaveBeenCalledWith({
        vrrpVipId: 'vip-ip-id',
        zoneId: 'zone-1',
        vrfId: null,
        cidr: '10.0.1.0/24',
      });
      expect(result).toEqual({ nextServer: '10.0.1.1', dnsServers: ['10.0.1.1'] });
    });

    it('returns bridge NIC IPs when no VIP is set — first as nextServer, all as dnsServers', async () => {
      repo.loadDhcpServingAddresses.mockResolvedValue({
        vipAddress: null,
        bridgeIps: ['10.0.1.10', '10.0.1.11'],
      });

      const result = await service.getDhcpServing('prefix-1');

      expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'read');
      expect(result).toEqual({ nextServer: '10.0.1.10', dnsServers: ['10.0.1.10', '10.0.1.11'] });
    });

    it('falls through to bridge NIC serving when the VIP is stale (vrrpVipId set but repo resolves no VIP)', async () => {
      repo.restore.mockResolvedValue({
        zoneId: 'zone-1',
        prefix: '10.0.1.0/24',
        role: 'PRIMARY',
        vrrpVipId: 'stale-vip-id',
        organizationId: 'org-1',
        vrfId: null,
      });
      repo.loadDhcpServingAddresses.mockResolvedValue({ vipAddress: null, bridgeIps: ['10.0.1.10'] });

      const result = await service.getDhcpServing('prefix-1');

      expect(repo.loadDhcpServingAddresses).toHaveBeenCalledWith(
        expect.objectContaining({ vrrpVipId: 'stale-vip-id', cidr: '10.0.1.0/24' }),
      );
      expect(result).toEqual({ nextServer: '10.0.1.10', dnsServers: ['10.0.1.10'] });
    });

    it('returns null nextServer and empty dnsServers when no VIP and no bridge IPs', async () => {
      repo.loadDhcpServingAddresses.mockResolvedValue({ vipAddress: null, bridgeIps: [] });

      const result = await service.getDhcpServing('prefix-1');

      expect(contextService.requirePermission).toHaveBeenCalledWith('ipam', 'read');
      expect(result).toEqual({ nextServer: null, dnsServers: [] });
    });

    it('truncates dnsServers to the DHCP option-6 limit (63) when many bridge NICs exist', async () => {
      const manyIps = Array.from({ length: 70 }, (_, i) => `10.0.1.${i + 1}`);
      repo.loadDhcpServingAddresses.mockResolvedValue({ vipAddress: null, bridgeIps: manyIps });

      const result = await service.getDhcpServing('prefix-1');

      expect(result.nextServer).toBe('10.0.1.1');
      expect(result.dnsServers).toHaveLength(63);
      expect(result.dnsServers).toEqual(manyIps.slice(0, 63));
    });

    it('404s a missing prefix (via restore) before resolving', async () => {
      repo.restore.mockRejectedValue(new NotFoundException('Prefix not found'));
      await expect(service.getDhcpServing('missing')).rejects.toThrow(NotFoundException);
      expect(repo.loadDhcpServingAddresses).not.toHaveBeenCalled();
    });
  });
});
