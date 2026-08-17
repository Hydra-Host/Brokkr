import type { UpdatePrefixDhcpConfig } from '@repo/api-client';
import type { ContextService } from 'src/common/context/context.service';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpamQueryExecutor } from '../../shared/base-ipam.repository';
import { PrefixRepository } from '../prefix.repository';

describe('PrefixRepository.updateDhcpConfig transaction atomicity', () => {
  const OFF_INPUT: UpdatePrefixDhcpConfig = {
    dhcpMode: 'OFF',
    dhcpLeaseTtlSeconds: null,
    ipxeBuildTarget: null,
    dhcpOptions: [],
    dhcpProxyAllowedMacs: [],
    dhcpProxyPeerAuthoritative: false,
    dhcpRelayAgentIp: '10.0.1.254',
  };

  const FAKE_CTE_ROW = {
    dhcpMode: 'OFF' as const,
    dhcpLeaseTtlSeconds: null,
    ipxeBuildTarget: null,
    dhcpOptions: null,
    dhcpProxyAllowedMacs: [],
    dhcpProxyPeerAuthoritative: false,
    dhcpRelayAgentIp: '10.0.1.254',
    before_dhcpMode: 'AUTHORITATIVE' as const,
    before_dhcpLeaseTtlSeconds: 600,
    before_ipxeBuildTarget: 'IPXE' as const,
    before_dhcpOptions: null,
    before_dhcpProxyAllowedMacs: [],
    before_dhcpRelayAgentIp: '10.0.1.254',
  };

  let transactionSpy: ReturnType<typeof vi.fn>;
  let repo: PrefixRepository;

  beforeEach(() => {
    transactionSpy = vi.fn(async (handler: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        $queryRaw: vi.fn().mockResolvedValue([FAKE_CTE_ROW]),
        $executeRaw: vi.fn(),
        changelog: { create: vi.fn().mockResolvedValue({}) },
      };
      return handler(fakeTx);
    });

    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([FAKE_CTE_ROW]),
      $executeRaw: vi.fn(),
      $transaction: transactionSpy,
      changelog: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const contextService = {
      organizationId: 'org-1',
      identity: { organizationId: 'org-1' },
      resolveActor: () => ({ actorId: 'user-1', actorType: 'user' }),
    } as unknown as ContextService;

    repo = new PrefixRepository(prisma, contextService);
  });

  it('wraps CTE UPDATE + writeAudit in a transaction when called standalone (no executor)', async () => {
    const result = await repo.updateDhcpConfig('prefix-1', OFF_INPUT);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(result.dhcpRelayAgentIp).toBe('10.0.1.254');
  });

  it('does NOT open a new transaction when an executor is provided (already in a tx)', async () => {
    const executor: IpamQueryExecutor = {
      queryRaw: vi.fn().mockResolvedValue([FAKE_CTE_ROW]),
      executeRaw: vi.fn(),
      createChangelog: vi.fn().mockResolvedValue({}),
    };
    await repo.updateDhcpConfig('prefix-1', OFF_INPUT, executor);
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(executor.queryRaw).toHaveBeenCalled();
    expect(executor.createChangelog).toHaveBeenCalled();
  });

  it('rolls back the CTE UPDATE when writeAudit fails (audit failure on disable path)', async () => {
    transactionSpy.mockImplementationOnce(async (handler: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        $queryRaw: vi.fn().mockResolvedValue([FAKE_CTE_ROW]),
        $executeRaw: vi.fn(),
        changelog: { create: vi.fn().mockRejectedValue(new Error('changelog insert failed')) },
      };
      return handler(fakeTx);
    });

    await expect(repo.updateDhcpConfig('prefix-1', OFF_INPUT)).rejects.toThrow('changelog insert failed');
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });
});

describe('PrefixRepository.loadDhcpServingAddresses scope + VIP fallthrough', () => {
  function makeRepo(queryRaw: ReturnType<typeof vi.fn>): PrefixRepository {
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
    const contextService = {
      organizationId: 'org-1',
      identity: { organizationId: 'org-1' },
    } as unknown as ContextService;
    return new PrefixRepository(prisma, contextService);
  }

  const prefixArg = { vrrpVipId: 'vip-id', zoneId: 'zone-1', vrfId: null, cidr: '10.0.1.0/24' };

  it('returns the VIP as the sole serving address and org-scopes the VIP lookup', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ ip: '10.0.1.1' }]);
    const repo = makeRepo(queryRaw);

    const result = await repo.loadDhcpServingAddresses(prefixArg);

    expect(result).toEqual({ vipAddress: '10.0.1.1', bridgeIps: [] });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [template, ...values] = queryRaw.mock.calls[0];
    expect(template.join('?')).toContain('"organizationId"');
    expect(values).toContain('org-1');
    expect(values).toContain('vip-id');
  });

  it('falls through to the bridge-NIC query when the VIP does not resolve (stale/non-IPv4)', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ip: '10.0.1.10' }, { ip: '10.0.1.11' }]);
    const repo = makeRepo(queryRaw);

    const result = await repo.loadDhcpServingAddresses(prefixArg);

    expect(result).toEqual({ vipAddress: null, bridgeIps: ['10.0.1.10', '10.0.1.11'] });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const [bridgeTemplate, ...bridgeValues] = queryRaw.mock.calls[1];
    const bridgeSql = bridgeTemplate.join('?');
    expect(bridgeSql).toContain('"organizationId"');
    expect(bridgeSql).toContain("'ACTIVE'");
    expect(bridgeValues).toContain('10.0.1.0/24');
  });

  it('skips the VIP query entirely when the prefix has no vrrpVipId', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ ip: '10.0.1.10' }]);
    const repo = makeRepo(queryRaw);

    const result = await repo.loadDhcpServingAddresses({ ...prefixArg, vrrpVipId: null });

    expect(result).toEqual({ vipAddress: null, bridgeIps: ['10.0.1.10'] });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns empty and runs no query when there is neither a vrrpVipId nor a zoneId', async () => {
    const queryRaw = vi.fn();
    const repo = makeRepo(queryRaw);

    const result = await repo.loadDhcpServingAddresses({
      vrrpVipId: null,
      zoneId: null,
      vrfId: null,
      cidr: '10.0.1.0/24',
    });

    expect(result).toEqual({ vipAddress: null, bridgeIps: [] });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
