import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { OrganizationMembersQuery } from '@repo/api-client';
import { MAIN_APP_PERMISSIONS, RbacService, roleBelongsToCatalog, type RolePermissionSource } from '@repo/auth/rbac';
import { OrganizationMembershipRole, type Prisma } from '@repo/database';
import { ContextService, type PermissionIntentHandle } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { EventLogService } from 'src/event-log/event-log.service';
import type { EventLogMetadata } from 'src/event-log/event-log.types';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { OrganizationMembershipsRepository } from './organization-members.repository';

const MEMBER_REMOVED = { resource: 'member', action: 'removed', actionKey: 'member.removed' };
const MEMBER_ROLE_CHANGED = { resource: 'member', action: 'role-changed', actionKey: 'member.role-changed' };

interface MemberEvent {
  resource: string;
  action: string;
  actionKey: string;
  membershipId: string;
  email: string;
  metadata?: EventLogMetadata;
}

function projectRole<
  T extends {
    role: OrganizationMembershipRole;
    assignedRoleId: string;
    assignedRole: { name: string } & RolePermissionSource;
  },
>(member: T) {
  const { assignedRole, role: _legacyRole, ...rest } = member;
  const visible = roleBelongsToCatalog(MAIN_APP_PERMISSIONS, assignedRole);
  return {
    ...rest,
    role: visible ? assignedRole.name : 'Managed role',
    assignedRoleId: visible ? member.assignedRoleId : null,
  };
}

@Injectable()
export class OrganizationMembershipsService {
  constructor(
    private readonly membershipsRepository: OrganizationMembershipsRepository,
    private readonly contextService: ContextService,
    private readonly rbacService: RbacService,
    @Inject(PLUGIN_EVENT_BUS)
    private readonly eventBus: PluginEventBus,
    private readonly eventLog: EventLogService,
    private readonly prisma: PrismaClient,
    @Logger(OrganizationMembershipsService.name) private readonly logger: LoggerService,
  ) {}

  async create(organizationId: string, userId: string, role: OrganizationMembershipRole) {
    const assignedRoleId = await this.membershipsRepository.requireSystemRoleId(role);
    return this.membershipsRepository.create(organizationId, userId, role, assignedRoleId);
  }

  async getOrganizationMemberships(query: OrganizationMembersQuery) {
    this.contextService.requirePermission('member', 'read');
    const organizationId = this.contextService.organizationId;
    const result = await this.membershipsRepository.findByOrganizationIdPaginated(organizationId, query);
    return { ...result, data: result.data.map(projectRole) };
  }

  async getOrganizationMembershipsByUserId(userId: string) {
    return this.membershipsRepository.findByUserId(userId);
  }

