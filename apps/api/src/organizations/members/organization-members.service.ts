import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { OrganizationMembersQuery } from '@repo/api-client';
import { MAIN_APP_PERMISSIONS, RbacService, roleBelongsToCatalog, type RolePermissionSource } from '@repo/auth/rbac';
import { OrganizationMembershipRole } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { OrganizationMembershipsRepository } from './organization-members.repository';

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
    if (!isSelfRemoval) {
      this.contextService.requirePermission('member', 'delete');
    }
    this.rbacService.assertOrdinaryMemberActionAllowed(
      { userId: this.contextService.userId, permissions: this.contextService.permissions },
      membership,
    );
    const targetRole = roleBelongsToCatalog(MAIN_APP_PERMISSIONS, membership.assignedRole)
      ? membership.assignedRole.name
      : 'managed';

    const deletedMembership = await this.membershipsRepository.delete(organizationMembershipId);

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
    this.contextService.requirePermission('member', 'change-role');
    const organizationId = this.contextService.organizationId;
    const roleId = await this.membershipsRepository.requireSystemRoleId(data.role);
    await this.rbacService.assignRoleToMember(organizationId, organizationMembershipId, roleId, {
      userId: this.contextService.userId,
      permissions: this.contextService.permissions,
    });
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
}
