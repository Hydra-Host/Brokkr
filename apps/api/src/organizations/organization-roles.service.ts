import { ForbiddenException, Injectable } from '@nestjs/common';
import { RbacService } from '@repo/auth/rbac';
import type { Prisma } from '@repo/database';
import { AuthType } from 'src/auth/identity-context';
import { ContextService, type PermissionIntentHandle } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { EventLogService } from 'src/event-log/event-log.service';
import type { EventLogMetadata } from 'src/event-log/event-log.types';
import { LoggerService } from 'src/logger/logger.service';

interface RoleEvent {
  resource: string;
  action: string;
  actionKey: string;
  targetId: string;
  targetLabel?: string | null;
  metadata?: EventLogMetadata;
}

@Injectable()
export class OrganizationRolesService {
  constructor(
    private readonly contextService: ContextService,
    private readonly rbacService: RbacService,
    private readonly eventLog: EventLogService,
    @Logger(OrganizationRolesService.name) private readonly logger: LoggerService,
  ) {}

  list() {
    return this.rbacService.listOrganizationRoles(this.contextService.organizationId);
  }

  getById(roleId: string) {
    return this.rbacService.getRoleById(roleId, this.contextService.organizationId);
  }

  async createCustom(data: {
    name: string;
    slug: string;
    description?: string;
    permissions: string[];
    templateId?: string;
  }) {
    const handle = this.contextService.requirePermission('member', 'change-role');
    const result = await this.rbacService.createCustomRole(
      this.contextService.organizationId,
      data,
      this.contextService.permissions,
      this.emitForCreatedRole(data.slug, data.name),
    );
    this.supersede(handle);
    return result;
  }

  async cloneSystemRole(args: { systemRoleId: string; name: string; slug: string }) {
    const handle = this.contextService.requirePermission('member', 'change-role');
    const result = await this.rbacService.cloneSystemRole(
      this.contextService.organizationId,
      args.systemRoleId,
      args.name,
      args.slug,
      this.contextService.permissions,
      this.emitForCreatedRole(args.slug, args.name, { clonedFromRoleId: args.systemRoleId }),
    );
    this.supersede(handle);
    return result;
  }

  async updatePermissions(roleId: string, permissions: string[]) {
    const handle = this.contextService.requirePermission('member', 'change-role');
    const result = await this.rbacService.updateRolePermissions(
      roleId,
      permissions,
      this.contextService.organizationId,
      this.contextService.permissions,
      // A role's permission set changing is a privilege change, not a member role change —
      // `member:change-role` gates both, so the label cannot be derived from the permission.
      this.emitForRole(roleId, {
        resource: 'role',
        action: 'permissions-changed',
        actionKey: 'role.permissions-changed',
        metadata: { grantedKeys: [...permissions].sort() },
      }),
    );
    this.supersede(handle);
    return result;
  }

  async archiveCustom(roleId: string) {
    const handle = this.contextService.requirePermission('member', 'change-role');
    const result = await this.rbacService.archiveCustomRole(
      roleId,
      this.contextService.organizationId,
      this.contextService.permissions,
      this.emitForRole(roleId, { resource: 'role', action: 'archived', actionKey: 'role.archived' }),
    );
    this.supersede(handle);
    this.logger.log(
      JSON.stringify({
        action: 'archive-role',
        roleId,
        organizationId: this.contextService.organizationId,
        ...this.contextService.buildAuditPayload(),
      }),
    );
    return result;
  }

  listPermissions() {
    return this.rbacService.listAllPermissions();
  }

  async assignToMember(memberId: string, roleId: string) {
    const handle = this.contextService.requirePermission('member', 'change-role');
    const result = await this.rbacService.assignRoleToMember(
      this.contextService.organizationId,
      memberId,
      roleId,
      { userId: this.contextService.userId, permissions: this.contextService.permissions },
      this.emitFor({
        resource: 'member',
        action: 'role-changed',
        actionKey: 'member.role-changed',
        targetId: memberId,
        metadata: { assignedRoleId: roleId },
      }),
    );
    this.supersede(handle);
    return result;
  }

  async grantOwnerAccess(memberId: string, roleId: string) {
    const handle = this.requireOwnerSession();
    const result = await this.rbacService.grantOwnerAccess(
      this.contextService.organizationId,
      memberId,
      roleId,
      this.contextService.permissions,
      this.emitFor({
        resource: 'organization',
        action: 'owner-granted',
        actionKey: 'organization.owner-granted',
        targetId: memberId,
        metadata: { ownerRoleId: roleId },
      }),
    );
    this.supersede(handle);
    this.logOwnerAudit('grant-owner-access', { memberId, roleId });
    return result;
  }

