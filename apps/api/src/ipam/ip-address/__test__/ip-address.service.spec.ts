import { ConflictException, NotFoundException } from '@nestjs/common';
import { IpAddress } from '@repo/api-client';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { ContextService } from 'src/common/context/context.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpAddressRepository } from '../ip-address.repository';
import { IpAddressService } from '../ip-address.service';

const IP_ID = 'ip-1';
const CREATED_ID = 'ip-created';
const dhcpPublisher = {
  republishForIpAddress: vi.fn(),
  republishForReservation: vi.fn(),
} as unknown as DhcpConfigPublisherService;

describe('IpAddressService.archiveIpAddress VRRP-VIP guard', () => {
  const repo = {
    restore: vi.fn(),
    ensureNotInUseAsVrrpVip: vi.fn(),
    archiveUnderLock: vi.fn(),
  };
  const contextService = { requirePermission: vi.fn() };
  const service = new IpAddressService(
    repo as unknown as IpAddressRepository,
    contextService as unknown as ContextService,
    dhcpPublisher,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repo.restore.mockResolvedValue({ id: IP_ID } as IpAddress);
    repo.ensureNotInUseAsVrrpVip.mockResolvedValue(undefined);
    repo.archiveUnderLock.mockImplementation(async (entity) => entity.state as IpAddress);
  });
  afterEach(() => vi.restoreAllMocks());

  it('archives when the IP is not used as a VRRP VIP', async () => {
    await service.archiveIpAddress(IP_ID);
    expect(repo.ensureNotInUseAsVrrpVip).toHaveBeenCalledWith(IP_ID);
    expect(repo.archiveUnderLock).toHaveBeenCalled();
    expect(dhcpPublisher.republishForIpAddress).toHaveBeenCalledWith(IP_ID);
  });

  it('rejects archival and never persists when the pre-flight check finds the IP in use', async () => {
    repo.ensureNotInUseAsVrrpVip.mockRejectedValue(new ConflictException('in use'));

    await expect(service.archiveIpAddress(IP_ID)).rejects.toThrow(ConflictException);
    expect(repo.archiveUnderLock).not.toHaveBeenCalled();
  });

  it('propagates the in-tx re-check rejection from archiveUnderLock (TOCTOU close)', async () => {
    repo.archiveUnderLock.mockRejectedValue(new ConflictException('in use'));

    await expect(service.archiveIpAddress(IP_ID)).rejects.toThrow(ConflictException);
  });
});

describe('IpAddressService.updateIpAddress VRRP-VIP VRF guard', () => {
  const repo = {
    restore: vi.fn(),
    ensureNotInUseAsVrrpVip: vi.fn(),
    ensureVrf: vi.fn(),
    updateWithConflictGuard: vi.fn(),
  };
  const contextService = { organizationId: 'org-1', requirePermission: vi.fn() };
  const service = new IpAddressService(
    repo as unknown as IpAddressRepository,
    contextService as unknown as ContextService,
    dhcpPublisher,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repo.restore.mockResolvedValue({ id: IP_ID, vrfId: null } as IpAddress);
    repo.ensureNotInUseAsVrrpVip.mockResolvedValue(undefined);
    repo.ensureVrf.mockResolvedValue(undefined);
    repo.updateWithConflictGuard.mockImplementation(async (entity) => entity.state as IpAddress);
  });
  afterEach(() => vi.restoreAllMocks());

  it('guards on a VRF change and rejects when the IP is an active VRRP VIP', async () => {
    repo.ensureNotInUseAsVrrpVip.mockRejectedValue(new ConflictException('in use'));

    await expect(service.updateIpAddress(IP_ID, { vrfId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })).rejects.toThrow(
      ConflictException,
    );
    expect(repo.ensureNotInUseAsVrrpVip).toHaveBeenCalledWith(IP_ID);
    expect(repo.updateWithConflictGuard).not.toHaveBeenCalled();
  });

  it('skips the VIP guard when the VRF is unchanged (status/dnsName only)', async () => {
    await service.updateIpAddress(IP_ID, { status: 'ACTIVE' });

    expect(repo.ensureNotInUseAsVrrpVip).not.toHaveBeenCalled();
    expect(repo.updateWithConflictGuard).toHaveBeenCalled();
  });

  it('republishes both the new IP prefix and the old prefix on a VRF change', async () => {
    repo.restore.mockResolvedValue({ id: IP_ID, vrfId: 'old-vrf', address: '10.0.1.5' } as IpAddress);

    await service.updateIpAddress(IP_ID, { vrfId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });

    expect(dhcpPublisher.republishForIpAddress).toHaveBeenCalledWith(IP_ID);
    expect(dhcpPublisher.republishForReservation).toHaveBeenCalledWith('10.0.1.5', 'org-1', 'old-vrf');
  });

  it('skips the VIP guard on a no-op VRF resend (same value)', async () => {
    const VRF_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    repo.restore.mockResolvedValue({ id: IP_ID, vrfId: VRF_ID } as IpAddress);

    await service.updateIpAddress(IP_ID, { vrfId: VRF_ID });

    expect(repo.ensureNotInUseAsVrrpVip).not.toHaveBeenCalled();
    expect(repo.updateWithConflictGuard).toHaveBeenCalled();
  });
});

