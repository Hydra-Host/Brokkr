import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DnsConfigPublisherService } from 'src/brokkr-bridge/dns/dns-config-publisher.service';
import type { ContextService } from 'src/common/context/context.service';
import type { LoggerService } from 'src/logger/logger.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrefixRepository } from '../prefix.repository';
import { PrefixService } from '../prefix.service';

const PREFIX_ID = 'prefix-1';

function makeService(overrides: { requirePermission?: ReturnType<typeof vi.fn> } = {}) {
  const contextService = {
    requirePermission: overrides.requirePermission ?? vi.fn(),
    buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'u', triggeredByEmail: 'a@b' }),
    organizationId: 'org-1',
  };
  const repo = {
    getDnsOverride: vi.fn().mockResolvedValue({ serveDns: null, upstreamOverride: [] }),
    updateDnsOverride: vi.fn().mockResolvedValue({ serveDns: true, upstreamOverride: ['1.1.1.1'] }),
    updateDnsOverrideUnderZoneLock: vi.fn().mockResolvedValue({ serveDns: true, upstreamOverride: ['1.1.1.1'] }),
    restore: vi.fn().mockResolvedValue({ zoneId: 'zone-1', prefix: '10.0.0.0/24' }),
    requireLiveZone: vi.fn().mockResolvedValue(undefined),
  };
  const dnsPublisher = {
    publishPrefixDnsOverride: vi.fn().mockResolvedValue(true),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new PrefixService(
    repo as unknown as PrefixRepository,
    contextService as unknown as ContextService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dnsPublisher as unknown as DnsConfigPublisherService,
    logger as unknown as LoggerService,
  );
  return { service, repo, contextService, dnsPublisher };
}

