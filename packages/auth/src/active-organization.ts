import type { PrismaClient } from '@repo/database';

export interface ActiveOrganizationSource {
  memberships(userId: string): Promise<{ organizationId: string; isDefaultOrg: boolean | null }[]>;
  lastActiveOrganizationId(userId: string): Promise<string | null>;
}

/** The organization a new session starts in: the last one the user worked in, else their default, else their oldest. */
export async function resolveActiveOrganizationId(
  source: ActiveOrganizationSource,
  userId: string,
): Promise<string | null> {
  const memberships = await source.memberships(userId);
  if (memberships.length === 0) return null;
  const last = await source.lastActiveOrganizationId(userId);
  if (last !== null && memberships.some((m) => m.organizationId === last)) return last;
  const fallback = memberships.find((m) => m.isDefaultOrg === true) ?? memberships[0];
  return fallback?.organizationId ?? null;
}

export function prismaActiveOrganizationSource(prisma: PrismaClient): ActiveOrganizationSource {
  return {
    memberships: (userId) =>
      prisma.member.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { organizationId: true, isDefaultOrg: true },
      }),
    lastActiveOrganizationId: async (userId) => {
      const session = await prisma.session.findFirst({
        where: { userId, activeOrganizationId: { not: null } },
        orderBy: { updatedAt: 'desc' },
        select: { activeOrganizationId: true },
      });
      return session?.activeOrganizationId ?? null;
    },
  };
}
