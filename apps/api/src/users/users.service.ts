import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Invitation, InvitationWithOrganization, PaginationMeta, User } from '@repo/api-client';
import { type SecondaryStorage } from '@repo/auth';
import { MAIN_APP_PERMISSIONS, roleBelongsToCatalog } from '@repo/auth/rbac';
import { Prisma } from '@repo/database';
import { paginateArray } from '@repo/database/pagination';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { OrganizationInvitationsService } from 'src/organizations/invitations/organization-invitations.service';
import { PrismaClient } from 'src/prisma/prisma.client';

// ts-rest does not strip responses — this select is the actual runtime guard against leaking internal account state.
const USER_PROFILE_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  name: true,
  image: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly invitationsService: OrganizationInvitationsService,
    @Inject('AUTH_SESSION_CACHE') private readonly sessionCache: SecondaryStorage | null,
    @Logger(UsersService.name) private readonly logger: LoggerService,
  ) {}

  async findUserById(id: string, include?: Prisma.UserInclude) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  // Explicit field pick — ts-rest does not strip responses, so this is the runtime guard against serializing undeclared fields.
  async getAuthenticatedUser(id: string): Promise<User> {
    const user = await this.findUserById(id);
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      image: user.image,
      createdAt: user.createdAt,
      // updatedAt is nullable in the DB (rows predating @updatedAt); the contract promises a date.
      updatedAt: user.updatedAt ?? user.createdAt,
      role: user.role,
      banned: user.banned,
      banReason: user.banReason,
      banExpires: user.banExpires,
    };
  }

  // Email deliberately not updatable — it's the account identifier/password-reset target and there is no verified change-email flow.
  async updateUser(id: string, data: { firstName?: string; lastName?: string }) {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { firstName: true, lastName: true },
    });
    if (!current) {
      throw new NotFoundException('User not found');
    }

    const updateData: Prisma.UserUpdateInput = {};
    if (data.firstName !== undefined) updateData.firstName = data.firstName;
    if (data.lastName !== undefined) updateData.lastName = data.lastName;
    if (data.firstName !== undefined || data.lastName !== undefined) {
      const first = data.firstName ?? current.firstName ?? '';
      const last = data.lastName ?? current.lastName ?? '';
      updateData.name = [first, last].filter(Boolean).join(' ') || null;
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: updateData,
      select: USER_PROFILE_SELECT,
    });
    await this.refreshUserSessions(id);
    return user;
  }

  async refreshUserSessions(userId: string): Promise<void> {
    if (!this.sessionCache) return;

    try {
      const sessionList = (await this.sessionCache.get(`active-sessions-${userId}`)) as
        | { token: string; expiresAt: number }[]
        | null;
      if (!sessionList?.length) return;

      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;

      const now = Date.now();

      await Promise.all(
        sessionList
          .filter((s) => s.expiresAt > now)
          .map(async ({ token }) => {
            const entry = (await this.sessionCache!.get(token)) as {
              session: { expiresAt: string };
            } | null;
            if (!entry?.session) return;

            const ttl = Math.floor((new Date(entry.session.expiresAt).getTime() - now) / 1000);
            if (ttl <= 0) return;

            await this.sessionCache!.set(token, JSON.stringify({ session: entry.session, user }), ttl);
          }),
      );
    } catch (error) {
      this.logger.warn(`Failed to refresh session cache for user ${userId}: ${getErrorMessage(error)}`);
    }
  }

  async listPendingInvitationsForUser(email: string): Promise<InvitationWithOrganization[]> {
    const normalizedEmail = email.trim().toLowerCase();
    // Better Auth never flips status to 'expired' — must exclude past-expiresAt invites here
    const invitations = await this.prisma.invitation.findMany({
      where: {
        email: { equals: normalizedEmail, mode: 'insensitive' },
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      include: {
        organization: { select: { name: true } },
        assignedRole: {
          select: {
            name: true,
            rolePermissions: {
              select: { permission: { select: { resource: true, action: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invitations.map((inv) => {
      const roleVisible = roleBelongsToCatalog(MAIN_APP_PERMISSIONS, inv.assignedRole);
      return {
        id: inv.id,
        email: inv.email,
        inviterId: inv.inviterId,
        organizationId: inv.organizationId,
        role: roleVisible ? inv.assignedRole.name : 'Managed role',
        roleId: roleVisible ? inv.assignedRoleId : null,
        status: inv.status as 'pending',
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt,
        organizationName: inv.organization.name,
      };
    });
  }

  async listPendingInvitationsForUserPaginated(
    email: string,
    query: { page?: number; pageSize?: number },
  ): Promise<{ data: InvitationWithOrganization[]; meta: PaginationMeta }> {
    const all = await this.listPendingInvitationsForUser(email);
    return paginateArray(all, query, { searchableFields: [] });
  }

  acceptInvitationForUser(invitationId: string): Promise<Invitation> {
    return this.invitationsService.acceptInvitation(invitationId);
  }

  rejectInvitationForUser(invitationId: string): Promise<Invitation> {
    return this.invitationsService.rejectInvitation(invitationId);
  }
}