  async removeOrganizationMembership(organizationMembershipId: string) {
    const organizationId = this.contextService.organizationId;
    const membership = await this.membershipsRepository.findByIdAndOrganizationId(
      organizationMembershipId,
      organizationId,
    );

    if (!membership) {
      throw new NotFoundException('Organization membership not found');
    }

    const isSelfRemoval = membership.userId === this.contextService.userId;
    // A member leaving needs no permission, but still records an intent: without one the interceptor
    // mints a synthetic row beside the tier 1 evidence, and a failed departure would go unrecorded.
    const handle = isSelfRemoval
      ? this.contextService.pushIntent('member', 'delete', false)
      : this.contextService.requirePermission('member', 'delete');
    this.rbacService.assertOrdinaryMemberActionAllowed(
      { userId: this.contextService.userId, permissions: this.contextService.permissions },
      membership,
    );
    const targetRole = roleBelongsToCatalog(MAIN_APP_PERMISSIONS, membership.assignedRole)
      ? membership.assignedRole.name
      : 'managed';

    const deletedMembership = await this.prisma.$transaction(async (tx) => {
      const deleted = await this.membershipsRepository.delete(organizationMembershipId, tx);
      await this.recordEvent(tx, {
        ...MEMBER_REMOVED,
        membershipId: organizationMembershipId,
        email: deleted.user.email,
        metadata: { userId: deleted.userId },
      });
      return deleted;
    });
    this.supersede(handle);

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `Member ${deletedMembership.userId} (membership=${organizationMembershipId}, role=${targetRole}) removed from org ${deletedMembership.organizationId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    this.eventBus.emit('member.removed', {
      organizationId: deletedMembership.organizationId,
      userId: deletedMembership.userId,
      email: deletedMembership.user.email,
    });

    return projectRole(deletedMembership);
  }

  async getOrganizationMembershipById(memberId: string) {
    this.contextService.requirePermission('member', 'read');
    const organizationId = this.contextService.organizationId;
    const membership = await this.membershipsRepository.findByIdAndOrganizationIdLean(memberId, organizationId);

    if (!membership) {
      throw new NotFoundException('Organization membership not found');
    }

    return projectRole(membership);
  }

  async updateOrganizationMembershipRole(organizationMembershipId: string, data: { role: OrganizationMembershipRole }) {
    const handle = this.contextService.requirePermission('member', 'change-role');
    const organizationId = this.contextService.organizationId;
    const roleId = await this.membershipsRepository.requireSystemRoleId(data.role);
    // The emit is handed to RbacService rather than run here, so this endpoint and the roles-service
    // one it shares `member.role-changed` with each produce exactly one row, inside the same transaction.
    await this.rbacService.assignRoleToMember(
      organizationId,
      organizationMembershipId,
      roleId,
      {
        userId: this.contextService.userId,
        permissions: this.contextService.permissions,
      },
      (tx) => this.emitRoleChanged(tx, organizationMembershipId, roleId),
    );
    this.supersede(handle);
    const updated = await this.membershipsRepository.findByIdAndOrganizationId(
      organizationMembershipId,
      organizationId,
    );
    if (!updated) {
      throw new NotFoundException('Organization membership not found');
    }
    return projectRole(updated);
  }

  async getOrganizationMembershipByUserIdAndOrganizationId(userId: string) {
    const organizationId = this.contextService.organizationId;
    const membership = await this.membershipsRepository.findByUserIdAndOrganizationId(userId, organizationId);

    if (!membership) {
      throw new NotFoundException('Organization membership not found');
    }

    return membership;
  }

  async setDefaultOrganization(userId: string, organizationId: string) {
    const membership = await this.membershipsRepository.setDefaultOrganization(userId, organizationId);
    if (!membership) {
      throw new NotFoundException('Organization membership not found');
    }
    return {
      userId: membership.userId,
      organizationId: membership.organizationId,
      role: !roleBelongsToCatalog(MAIN_APP_PERMISSIONS, membership.assignedRole)
        ? 'Managed role'
        : membership.assignedRole.name,
      isDefaultOrg: membership.isDefaultOrg ?? true,
    };
  }

  async getMembersForAnOrganization(organizationId: string) {
    return this.membershipsRepository.findByOrganizationId(organizationId);
  }

  /** Reads the member inside the mutation's own transaction, so the row is labelled as the membership
   *  stood at the time; the update that precedes this emit already proved the row exists. */
  private async emitRoleChanged(tx: Prisma.TransactionClient, membershipId: string, roleId: string): Promise<void> {
    const member = await tx.member.findUniqueOrThrow({
      where: { id: membershipId },
      select: { userId: true, user: { select: { email: true } } },
    });
    await this.recordEvent(tx, {
      ...MEMBER_ROLE_CHANGED,
      membershipId,
      email: member.user.email,
      metadata: { userId: member.userId, assignedRoleId: roleId },
    });
  }

  /** The membership id is the target because it is what the endpoint addresses; `userId` rides in metadata
   *  because a membership id dies with the membership, and re-inviting the same person mints a new one. */
  private recordEvent(tx: Prisma.TransactionClient, event: MemberEvent): Promise<void> {
    return this.eventLog.recordInTransaction(tx, {
      organizationId: this.contextService.organizationId,
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      resource: event.resource,
      action: event.action,
      actionKey: event.actionKey,
      ...this.contextService.actorFields(),
      ...this.contextService.requestFields(),
      targetId: event.membershipId,
      targetLabel: event.email,
      outcome: 'SUCCEEDED',
      requestId: this.contextService.requestId ?? null,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
  }

  /** Called after the mutation resolves: a rollback leaves the handle pending so tier 2 records the failure. */
  private supersede(handle: PermissionIntentHandle | undefined): void {
    if (handle) this.contextService.finalizeIntents([handle]);
  }
}
