import { type PrismaClient } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
import {
  prismaActiveOrganizationSource,
  resolveActiveOrganizationId,
  type ActiveOrganizationSource,
} from '../active-organization';

const asPrisma = (mock: object) => mock as unknown as PrismaClient;

const source = (
  memberships: { organizationId: string; isDefaultOrg: boolean | null }[],
  lastActive: string | null = null,
): ActiveOrganizationSource => ({
  memberships: async () => memberships,
  lastActiveOrganizationId: async () => lastActive,
});

describe('resolveActiveOrganizationId', () => {
  it('returns null for a user without memberships', async () => {
    expect(await resolveActiveOrganizationId(source([]), 'u1')).toBeNull();
  });

  it('returns the only membership', async () => {
    expect(await resolveActiveOrganizationId(source([{ organizationId: 'org-a', isDefaultOrg: null }]), 'u1')).toBe('org-a');
  });

  it('prefers the organization of the most recent session when the user is still a member', async () => {
    const memberships = [
      { organizationId: 'org-a', isDefaultOrg: true },
      { organizationId: 'org-b', isDefaultOrg: null },
    ];
    expect(await resolveActiveOrganizationId(source(memberships, 'org-b'), 'u1')).toBe('org-b');
  });

  it('ignores a most recent organization the user has left', async () => {
    const memberships = [
      { organizationId: 'org-a', isDefaultOrg: null },
      { organizationId: 'org-b', isDefaultOrg: null },
    ];
    expect(await resolveActiveOrganizationId(source(memberships, 'org-gone'), 'u1')).toBe('org-a');
  });

  it('falls back to the default membership before the oldest one', async () => {
    const memberships = [
      { organizationId: 'org-a', isDefaultOrg: null },
      { organizationId: 'org-b', isDefaultOrg: true },
    ];
    expect(await resolveActiveOrganizationId(source(memberships), 'u1')).toBe('org-b');
  });

  it('passes the user id to both lookups', async () => {
    const seen: string[] = [];
    const tracking: ActiveOrganizationSource = {
      memberships: async (userId) => {
        seen.push(`m:${userId}`);
        return [{ organizationId: 'org-a', isDefaultOrg: null }];
      },
      lastActiveOrganizationId: async (userId) => {
        seen.push(`s:${userId}`);
        return null;
      },
    };
    await resolveActiveOrganizationId(tracking, 'u7');
    expect(seen).toEqual(['m:u7', 's:u7']);
  });
});

describe('prismaActiveOrganizationSource', () => {
  it('lists live memberships oldest first', async () => {
    const findMany = vi.fn().mockResolvedValue([{ organizationId: 'org-a', isDefaultOrg: true }]);
    const source = prismaActiveOrganizationSource(asPrisma({ member: { findMany } }));

    expect(await source.memberships('u1')).toEqual([{ organizationId: 'org-a', isDefaultOrg: true }]);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true, isDefaultOrg: true },
    });
  });

  it('reads the organization of the newest session that had one', async () => {
    const findFirst = vi.fn().mockResolvedValue({ activeOrganizationId: 'org-b' });
    const source = prismaActiveOrganizationSource(asPrisma({ session: { findFirst } }));

    expect(await source.lastActiveOrganizationId('u1')).toBe('org-b');
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', activeOrganizationId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { activeOrganizationId: true },
    });
  });

  it('returns null when the user has no session with an organization', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const source = prismaActiveOrganizationSource(asPrisma({ session: { findFirst } }));

    expect(await source.lastActiveOrganizationId('u1')).toBeNull();
  });
});