describe('PrefixService DNS override', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getDnsOverride', () => {
    it('requires ipam:read and delegates to repository', async () => {
      const requirePermission = vi.fn();
      const { service, repo } = makeService({ requirePermission });

      const result = await service.getDnsOverride(PREFIX_ID);

      expect(requirePermission).toHaveBeenCalledWith('ipam', 'read');
      expect(repo.getDnsOverride).toHaveBeenCalledWith(PREFIX_ID);
      expect(result).toEqual({ serveDns: null, upstreamOverride: [] });
    });

    it('throws NotFoundException when prefix does not exist', async () => {
      const { service, repo } = makeService();
      repo.getDnsOverride.mockRejectedValue(new NotFoundException('Prefix not found'));

      await expect(service.getDnsOverride('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateDnsOverride', () => {
    it('requires ipam:update, persists, and publishes', async () => {
      const requirePermission = vi.fn();
      const { service, repo, dnsPublisher, contextService } = makeService({ requirePermission });

      const result = await service.updateDnsOverride(PREFIX_ID, {
        serveDns: true,
        upstreamOverride: ['1.1.1.1'],
      });

      expect(requirePermission).toHaveBeenCalledWith('ipam', 'update');
      expect(repo.updateDnsOverrideUnderZoneLock).toHaveBeenCalledWith(PREFIX_ID, 'zone-1', {
        serveDns: true,
        upstreamOverride: ['1.1.1.1'],
      });
      expect(contextService.buildAuditPayload).toHaveBeenCalled();
      expect(dnsPublisher.publishPrefixDnsOverride).toHaveBeenCalledWith(PREFIX_ID);
      expect(result).toEqual({ serveDns: true, upstreamOverride: ['1.1.1.1'] });
    });

    it('throws NotFoundException when prefix does not exist', async () => {
      const { service, repo } = makeService();
      repo.updateDnsOverride.mockRejectedValue(new NotFoundException('Prefix not found'));

      await expect(service.updateDnsOverride('missing', { serveDns: null, upstreamOverride: [] })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects DNS overrides on a zoneless prefix', async () => {
      const { service, repo } = makeService();
      repo.restore.mockResolvedValue({ zoneId: null });

      await expect(service.updateDnsOverride(PREFIX_ID, { serveDns: true, upstreamOverride: [] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows clearing overrides on a zoneless prefix', async () => {
      const { service, repo } = makeService();
      repo.restore.mockResolvedValue({ zoneId: null });
      repo.updateDnsOverride.mockResolvedValue({ serveDns: null, upstreamOverride: [] });

      const result = await service.updateDnsOverride(PREFIX_ID, {
        serveDns: null,
        upstreamOverride: [],
      });

      expect(repo.restore).not.toHaveBeenCalled();
      expect(result).toEqual({ serveDns: null, upstreamOverride: [] });
    });

    it('skips requireLiveZone and the zone lock when clearing DNS overrides on a tombstoned zone', async () => {
      const { service, repo } = makeService();
      repo.updateDnsOverride.mockResolvedValue({ serveDns: null, upstreamOverride: [] });

      await service.updateDnsOverride(PREFIX_ID, { serveDns: null, upstreamOverride: [] });

      expect(repo.requireLiveZone).not.toHaveBeenCalled();
      expect(repo.updateDnsOverrideUnderZoneLock).not.toHaveBeenCalled();
      expect(repo.updateDnsOverride).toHaveBeenCalledWith(PREFIX_ID, { serveDns: null, upstreamOverride: [] });
    });

    it('serializes a force-off override with the zone delete lock', async () => {
      const { service, repo } = makeService();
      repo.restore.mockResolvedValue({ zoneId: 'zone-1', prefix: '10.0.0.0/24' });
      repo.updateDnsOverrideUnderZoneLock.mockResolvedValue({ serveDns: false, upstreamOverride: [] });

      await service.updateDnsOverride(PREFIX_ID, { serveDns: false, upstreamOverride: [] });

      expect(repo.requireLiveZone).toHaveBeenCalledWith('zone-1');
      expect(repo.updateDnsOverrideUnderZoneLock).toHaveBeenCalledWith(PREFIX_ID, 'zone-1', {
        serveDns: false,
        upstreamOverride: [],
      });
    });

    it('requires live zone when enabling DNS', async () => {
      const { service, repo } = makeService();
      repo.restore.mockResolvedValue({ zoneId: 'zone-1', prefix: '10.0.0.0/24' });

      await service.updateDnsOverride(PREFIX_ID, { serveDns: true, upstreamOverride: [] });

      expect(repo.requireLiveZone).toHaveBeenCalledWith('zone-1');
    });

    it('requires live zone when setting upstream overrides', async () => {
      const { service, repo } = makeService();
      repo.restore.mockResolvedValue({ zoneId: 'zone-1', prefix: '10.0.0.0/24' });

      await service.updateDnsOverride(PREFIX_ID, { serveDns: null, upstreamOverride: ['1.1.1.1'] });

      expect(repo.requireLiveZone).toHaveBeenCalledWith('zone-1');
    });

    it('rejects enabling serveDns on a non-IPv4 prefix', async () => {
      const { service, repo } = makeService();
      repo.restore.mockResolvedValue({ zoneId: 'zone-1', prefix: '2001:db8::/64' });

      await expect(service.updateDnsOverride(PREFIX_ID, { serveDns: true, upstreamOverride: [] })).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.updateDnsOverride).not.toHaveBeenCalled();
      expect(repo.updateDnsOverrideUnderZoneLock).not.toHaveBeenCalled();
    });

    it('allows non-enabling overrides on a non-IPv4 prefix', async () => {
      const { service, repo } = makeService();
      repo.restore.mockResolvedValue({ zoneId: 'zone-1', prefix: '2001:db8::/64' });

      await service.updateDnsOverride(PREFIX_ID, { serveDns: false, upstreamOverride: [] });
      await service.updateDnsOverride(PREFIX_ID, { serveDns: null, upstreamOverride: ['1.1.1.1'] });

      expect(repo.updateDnsOverrideUnderZoneLock).toHaveBeenCalledTimes(2);
    });
  });
});
