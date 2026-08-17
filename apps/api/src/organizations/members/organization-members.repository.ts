import { Injectable } from '@nestjs/common';
import type { OrganizationMembersQuery } from '@repo/api-client';
import { requireSystemRoleId } from '@repo/auth/rbac';
import { Member, OrganizationMembershipRole, Prisma } from '@repo/database';
import { PaginatedResult, paginateQuery } from '@repo/database/pagination';
import { PrismaClient } from 'src/prisma/prisma.client';
import { membersPaginationConfig } from './organization-members.pagination';

const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  image: true,
} satisfies Prisma.UserSelect;

type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

type RoleSummary = {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  rolePermissions: { permission: { resource: string; action: string } }[];
};

const roleSummarySelect = {
  id: true,
  name: true,
  slug: true,
  isSystem: true,
  rolePermissions: {
    select: { permission: { select: { resource: true, action: true } } },
  },
} satisfies Prisma.OrganizationMemberRoleSelect;

@Injectable()
export class OrganizationMembershipsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(
    organizationId: string,
    userId: string,
    role: OrganizationMembershipRole,
    assignedRoleId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const executor = tx ?? this.prisma;
    return executor.member.upsert({
      where: { userId_organizationId: { userId, organizationId } },
      create: { organizationId, userId, role, assignedRoleId },
      update: { role, assignedRoleId, deletedAt: null },
    });
  }

  findByOrganizationId(organizationId: string) {
    return this.prisma.member.findMany({
      where: { organizationId, deletedAt: null },
      include: { user: { select: publicUserSelect } },
    });
  }

  findByOrganizationIdPaginated(
    organizationId: string,
    query: OrganizationMembersQuery,
  ): Promise<PaginatedResult<Member & { user: PublicUser; assignedRole: RoleSummary }>> {
    const { ownerTransferEligible, excludeMemberId, ...paginationQuery } = query;
    const eligibilityWhere: Prisma.MemberWhereInput = ownerTransferEligible
      ? {
          assignedRole: {
            rolePermissions: {
              none: {
                permission: {
                  resource: 'organization',
                  action: 'manage-owners',
                },
              },
            },
          },
          user: {
            OR: [{ banned: false }, { banExpires: { lte: new Date() } }],
          },
        }
      : {};
    return paginateQuery<Member & { user: PublicUser; assignedRole: RoleSummary }>(
      this.prisma.member as any,
      paginationQuery,
      membersPaginationConfig,
      {
        where: {
          organizationId,
          deletedAt: null,
          ...(excludeMemberId ? { id: { not: excludeMemberId } } : {}),
          ...eligibilityWhere,
        },
        include: {
          user: { select: publicUserSelect },
          assignedRole: { select: roleSummarySelect },
        },
      },
    );
  }

  findByUserId(userId: string) {
    return this.prisma.member.findMany({
      where: { userId, deletedAt: null },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            tenantType: true,
          },
        },
      },
    });
  }

  requireSystemRoleId(role: OrganizationMembershipRole) {
    return requireSystemRoleId(this.prisma, role);
  }

  findByIdAndOrganizationId(memberId: string, organizationId: string) {
    return this.prisma.member.findUnique({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
      },
      include: {
        organization: true,
        user: true,
        assignedRole: { select: roleSummarySelect },
      },
    });
  }

  findByIdAndOrganizationIdLean(memberId: string, organizationId: string) {
    return this.prisma.member.findUnique({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
      },
      include: {
        assignedRole: { select: roleSummarySelect },
      },
    });
  }

  findByUserIdAndOrganizationId(userId: string, organizationId: string) {
    return this.prisma.member.findFirst({
      where: {
        userId,
        organizationId,
        deletedAt: null,
      },
    });
  }

  delete(memberId: string) {
    return this.prisma.member.update({
      where: { id: memberId },
      data: { deletedAt: new Date() },
      include: {
        user: { select: publicUserSelect },
        organization: true,
        assignedRole: { select: roleSummarySelect },
      },
    });
  }

  async updateRole(memberId: string, role: OrganizationMembershipRole) {
    const assignedRoleId = await requireSystemRoleId(this.prisma, role);
    return this.prisma.member.update({
      where: { id: memberId, deletedAt: null },
      data: { role, assignedRoleId },
      include: {
        user: { select: publicUserSelect },
        assignedRole: { select: roleSummarySelect },
      },
    });
  }

  setDefaultOrganization(userId: string, organizationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.member.findFirst({ where: { userId, organizationId, deletedAt: null } });
      if (!target) return null;
      await tx.member.updateMany({
        where: { userId, isDefaultOrg: true },
        data: { isDefaultOrg: null },
      });
      await tx.member.update({
        where: { id: target.id },
        data: { isDefaultOrg: true },
      });
      return tx.member.findFirst({
        where: { userId, organizationId, deletedAt: null },
        include: { assignedRole: { select: roleSummarySelect } },
      });
    });
  }
}
