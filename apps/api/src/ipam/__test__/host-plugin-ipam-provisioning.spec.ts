import { ActiveRecordRegistry } from '@repo/active-record';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HostPluginIpamProvisioning } from '../host-plugin-ipam-provisioning';

const ORG = '22222222-2222-4222-8222-222222222222';
const ZONE = '33333333-3333-4333-8333-333333333333';

describe('HostPluginIpamProvisioning', () => {
  const contextService = {
    runAsSystem: vi.fn((_org: string, fn: () => unknown) => fn()),
    requestFields: vi.fn(() => ({ method: null, path: null, ipAddress: null, userAgent: null })),
    requestId: 'system',
  };
  const prefixService = {
    createPrefix: vi.fn(),
    setPrefixGateway: vi.fn(),
  };
  const ipAddressService = {
    createIpAddress: vi.fn(),
  };
  const ipRangeService = {
    createIpRange: vi.fn(),
  };
  const ipamRoleRepository = {
    list: vi.fn(),
  };
  const eventLog = {
    recordInTransaction: vi.fn(),
  };

  let adapter: HostPluginIpamProvisioning;

  beforeEach(() => {
    vi.clearAllMocks();
    contextService.runAsSystem.mockImplementation((_org: string, fn: () => unknown) => fn());
    ipamRoleRepository.list.mockResolvedValue([
      { id: 'role-primary', slug: 'primary' },
      { id: 'role-mgmt', slug: 'management' },
    ]);
    adapter = new HostPluginIpamProvisioning(
      contextService as never,
      prefixService as never,
      ipAddressService as never,
      ipRangeService as never,
      ipamRoleRepository as never,
      eventLog as never,
    );
  });

  it('createPrefix runs under runAsSystem and resolves prefixRoleId by slug', async () => {
    prefixService.createPrefix.mockResolvedValue({ id: 'p1', prefix: '10.0.0.0/24' });

    const result = await adapter.createPrefix({
      organizationId: ORG,
      zoneId: ZONE,
      prefix: '10.0.0.0/24',
      role: 'PRIMARY',
      prefixRoleSlug: 'primary',
    });

    expect(contextService.runAsSystem).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(prefixService.createPrefix).toHaveBeenCalledWith({
      prefix: '10.0.0.0/24',
      role: 'PRIMARY',
      zoneId: ZONE,
      prefixRoleId: 'role-primary',
      status: 'ACTIVE',
    });
    expect(result).toEqual({ id: 'p1', prefix: '10.0.0.0/24' });
  });

  it('createIpAddress and setPrefixGateway run under the org system scope', async () => {
    ipAddressService.createIpAddress.mockResolvedValue({ id: 'ip1', address: '10.0.0.1/24' });
    prefixService.setPrefixGateway.mockResolvedValue({});

    await adapter.createIpAddress({ organizationId: ORG, address: '10.0.0.1/24' });
    await adapter.setPrefixGateway({ organizationId: ORG, prefixId: 'p1', gatewayIpId: 'ip1' });

    expect(ipAddressService.createIpAddress).toHaveBeenCalledWith({
      address: '10.0.0.1/24',
      status: 'ACTIVE',
    });
    expect(prefixService.setPrefixGateway).toHaveBeenCalledWith('p1', 'ip1');
    expect(contextService.runAsSystem).toHaveBeenNthCalledWith(1, ORG, expect.any(Function));
    expect(contextService.runAsSystem).toHaveBeenNthCalledWith(2, ORG, expect.any(Function));
  });

  it('rollbackProvisioned soft-deletes ranges, prefixes, and addresses in one transaction', async () => {
    const ipRange = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const prefix = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const ipAddress = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const tx = { ipRange, prefix, ipAddress };
    ActiveRecordRegistry.configureForTest({
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    });

    await adapter.rollbackProvisioned({
      organizationId: ORG,
      prefixIds: ['p1'],
      ipAddressIds: ['ip1'],
      ipRangeIds: ['r1'],
    });

    expect(ipRange.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['r1'] }, organizationId: ORG }),
      }),
    );
    expect(prefix.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['p1'] }, organizationId: ORG }),
        data: expect.objectContaining({ gatewayIpId: null }),
      }),
    );
    expect(ipAddress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['ip1'] }, organizationId: ORG }),
      }),
    );
  });

  it('rollbackProvisioned records an atomic SYSTEM row inside the same transaction', async () => {
    const tx = {
      ipRange: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      prefix: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      ipAddress: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
    };
    ActiveRecordRegistry.configureForTest({
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    });

    await adapter.rollbackProvisioned({
      organizationId: ORG,
      prefixIds: ['p1'],
      ipAddressIds: ['ip1', 'ip2', 'ip3'],
      ipRangeIds: ['r1', 'r2'],
    });

    expect(eventLog.recordInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: ORG,
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        resource: 'ipam',
        action: 'rollback',
        actionKey: 'ipam.rollback',
        actorType: 'SYSTEM',
        actorId: null,
        outcome: 'SUCCEEDED',
        metadata: { prefixes: 1, ipAddresses: 3, ipRanges: 2 },
      }),
    );
  });

  it('rollbackProvisioned pushes no permission intent, so the system finalizer cannot duplicate its row', async () => {
    const pushIntent = vi.fn();
    const requirePermission = vi.fn();
    const adapterWithGateSpy = new HostPluginIpamProvisioning(
      { ...contextService, pushIntent, requirePermission } as never,
      prefixService as never,
      ipAddressService as never,
      ipRangeService as never,
      ipamRoleRepository as never,
      eventLog as never,
    );
    ActiveRecordRegistry.configureForTest({
      $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
        fn({
          ipRange: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          prefix: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          ipAddress: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        }),
      ),
    });

    await adapterWithGateSpy.rollbackProvisioned({
      organizationId: ORG,
      prefixIds: ['p1'],
      ipAddressIds: [],
      ipRangeIds: [],
    });

    expect(pushIntent).not.toHaveBeenCalled();
    expect(requirePermission).not.toHaveBeenCalled();
    expect(eventLog.recordInTransaction).toHaveBeenCalledTimes(1);
  });
});
