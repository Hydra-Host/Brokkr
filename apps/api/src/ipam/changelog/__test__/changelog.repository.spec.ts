import { Prisma, RequestSource } from '@repo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseIpamRepository } from '../../shared/base-ipam.repository';
import { IpamChangelogRepository } from '../changelog.repository';

class TestAuditRepository extends BaseIpamRepository {
  audit(
    tableName: 'Vrf' | 'Prefix' | 'IpAddress' | 'Vlan' | 'IpRange',
    pk: string,
    before: Prisma.InputJsonObject | null,
    after: Prisma.InputJsonObject | null,
  ) {
    return this.writeAudit(tableName, pk, before, after);
  }
}

describe('IpamChangelogRepository (read path)', () => {
  let mockPrisma: { changelog: { findMany: ReturnType<typeof vi.fn> } };
  let repo: IpamChangelogRepository;

  beforeEach(() => {
    mockPrisma = { changelog: { findMany: vi.fn().mockResolvedValue([]) } };
    repo = new IpamChangelogRepository(mockPrisma as any, {} as any);
  });

  it('filters changelog reads directly by organizationId (no owned-PK prefetch)', async () => {
    await repo.listIpamChangelog({}, 'caller-org');

    expect(mockPrisma.changelog.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'caller-org',
        tableName: { in: ['Vrf', 'Prefix', 'IpAddress', 'Vlan', 'IpRange'] },
      },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });
    expect(Object.keys(mockPrisma)).toEqual(['changelog']);
  });

  it('narrows to a single table and pk while keeping the org filter', async () => {
    await repo.listIpamChangelog({ tableName: 'Vrf', pk: 'vrf-1', limit: 10 }, 'caller-org');

    expect(mockPrisma.changelog.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'caller-org', tableName: { in: ['Vrf'] }, pk: 'vrf-1' },
      take: 10,
      orderBy: { createdAt: 'desc' },
    });
  });

  it('excludes null-org and foreign-org rows from scoped reads', async () => {
    const dataset = [
      {
        id: 'c-a',
        tableName: 'Prefix',
        pk: 'pfx-a',
        before: null,
        after: {},
        diff: {},
        createdAt: new Date(),
        organizationId: 'org-a',
      },
      {
        id: 'c-null',
        tableName: 'Prefix',
        pk: 'pfx-missing',
        before: null,
        after: {},
        diff: {},
        createdAt: new Date(),
        organizationId: null,
      },
      {
        id: 'c-b',
        tableName: 'Prefix',
        pk: 'pfx-b',
        before: null,
        after: {},
        diff: {},
        createdAt: new Date(),
        organizationId: 'org-b',
      },
    ];
    mockPrisma.changelog.findMany.mockImplementation(({ where }: { where: { organizationId: string } }) =>
      Promise.resolve(dataset.filter((row) => row.organizationId === where.organizationId)),
    );

    const result = await repo.listIpamChangelog({}, 'org-a');

    expect(result.map((r) => r.id)).toEqual(['c-a']);
    expect(result.some((r) => r.id === 'c-b')).toBe(false);
    expect(result.some((r) => r.id === 'c-null')).toBe(false);
  });

  it('returns an allocateNextPrefix-shaped row tagged with the owner org (FIX 1 regression)', async () => {
    const ownerOrg = 'org-owner';
    mockPrisma.changelog.findMany.mockImplementation(({ where }: { where: { organizationId: string } }) =>
      Promise.resolve(
        where.organizationId === ownerOrg
          ? [
              {
                id: 'c-alloc',
                tableName: 'Prefix',
                pk: 'child-pfx',
                before: null,
                after: { id: 'child-pfx' },
                diff: {},
                createdAt: new Date(),
                organizationId: ownerOrg,
              },
            ]
          : [],
      ),
    );

    expect((await repo.listIpamChangelog({ tableName: 'Prefix', pk: 'child-pfx' }, ownerOrg)).map((r) => r.id)).toEqual(
      ['c-alloc'],
    );
    expect(await repo.listIpamChangelog({ tableName: 'Prefix', pk: 'child-pfx' }, 'other-org')).toEqual([]);
  });

  it('maps rows to changelog entries', async () => {
    mockPrisma.changelog.findMany.mockResolvedValue([
      {
        id: 'c-1',
        tableName: 'Vrf',
        pk: 'vrf-1',
        before: null,
        after: { id: 'vrf-1' },
        diff: {},
        createdAt: new Date('2026-01-01T00:00:00Z'),
        organizationId: 'caller-org',
        actorId: 'user-1',
        actorType: RequestSource.UI,
      },
    ]);

    const result = await repo.listIpamChangelog({}, 'caller-org');

    expect(result).toEqual([
      {
        id: 'c-1',
        tableName: 'Vrf',
        pk: 'vrf-1',
        before: null,
        after: { id: 'vrf-1' },
        diff: {},
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
  });
});

describe('writeAudit (write path attribution)', () => {
  let mockPrisma: { changelog: { create: ReturnType<typeof vi.fn> } };

  function build(resolveActor: () => unknown, identity: unknown) {
    mockPrisma = { changelog: { create: vi.fn().mockResolvedValue({}) } };
    const ctx = { resolveActor, identity } as any;
    return new TestAuditRepository(mockPrisma as any, ctx);
  }

  it('populates organizationId + actor from request context', async () => {
    const repo = build(() => ({ actorId: 'user-1', actorType: RequestSource.UI }), { organizationId: 'caller-org' });

    await repo.audit('Vrf', 'vrf-1', null, { id: 'vrf-1' });

    expect(mockPrisma.changelog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tableName: 'Vrf',
        pk: 'vrf-1',
        organizationId: 'caller-org',
        actorId: 'user-1',
        actorType: RequestSource.UI,
      }),
    });
  });

  it('leaves actor null when no principal is in scope', async () => {
    const repo = build(() => ({ actorId: null, actorType: null }), undefined);

    await repo.audit('Vrf', 'vrf-1', null, { id: 'vrf-1' });

    expect(mockPrisma.changelog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: null, actorId: null, actorType: null }),
    });
  });
});
