import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IpAddress } from '@repo/api-client';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { NetplanLiveInvalidatorService } from 'src/brokkr-bridge/netplan/netplan-live-invalidator.service';
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
const netplanLive = { forInterface: vi.fn() };

async function buildService(repo: object, contextService: object): Promise<IpAddressService> {
  const module = await Test.createTestingModule({
    providers: [
      IpAddressService,
      { provide: IpAddressRepository, useValue: repo },
      { provide: ContextService, useValue: contextService },
      { provide: DhcpConfigPublisherService, useValue: dhcpPublisher },
      { provide: NetplanLiveInvalidatorService, useValue: netplanLive },
    ],
  }).compile();
  return module.get(IpAddressService);
}

describe('IpAddressService.archiveIpAddress VRRP-VIP guard', () => {
  const repo = {
    restore: vi.fn(),
    ensureNotInUseAsVrrpVip: vi.fn(),
    archiveUnderLock: vi.fn(),
  };
  const contextService = { requirePermission: vi.fn() };
  let service: IpAddressService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = await buildService(repo, contextService);
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
  let service: IpAddressService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = await buildService(repo, contextService);
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
  let service: IpAddressService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = await buildService(repo, contextService);
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
  let service: IpAddressService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = await buildService(repo, contextService);
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

describe('IpAddressService live netplan invalidation', () => {
  const OLD_IFACE_ID = '22222222-2222-4222-8222-222222222222';
  const NEW_IFACE_ID = '33333333-3333-4333-8333-333333333333';
  const repo = {
    assertInterfaceInOrg: vi.fn(),
    normalizeAddress: vi.fn(),
    ensureVrf: vi.fn(),
    createWithConflictGuard: vi.fn(),
    restore: vi.fn(),
    ensureNotInUseAsVrrpVip: vi.fn(),
    updateWithConflictGuard: vi.fn(),
    archiveUnderLock: vi.fn(),
  };
  const contextService = { organizationId: 'org-1', requirePermission: vi.fn() };
  let service: IpAddressService;

  beforeEach(async () => {
    vi.clearAllMocks();
    netplanLive.forInterface.mockResolvedValue(undefined);
    repo.assertInterfaceInOrg.mockResolvedValue(undefined);
    repo.normalizeAddress.mockResolvedValue('10.0.1.5');
    repo.ensureVrf.mockResolvedValue(undefined);
    repo.ensureNotInUseAsVrrpVip.mockResolvedValue(undefined);
    repo.createWithConflictGuard.mockImplementation(async (entity) => ({ ...entity.state, id: CREATED_ID }));
    repo.updateWithConflictGuard.mockImplementation(async (entity) => entity.state);
    repo.archiveUnderLock.mockImplementation(async (entity) => entity.state);
    repo.restore.mockResolvedValue({ id: IP_ID, vrfId: null, interfaceId: OLD_IFACE_ID });
    service = await buildService(repo, contextService);
  });
  afterEach(() => vi.restoreAllMocks());

  it('invalidates the live netplan for the interface after the DHCP republish when an address is archived', async () => {
    await service.archiveIpAddress(IP_ID);

    expect(netplanLive.forInterface).toHaveBeenCalledWith(OLD_IFACE_ID);
    expect(vi.mocked(dhcpPublisher.republishForIpAddress).mock.invocationCallOrder[0]).toBeLessThan(
      netplanLive.forInterface.mock.invocationCallOrder[0],
    );
  });

  it('invalidates the live netplan after the DHCP republish when an address is created on an interface', async () => {
    await service.createIpAddress({ address: '10.0.1.5', interfaceId: NEW_IFACE_ID });

    expect(netplanLive.forInterface).toHaveBeenCalledWith(NEW_IFACE_ID);
    expect(vi.mocked(dhcpPublisher.republishForIpAddress).mock.invocationCallOrder[0]).toBeLessThan(
      netplanLive.forInterface.mock.invocationCallOrder[0],
    );
  });

  it('invalidates both interfaces after the DHCP republish when an address moves between interfaces', async () => {
    await service.updateIpAddress(IP_ID, { interfaceId: NEW_IFACE_ID });

    expect(netplanLive.forInterface).toHaveBeenCalledTimes(2);
    expect(netplanLive.forInterface).toHaveBeenCalledWith(NEW_IFACE_ID);
    expect(netplanLive.forInterface).toHaveBeenCalledWith(OLD_IFACE_ID);
    expect(vi.mocked(dhcpPublisher.republishForIpAddress).mock.invocationCallOrder[0]).toBeLessThan(
      netplanLive.forInterface.mock.invocationCallOrder[0],
    );
  });

  it('invalidates only the old interface when an address is unlinked from its interface', async () => {
    await service.updateIpAddress(IP_ID, { interfaceId: null });

    expect(netplanLive.forInterface).toHaveBeenCalledTimes(2);
    expect(netplanLive.forInterface).toHaveBeenNthCalledWith(1, null);
    expect(netplanLive.forInterface).toHaveBeenNthCalledWith(2, OLD_IFACE_ID);
    expect(vi.mocked(dhcpPublisher.republishForIpAddress).mock.invocationCallOrder[0]).toBeLessThan(
      netplanLive.forInterface.mock.invocationCallOrder[0],
    );
  });

  it('invalidates the owning interface once when an address keeps its interface', async () => {
    await service.updateIpAddress(IP_ID, { status: 'ACTIVE' });

    expect(netplanLive.forInterface).toHaveBeenCalledTimes(1);
    expect(netplanLive.forInterface).toHaveBeenCalledWith(OLD_IFACE_ID);
  });
});
