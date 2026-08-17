import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Invitation } from '@repo/api-client';
import { InvitationStatusSchema } from '@repo/api-client';
import { MAIN_APP_PERMISSIONS, RbacService, roleBelongsToCatalog } from '@repo/auth/rbac';
import { OrganizationMembershipRole } from '@repo/database';
import { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { AuthType } from 'src/auth/identity-context';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { EmailService } from 'src/email/email.service';
import { LoggerService } from 'src/logger/logger.service';
import { OrganizationMembershipsRepository } from '../members/organization-members.repository';
import {
  OrganizationInvitationsRepository,
  type InvitationWithAssignedRole,
} from './organization-invitations.repository';

const API_KEY_UNSUPPORTED_MESSAGE =
  'This operation requires a browser session and cannot be performed with an API key. Sign in with your email and password.';

const INVITATION_EXPIRES_MS = 48 * 60 * 60 * 1000;
const PENDING_INVITATION_LIMIT = 100;

@Injectable()
export class OrganizationInvitationsService {
  constructor(
    private readonly contextService: ContextService,
    private readonly rbacService: RbacService,
    private readonly emailService: EmailService,
    @Inject(PLUGIN_EVENT_BUS)
    private readonly eventBus: PluginEventBus,
    private readonly repository: OrganizationInvitationsRepository,
    private readonly membershipsRepository: OrganizationMembershipsRepository,
    @Logger(OrganizationInvitationsService.name) private readonly logger: LoggerService,
  ) {}

  private mapInvitation(inv: InvitationWithAssignedRole): Invitation {
    const rawStatus = InvitationStatusSchema.parse(inv.status);
    const effectiveStatus = rawStatus === 'pending' && inv.expiresAt.getTime() < Date.now() ? 'expired' : rawStatus;
    const roleVisible = roleBelongsToCatalog(MAIN_APP_PERMISSIONS, inv.assignedRole);

    return {
      id: inv.id,
      email: inv.email,
      inviterId: inv.inviterId,
      organizationId: inv.organizationId,
      role: roleVisible ? inv.assignedRole.name : 'Managed role',
      roleId: roleVisible ? inv.assignedRoleId : null,
      status: effectiveStatus,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
    };
  }

  private requireSessionAuth(): void {
    // Session-only routes leave `identity` unset, and the guard proved a real session there — absence is never an API key.
    if (this.contextService.identity?.authType === AuthType.ApiKey) {
      throw new HttpException(API_KEY_UNSUPPORTED_MESSAGE, HttpStatus.FORBIDDEN);
    }
  }

  async createInvitation(data: { email: string; roleId: string }): Promise<Invitation> {
    this.requireSessionAuth();

    this.contextService.requirePermission('invitation', 'create');

    const organizationId = this.contextService.organizationId;
    const organization = await this.repository.findActiveOrganizationName(organizationId);
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const email = data.email.trim().toLowerCase();

    const invitation = await this.rbacService.withOwnerLock(organizationId, async (tx) => {
      const existingMember = await this.repository.findLiveMemberByEmail(email, organizationId, tx);
      if (existingMember) {
        throw new HttpException('User is already a member of this organization', HttpStatus.BAD_REQUEST);
      }

      const pending = await this.repository.findPendingByEmailAndOrganization(email, organizationId, tx);
      if (pending) {
        throw new HttpException('User is already invited to this organization', HttpStatus.BAD_REQUEST);
      }

      const pendingCount = await this.repository.countPendingByOrganization(organizationId, tx);
      if (pendingCount >= PENDING_INVITATION_LIMIT) {
        throw new HttpException('Invitation limit reached', HttpStatus.FORBIDDEN);
      }

      const assignedRole = await this.rbacService.getRoleById(data.roleId, organizationId, tx);
      this.rbacService.assertRoleAssignableBy(assignedRole, this.contextService.permissions, true);
      return this.repository.createInvitation(
        {
          email,
          assignedRoleId: assignedRole.id,
          organizationId,
          inviterId: this.contextService.userId,
          expiresAt: new Date(Date.now() + INVITATION_EXPIRES_MS),
        },
        tx,
      );
    });

    try {
      const inviterName = `${this.contextService.user.firstName} ${this.contextService.user.lastName}`.trim();

      await this.emailService.send.organizationInvite({
        email,
        inviterName: inviterName || 'A team member',
        organizationName: organization.name,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send organization invitation email for invitation ${invitation.id} (organization ${organizationId}): ${getErrorMessage(error)}`,
      );
    }

    return this.mapInvitation(invitation);
  }

  async getInvitation(invitationId: string): Promise<Invitation> {
    this.contextService.requirePermission('invitation', 'read');
    const organizationId = this.contextService.organizationId;
    const invitation = await this.repository.findByIdAndOrganizationId(invitationId, organizationId);

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    return this.mapInvitation(invitation);
  }

  async listInvitations(query: PaginationQuery): Promise<PaginatedResult<Invitation>> {
    this.contextService.requirePermission('invitation', 'read');
    const organizationId = this.contextService.organizationId;
    const result = await this.repository.findByOrganizationIdPaginated(organizationId, query);
    return {
      data: result.data.map((inv) => this.mapInvitation(inv)),
      meta: result.meta,
    };
  }

  async acceptInvitation(invitationId: string): Promise<Invitation> {
    this.requireSessionAuth();

    const user = this.contextService.actingUser;
    const email = user.email.trim().toLowerCase();
    const userId = user.id;

    const initial = await this.repository.findById(invitationId);
    if (!initial || initial.email.trim().toLowerCase() !== email) {
      throw new NotFoundException('Invitation not found');
    }

    const accepted = await this.rbacService.withOwnerLock(initial.organizationId, async (tx) => {
      const existing = await this.repository.findById(invitationId, tx);
      if (!existing || existing.email.trim().toLowerCase() !== email) {
        throw new NotFoundException('Invitation not found');
      }
      if (existing.status !== 'pending') {
        throw new HttpException(`Cannot accept invitation with status '${existing.status}'`, HttpStatus.BAD_REQUEST);
      }
      if (existing.expiresAt.getTime() < Date.now()) {
        throw new HttpException('Invitation has expired', HttpStatus.BAD_REQUEST);
      }

      await this.rbacService.getRoleById(existing.assignedRoleId, existing.organizationId, tx);
      const liveMember = await this.repository.findLiveMemberByEmail(email, existing.organizationId, tx);
      if (liveMember) {
        throw new HttpException('User is already a member of this organization', HttpStatus.BAD_REQUEST);
      }
      const claimed = await this.repository.claimPendingAsAccepted(invitationId, tx);
      if (!claimed) {
        throw new HttpException('Invitation is no longer pending', HttpStatus.CONFLICT);
      }
      await this.membershipsRepository.create(
        existing.organizationId,
        userId,
        OrganizationMembershipRole.Member,
        existing.assignedRoleId,
        tx,
      );
      return { ...existing, status: 'accepted' };
    });

    this.eventBus.emit('member.added', {
      organizationId: accepted.organizationId,
      userId,
      email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: OrganizationMembershipRole.Member,
    });

    return this.mapInvitation(accepted);
  }

  async rejectInvitation(invitationId: string): Promise<Invitation> {
    const existing = await this.repository.findById(invitationId);

    if (!existing) {
      throw new NotFoundException('Invitation not found');
    }

    if (existing.email.trim().toLowerCase() !== this.contextService.actingUser.email.trim().toLowerCase()) {
      throw new NotFoundException('Invitation not found');
    }

    const updated = await this.rbacService.withOwnerLock(existing.organizationId, async (tx) => {
      const current = await this.repository.findById(invitationId, tx);
      if (!current) {
        throw new NotFoundException('Invitation not found');
      }
      if (current.status !== 'pending') {
        throw new HttpException(`Cannot reject invitation with status '${current.status}'`, HttpStatus.BAD_REQUEST);
      }
      return this.repository.updateStatus(invitationId, 'rejected', tx);
    });
    return this.mapInvitation(updated);
  }

  async cancelInvitation(invitationId: string): Promise<Invitation> {
    this.contextService.requirePermission('invitation', 'delete');

    const organizationId = this.contextService.organizationId;
    const existing = await this.repository.findByIdAndOrganizationId(invitationId, organizationId);

    if (!existing) {
      throw new NotFoundException('Invitation not found');
    }

    const updated = await this.rbacService.withOwnerLock(organizationId, async (tx) => {
      const current = await this.repository.findById(invitationId, tx);
      if (!current || current.organizationId !== organizationId) {
        throw new NotFoundException('Invitation not found');
      }
      if (current.status !== 'pending') {
        throw new HttpException(`Cannot cancel invitation with status '${current.status}'`, HttpStatus.BAD_REQUEST);
      }
      return this.repository.updateStatus(invitationId, 'canceled', tx);
    });
    return this.mapInvitation(updated);
  }
}