describe('IpAddressService.createIpAddress DHCP republish', () => {
  const repo = {
    normalizeAddress: vi.fn(),
    ensureVrf: vi.fn(),
    createWithConflictGuard: vi.fn(),
  };
  const contextService = { organizationId: 'org-1', requirePermission: vi.fn() };
  const service = new IpAddressService(
    repo as unknown as IpAddressRepository,
    contextService as unknown as ContextService,
    dhcpPublisher,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repo.normalizeAddress.mockResolvedValue('10.0.1.5');
    repo.ensureVrf.mockResolvedValue(undefined);
    repo.createWithConflictGuard.mockResolvedValue({ id: CREATED_ID } as IpAddress);
  });
  afterEach(() => vi.restoreAllMocks());

  it('republishes the DHCP atom for the created IP address', async () => {
    await service.createIpAddress({ address: '10.0.1.5', prefixId: 'prefix-1' } as never);

    expect(dhcpPublisher.republishForIpAddress).toHaveBeenCalledWith(CREATED_ID);
  });
});

describe('IpAddressService interfaceId cross-org guard (assertInterfaceInOrg)', () => {
  const IFACE_ID = '11111111-1111-4111-8111-111111111111';
  const repo = {
    assertInterfaceInOrg: vi.fn(),
    normalizeAddress: vi.fn(),
    ensureVrf: vi.fn(),
    createWithConflictGuard: vi.fn(),
    restore: vi.fn(),
    ensureNotInUseAsVrrpVip: vi.fn(),
    updateWithConflictGuard: vi.fn(),
  };
  const contextService = { organizationId: 'org-1', requirePermission: vi.fn() };
  const service = new IpAddressService(
    repo as unknown as IpAddressRepository,
    contextService as unknown as ContextService,
    dhcpPublisher,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repo.assertInterfaceInOrg.mockResolvedValue(undefined);
    repo.normalizeAddress.mockResolvedValue('10.0.1.5');
    repo.ensureVrf.mockResolvedValue(undefined);
    repo.createWithConflictGuard.mockResolvedValue({ id: CREATED_ID } as IpAddress);
    repo.restore.mockResolvedValue({ id: IP_ID, vrfId: null } as IpAddress);
    repo.ensureNotInUseAsVrrpVip.mockResolvedValue(undefined);
    repo.updateWithConflictGuard.mockResolvedValue({ id: IP_ID } as IpAddress);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('createIpAddress', () => {
    it('skips the guard when no interfaceId is supplied', async () => {
      await service.createIpAddress({ address: '10.0.1.5' } as never);
      expect(repo.assertInterfaceInOrg).not.toHaveBeenCalled();
      expect(repo.createWithConflictGuard).toHaveBeenCalled();
    });

    it('runs the guard with the supplied interfaceId, then proceeds to persist', async () => {
      await service.createIpAddress({ address: '10.0.1.5', interfaceId: IFACE_ID } as never);
      expect(repo.assertInterfaceInOrg).toHaveBeenCalledWith(IFACE_ID);
      expect(repo.createWithConflictGuard).toHaveBeenCalled();
    });

    it('rejects and never persists when the interface is foreign-org (guard throws)', async () => {
      repo.assertInterfaceInOrg.mockRejectedValue(new NotFoundException('interface not found'));
      await expect(service.createIpAddress({ address: '10.0.1.5', interfaceId: IFACE_ID } as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.createWithConflictGuard).not.toHaveBeenCalled();
    });
  });

  describe('updateIpAddress', () => {
    it('skips the guard when no interfaceId is supplied', async () => {
      await service.updateIpAddress(IP_ID, { status: 'ACTIVE' } as never);
      expect(repo.assertInterfaceInOrg).not.toHaveBeenCalled();
      expect(repo.updateWithConflictGuard).toHaveBeenCalled();
    });

    it('runs the guard with the supplied interfaceId, then proceeds to persist', async () => {
      await service.updateIpAddress(IP_ID, { interfaceId: IFACE_ID } as never);
      expect(repo.assertInterfaceInOrg).toHaveBeenCalledWith(IFACE_ID);
      expect(repo.updateWithConflictGuard).toHaveBeenCalled();
    });

    it('rejects and never persists when the interface is foreign-org (guard throws)', async () => {
      repo.assertInterfaceInOrg.mockRejectedValue(new NotFoundException('interface not found'));
      await expect(service.updateIpAddress(IP_ID, { interfaceId: IFACE_ID } as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.updateWithConflictGuard).not.toHaveBeenCalled();
    });

    it('calls ensureNotInUseAsVrrpVip before updateWithConflictGuard when interfaceId is set', async () => {
      await service.updateIpAddress(IP_ID, { interfaceId: IFACE_ID } as never);
      expect(repo.ensureNotInUseAsVrrpVip).toHaveBeenCalledWith(IP_ID);
      expect(repo.updateWithConflictGuard).toHaveBeenCalled();
    });

    it('rejects and never persists when ensureNotInUseAsVrrpVip rejects (VRRP VIP guard)', async () => {
      repo.ensureNotInUseAsVrrpVip.mockRejectedValue(new ConflictException('in use'));
      await expect(service.updateIpAddress(IP_ID, { interfaceId: IFACE_ID } as never)).rejects.toThrow(
        ConflictException,
      );
      expect(repo.updateWithConflictGuard).not.toHaveBeenCalled();
    });

    it('does not call ensureNotInUseAsVrrpVip when interfaceId is absent', async () => {
      await service.updateIpAddress(IP_ID, { status: 'ACTIVE' } as never);
      expect(repo.ensureNotInUseAsVrrpVip).not.toHaveBeenCalled();
    });
  });
});
