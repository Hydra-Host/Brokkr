import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@repo/database';
import type { ContextService } from 'src/common/context/context.service';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefixRepository } from '../prefix.repository';

const PREFIX_ID = 'prefix-1';
const ZONE_ID = 'zone-1';

const AFTER_ROW = {
  dhcpMode: 'AUTHORITATIVE' as const,
  dhcpLeaseTtlSeconds: null,
  ipxeBuildTarget: null,
  dhcpOptions: null,
  dhcpProxyAllowedMacs: [],
  dhcpProxyPeerAuthoritative: false,
  dhcpRelayAgentIp: null,
};

describe('PrefixRepository.autoEnableAuthoritativeDhcp', () => {
  let queryRaw: ReturnType<typeof vi.fn>;
  let executeRaw: ReturnType<typeof vi.fn>;
  let changelogCreate: ReturnType<typeof vi.fn>;
  let transactionSpy: ReturnType<typeof vi.fn>;
  let repo: PrefixRepository;

  beforeEach(() => {
    queryRaw = vi.fn();
    executeRaw = vi.fn().mockResolvedValue(1);
    changelogCreate = vi.fn().mockResolvedValue({});
    transactionSpy = vi.fn(async (handler: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        $queryRaw: queryRaw,
        $executeRaw: executeRaw,
        changelog: { create: changelogCreate },
      };
      return handler(fakeTx);
    });

    const prisma = {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      $transaction: transactionSpy,
      changelog: { create: changelogCreate },
    } as unknown as PrismaClient;

    const contextService = {
      organizationId: 'org-1',
      identity: { organizationId: 'org-1' },
      resolveActor: () => ({ actorId: 'user-1', actorType: 'user' }),
    } as unknown as ContextService;

    repo = new PrefixRepository(prisma, contextService);
  });

  it('flips a null dhcpMode to AUTHORITATIVE under the zone advisory lock and audits it', async () => {
    queryRaw.mockResolvedValueOnce([{ id: ZONE_ID }]).mockResolvedValueOnce([AFTER_ROW]);

    const outcome = await repo.autoEnableAuthoritativeDhcp(PREFIX_ID, ZONE_ID);

    expect(outcome).toBe('enabled');
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    const [lockTemplate] = executeRaw.mock.calls[0];
    expect(lockTemplate.join('?')).toContain('pg_advisory_xact_lock');
    const [updateTemplate, ...updateValues] = queryRaw.mock.calls[1];
    const updateSql = updateTemplate.join('?');
    expect(updateSql).toContain(`"dhcpMode" = 'AUTHORITATIVE'`);
    expect(updateSql).toContain('"dhcpMode" IS NULL');
    expect(updateValues).toContain(PREFIX_ID);
    expect(updateValues).toContain('org-1');
    expect(changelogCreate).toHaveBeenCalledTimes(1);
    const auditData = changelogCreate.mock.calls[0][0].data;
    expect(auditData.before).toMatchObject({ dhcpMode: null });
    expect(auditData.after).toMatchObject({ dhcpMode: 'AUTHORITATIVE' });
  });

  it('returns already-configured without an audit when dhcpMode is set (operator write wins)', async () => {
    queryRaw
      .mockResolvedValueOnce([{ id: ZONE_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: PREFIX_ID }]);

    const outcome = await repo.autoEnableAuthoritativeDhcp(PREFIX_ID, ZONE_ID);

    expect(outcome).toBe('already-configured');
    expect(changelogCreate).not.toHaveBeenCalled();
  });

  it('returns not-found when the prefix is missing or soft-deleted', async () => {
    queryRaw.mockResolvedValueOnce([{ id: ZONE_ID }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const outcome = await repo.autoEnableAuthoritativeDhcp(PREFIX_ID, ZONE_ID);

    expect(outcome).toBe('not-found');
    expect(changelogCreate).not.toHaveBeenCalled();
  });

  it('returns ineligible when the eligibility CHECK constraint trips (racing zone/role change)', async () => {
    queryRaw.mockResolvedValueOnce([{ id: ZONE_ID }]).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('constraint violation', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '23514', message: 'Prefix_dhcp_requires_zone_check' },
      }),
    );

    const outcome = await repo.autoEnableAuthoritativeDhcp(PREFIX_ID, ZONE_ID);

    expect(outcome).toBe('ineligible');
    expect(changelogCreate).not.toHaveBeenCalled();
  });

  it('propagates a dead-zone rejection from requireLiveZone', async () => {
    queryRaw.mockResolvedValueOnce([]);

    await expect(repo.autoEnableAuthoritativeDhcp(PREFIX_ID, ZONE_ID)).rejects.toThrow(NotFoundException);
    expect(changelogCreate).not.toHaveBeenCalled();
  });

  it('rethrows non-constraint errors', async () => {
    queryRaw.mockResolvedValueOnce([{ id: ZONE_ID }]).mockRejectedValueOnce(new Error('connection reset'));

    await expect(repo.autoEnableAuthoritativeDhcp(PREFIX_ID, ZONE_ID)).rejects.toThrow('connection reset');
  });
});