  async revokeOwnerAccess(memberId: string, replacementRoleId: string) {
    const handle = this.requireOwnerSession();
    const result = await this.rbacService.revokeOwnerAccess(
      this.contextService.organizationId,
      memberId,
      replacementRoleId,
      this.contextService.permissions,
      this.emitFor({
        resource: 'organization',
        action: 'owner-revoked',
        actionKey: 'organization.owner-revoked',
        targetId: memberId,
        metadata: { replacementRoleId },
      }),
    );
    this.supersede(handle);
    this.logOwnerAudit('revoke-owner-access', { memberId, replacementRoleId });
    return result;
  }

  async transferOwnership(data: {
    sourceMemberId: string;
    recipientMemberId: string;
    ownerRoleId: string;
    sourceReplacementRoleId: string;
  }) {
    const handle = this.requireOwnerSession();
    const result = await this.rbacService.transferOwnership(
      this.contextService.organizationId,
      data.sourceMemberId,
      data.recipientMemberId,
      data.ownerRoleId,
      data.sourceReplacementRoleId,
      this.contextService.permissions,
      // One row, not two: the recipient is the target and the source goes in metadata.
      this.emitFor({
        resource: 'organization',
        action: 'ownership-transferred',
        actionKey: 'organization.ownership-transferred',
        targetId: data.recipientMemberId,
        metadata: {
          sourceMembershipId: data.sourceMemberId,
          sourceReplacementRoleId: data.sourceReplacementRoleId,
          ownerRoleId: data.ownerRoleId,
        },
      }),
    );
    this.supersede(handle);
    this.logOwnerAudit('transfer-ownership', data);
    return result;
  }

  /** A create has no id until it runs, so the row is resolved inside the same transaction — a slug would not
   *  join to the role's later events, which key on the UUID. */
  private emitForCreatedRole(
    slug: string,
    name: string,
    metadata?: EventLogMetadata,
  ): (tx: Prisma.TransactionClient) => Promise<void> {
    const organizationId = this.contextService.organizationId;
    return async (tx) => {
      const created = await tx.organizationMemberRole.findUniqueOrThrow({
        where: { slug_organizationId: { slug, organizationId } },
        select: { id: true },
      });
      await this.emitFor({
        resource: 'role',
        action: 'created',
        actionKey: 'role.created',
        targetId: created.id,
        targetLabel: name,
        metadata,
      })(tx);
    };
  }

  /** Reads the name inside the mutation's own transaction, so the row is labelled as the role stood at the time. */
  private emitForRole(
    roleId: string,
    event: Omit<RoleEvent, 'targetId' | 'targetLabel'>,
  ): (tx: Prisma.TransactionClient) => Promise<void> {
    return async (tx) => {
      const role = await tx.organizationMemberRole.findUnique({ where: { id: roleId }, select: { name: true } });
      await this.emitFor({ ...event, targetId: roleId, targetLabel: role?.name ?? null })(tx);
    };
  }

  /** Runs inside RbacService's own transaction, so the event and the mutation commit or roll back together. */
  private emitFor(event: RoleEvent): (tx: Prisma.TransactionClient) => Promise<void> {
    const organizationId = this.contextService.organizationId;
    const actor = this.contextService.actorFields();
    const request = this.contextService.requestFields();
    const requestId = this.contextService.requestId ?? null;

    return (tx) =>
      this.eventLog.recordInTransaction(tx, {
        organizationId,
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        resource: event.resource,
        action: event.action,
        actionKey: event.actionKey,
        ...actor,
        ...request,
        targetId: event.targetId,
        targetLabel: event.targetLabel ?? null,
        outcome: 'SUCCEEDED',
        requestId,
        ...(event.metadata ? { metadata: event.metadata } : {}),
      });
  }

  /** Called after the mutation resolves: a rollback leaves the handle pending so tier 2 records the failure. */
  private supersede(handle: PermissionIntentHandle | undefined): void {
    if (handle) this.contextService.finalizeIntents([handle]);
  }

  /** Records its own intent because it gates without a permission check — otherwise a refused
   *  attempt on the highest-privilege operation in the app would leave no row at all. */
  private requireOwnerSession(): PermissionIntentHandle | undefined {
    const apiKey = this.contextService.requireIdentity.authType === AuthType.ApiKey;
    const denied = apiKey || !this.rbacService.isOwnerCapable(this.contextService.permissions);
    const handle = this.contextService.pushIntent('organization', 'manage-owners', denied);
    if (apiKey) {
      throw new ForbiddenException('Owner management requires a browser session');
    }
    if (denied) {
      throw new ForbiddenException('Owner management requires an owner-capable identity');
    }
    return handle;
  }

  private logOwnerAudit(action: string, details: Record<string, string>): void {
    this.logger.log(JSON.stringify({ action, ...details, ...this.contextService.buildAuditPayload() }));
  }
}
