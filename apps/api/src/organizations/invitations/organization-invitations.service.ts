import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Invitation } from '@repo/api-client';
import { InvitationStatusSchema } from '@repo/api-client';
import { RbacService, roleBelongsToCatalog } from '@repo/auth/rbac';
import { OrganizationMembershipRole, type Prisma } from '@repo/database';
import { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { AuthType } from 'src/auth/identity-context';
import { ContextService, type PermissionIntentHandle } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { EmailService } from 'src/email/email.service';
import { resolveErrorCode } from 'src/event-log/event-log-status-mapper';
import { EventLogService } from 'src/event-log/event-log.service';
import type { EventLogWrite } from 'src/event-log/event-log.types';
import { LoggerService } from 'src/logger/logger.service';
import { MAIN_APP_PERMISSIONS } from 'src/permissions/permissions.constants';
import { OrganizationMembershipsRepository } from '../members/organization-members.repository';
import {
  OrganizationInvitationsRepository,
  type InvitationWithAssignedRole,
} from './organization-invitations.repository';

const API_KEY_UNSUPPORTED_MESSAGE =
  'This operation requires a browser session and cannot be performed with an API key. Sign in with your email and password.';

const INVITATION_EXPIRES_MS = 48 * 60 * 60 * 1000;
const PENDING_INVITATION_LIMIT = 100;

const MEMBER_INVITED = { resource: 'member', action: 'invited', actionKey: 'member.invited' };
const MEMBER_JOINED = { resource: 'member', action: 'joined', actionKey: 'member.joined' };
const INVITATION_REJECTED = { resource: 'invitation', action: 'rejected', actionKey: 'invitation.rejected' };
// Double-l deliberately: the stored status literal is 'canceled', but action keys are their own namespace.
const INVITATION_CANCELLED = { resource: 'invitation', action: 'cancelled', actionKey: 'invitation.cancelled' };

interface InvitationEvent {
  organizationId: string;
  resource: string;
  action: string;
  actionKey: string;
  invitationId: string;
  email: string;
}

function eventTarget(invitation: InvitationWithAssignedRole): { organizationId: string; email: string } {
  return { organizationId: invitation.organizationId, email: invitation.email.trim().toLowerCase() };
}

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
    private readonly eventLog: EventLogService,
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

  /** The organization is a required argument, never read from the request context: an invitee accepting or
   *  rejecting is not yet a member, so the ambient organization is a different tenant. */
  private baseWrite(event: InvitationEvent): Omit<EventLogWrite, 'durability' | 'outcome'> {
    return {
      organizationId: event.organizationId,
      tier: 'EVIDENCE',
      resource: event.resource,
      action: event.action,
      actionKey: event.actionKey,
      ...this.contextService.actorFields(),
      ...this.contextService.requestFields(),
      targetId: event.invitationId,
      targetLabel: event.email,
      requestId: this.contextService.requestId ?? null,
    };
  }

  private recordEvent(tx: Prisma.TransactionClient, event: InvitationEvent): Promise<void> {
    return this.eventLog.recordInTransaction(tx, {
      ...this.baseWrite(event),
      durability: 'ATOMIC',
      outcome: 'SUCCEEDED',
    });
  }

  /** Standalone rather than atomic: these failures throw inside the mutation's transaction, so an insert on
   *  that transaction would roll back with them. A crash between the throw and this write loses the row. */
  private async withFailureEvent<T>(event: () => InvitationEvent, mutation: () => Promise<T>): Promise<T> {
    try {
      return await mutation();
    } catch (error) {
      const write: EventLogWrite = {
        ...this.baseWrite(event()),
        durability: 'POST_COMMIT',
        outcome: 'FAILED',
        errorCode: resolveErrorCode(error),
      };
      try {
        await this.eventLog.record(write);
      } catch (auditError) {
        // Throwing here would answer a rolled-back 400 with a 500, and these paths record no intent
        // for tier 2 to fall back on. Losing the row is what POST_COMMIT already concedes.
        this.logger.error(
          `Failed to persist event ${write.actionKey} for organization ${write.organizationId}: ${getErrorMessage(auditError)}`,
        );
      }
      throw error;
    }
  }

  /** Called after the mutation resolves: a rollback leaves the handle pending so tier 2 records the failure. */
  private supersede(handle: PermissionIntentHandle | undefined): void {
    if (handle) this.contextService.finalizeIntents([handle]);
  }

  async createInvitation(data: { email: string; roleId: string }): Promise<Invitation> {
    this.requireSessionAuth();

    const handle = this.contextService.requirePermission('invitation', 'create');

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
      const created = await this.repository.createInvitation(
        {
          email,
          assignedRoleId: assignedRole.id,
          organizationId,
          inviterId: this.contextService.userId,
          expiresAt: new Date(Date.now() + INVITATION_EXPIRES_MS),
        },
        tx,
      );
      // Inside the transaction, so it precedes the email send below: a row without an email is
      // recoverable, an email without a row is not.
      await this.recordEvent(tx, { ...MEMBER_INVITED, organizationId, invitationId: created.id, email });
      return created;
    });
    this.supersede(handle);

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

    // Reassigned under the lock so both outcomes are attributed to the row as reloaded.
    let target = eventTarget(initial);

    const accepted = await this.withFailureEvent(
      () => ({ ...MEMBER_JOINED, ...target, invitationId }),
      () =>
        this.rbacService.withOwnerLock(initial.organizationId, async (tx) => {
          const existing = await this.repository.findById(invitationId, tx);
          if (existing) {
            target = eventTarget(existing);
          }
          if (!existing || existing.email.trim().toLowerCase() !== email) {
            throw new NotFoundException('Invitation not found');
          }
          if (existing.status !== 'pending') {
            throw new HttpException(
              `Cannot accept invitation with status '${existing.status}'`,
              HttpStatus.BAD_REQUEST,
            );
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
          await this.recordEvent(tx, { ...MEMBER_JOINED, ...target, invitationId });
          return { ...existing, status: 'accepted' };
        }),
    );

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

    let target = eventTarget(existing);

    const updated = await this.withFailureEvent(
      () => ({ ...INVITATION_REJECTED, ...target, invitationId }),
      () =>
        this.rbacService.withOwnerLock(existing.organizationId, async (tx) => {
          const current = await this.repository.findById(invitationId, tx);
          if (current) {
            target = eventTarget(current);
          }
          if (!current) {
            throw new NotFoundException('Invitation not found');
          }
          if (current.status !== 'pending') {
            throw new HttpException(`Cannot reject invitation with status '${current.status}'`, HttpStatus.BAD_REQUEST);
          }
          const rejected = await this.repository.updateStatus(invitationId, 'rejected', tx);
          await this.recordEvent(tx, { ...INVITATION_REJECTED, ...target, invitationId });
          return rejected;
        }),
    );
    return this.mapInvitation(updated);
  }

  async cancelInvitation(invitationId: string): Promise<Invitation> {
    const handle = this.contextService.requirePermission('invitation', 'delete');

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
      const canceled = await this.repository.updateStatus(invitationId, 'canceled', tx);
      await this.recordEvent(tx, { ...INVITATION_CANCELLED, ...eventTarget(current), invitationId });
      return canceled;
    });
    this.supersede(handle);
    return this.mapInvitation(updated);
  }
}
