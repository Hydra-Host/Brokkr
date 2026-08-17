import { Injectable } from '@nestjs/common';
import type { InvitationStatus } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { PaginatedResult, PaginationQuery, paginateQuery } from '@repo/database/pagination';
import { PrismaClient } from 'src/prisma/prisma.client';
import { invitationsPaginationConfig } from './organization-invitations.pagination';

const invitationRoleInclude = {
  assignedRole: {
    select: {
      id: true,
      name: true,
      slug: true,
      isSystem: true,
      rolePermissions: {
        select: { permission: { select: { resource: true, action: true } } },
      },
    },
  },
} satisfies Prisma.InvitationInclude;

export type InvitationWithAssignedRole = Prisma.InvitationGetPayload<{ include: typeof invitationRoleInclude }>;

@Injectable()
export class OrganizationInvitationsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByIdAndOrganizationId(invitationId: string, organizationId: string) {
    return this.prisma.invitation.findUnique({
      where: { id: invitationId, organizationId },
      include: invitationRoleInclude,
    });
  }

  findById(invitationId: string, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).invitation.findUnique({
      where: { id: invitationId },
      include: invitationRoleInclude,
    });
  }

  findPendingByEmailAndOrganization(email: string, organizationId: string, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).invitation.findFirst({
      where: {
        email: { equals: email, mode: 'insensitive' },
        organizationId,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      include: invitationRoleInclude,
    });
  }

  countPendingByOrganization(organizationId: string, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).invitation.count({
      where: { organizationId, status: 'pending', expiresAt: { gt: new Date() } },
    });
  }

  findLiveMemberByEmail(email: string, organizationId: string, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).member.findFirst({
      where: {
        organizationId,
        deletedAt: null,
        user: { email: { equals: email, mode: 'insensitive' } },
      },
    });
  }

  findActiveOrganizationName(organizationId: string) {
    return this.prisma.organization.findUnique({
      where: { id: organizationId, deletedAt: null },
      select: { name: true },
    });
  }

  createInvitation(
    data: {
      email: string;
      assignedRoleId: string;
      organizationId: string;
      inviterId: string;
      expiresAt: Date;
    },
    tx?: Prisma.TransactionClient,
  ) {
    return (tx ?? this.prisma).invitation.create({ data, include: invitationRoleInclude });
  }

  findByOrganizationIdPaginated(
    organizationId: string,
    query: PaginationQuery,
  ): Promise<PaginatedResult<InvitationWithAssignedRole>> {
    return paginateQuery<InvitationWithAssignedRole>(
      this.prisma.invitation as any,
      query,
      invitationsPaginationConfig,
      {
        where: { organizationId },
        include: invitationRoleInclude,
      },
    );
  }

  updateStatus(invitationId: string, status: InvitationStatus, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).invitation.update({
      where: { id: invitationId },
      data: { status },
      include: invitationRoleInclude,
    });
  }

  async claimPendingAsAccepted(invitationId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const result = await (tx ?? this.prisma).invitation.updateMany({
      where: { id: invitationId, status: 'pending' },
      data: { status: 'accepted' },
    });
    return result.count === 1;
  }
}
