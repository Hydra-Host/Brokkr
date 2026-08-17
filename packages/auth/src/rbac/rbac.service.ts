import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@repo/database';
import { RBAC_CONFIG } from './constants';
import { PRISMA_CLIENT } from './rbac-resolver.service';
import type { RbacConfig, RolePermissionSource, TransactionEmit } from './types';
import {
  isOwnerCapable,
  OWNER_MANAGEMENT_PERMISSION,
  ownerManagementLockKey,
  permissionKey,
  permissionsBelongToCatalog,
  roleBelongsToCatalog as permissionsOfRoleBelongToCatalog,
  rolePermissionKeys,
  strictlyDominates,
} from './types';

const MAX_CUSTOM_ROLES_PER_ORG = 20;

const rolePermissionsInclude = {
  rolePermissions: { include: { permission: true } },
} satisfies Prisma.OrganizationMemberRoleInclude;

type RoleWithPermissions = Prisma.OrganizationMemberRoleGetPayload<{ include: typeof rolePermissionsInclude }>;

const memberRoleInclude = {
  assignedRole: { include: { rolePermissions: { include: { permission: true } } } },
  user: { select: { banned: true, banExpires: true } },
} satisfies Prisma.MemberInclude;

type MemberWithRole = Prisma.MemberGetPayload<{ include: typeof memberRoleInclude }>;

@Injectable()
export class RbacService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(RBAC_CONFIG) private readonly config: RbacConfig,
  ) {}

  /** Projected, not returned raw: `audit` is internal capture configuration and the contract schema for this
   *  endpoint does not declare it, so returning the catalog verbatim would leak it to every client. */
  listAllPermissions(): { resource: string; action: string; description: string }[] {
    return this.config.permissions.map(({ resource, action, description }) => ({ resource, action, description }));
  }

  listSystemRoleDefinitions() {
    return this.config.systemRoles.filter((role) =>
      permissionsBelongToCatalog(this.config.permissions, role.permissions),
    );
  }

  async listOrganizationRoles(organizationId: string) {
    const now = new Date();
    const roles = await this.prisma.organizationMemberRole.findMany({
      where: {
        archivedAt: null,
        OR: [{ organizationId }, { isSystem: true, organizationId: null }],
      },
      include: {
        rolePermissions: { include: { permission: true } },
        _count: {
          select: {
            members: { where: { organizationId, deletedAt: null } },
            invitations: { where: { organizationId, status: 'pending', expiresAt: { gt: now } } },
          },
        },
      },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return roles
      .filter((role) => this.roleBelongsToCatalog(role))
      .map((role) => ({ ...role, isOwnerCapable: this.roleIsOwnerCapable(role) }));
  }

  async getRoleById(roleId: string, organizationId: string, tx?: Prisma.TransactionClient) {
    const now = new Date();
    const role = await (tx ?? this.prisma).organizationMemberRole.findUnique({
      where: { id: roleId },
      include: {
        rolePermissions: { include: { permission: true } },
        _count: {
          select: {
            members: { where: { organizationId, deletedAt: null } },
            invitations: { where: { organizationId, status: 'pending', expiresAt: { gt: now } } },
          },
        },
      },
    });
    if (
      !role ||
      role.archivedAt ||
      (role.organizationId !== null && role.organizationId !== organizationId) ||
      !this.roleBelongsToCatalog(role)
    ) {
      throw new NotFoundException('Role not found');
    }
    return { ...role, isOwnerCapable: this.roleIsOwnerCapable(role) };
  }

  assertRoleAssignableBy(
    role: RolePermissionSource,
    actorPermissions: ReadonlySet<string>,
    allowOwner = false,
    rolePermissions = rolePermissionKeys(role),
  ): void {
    this.assertRoleVisible(role);
    const ownerCapable = this.isOwnerCapable(rolePermissions);
    if (ownerCapable && !allowOwner) {
      throw new ForbiddenException('Owner-capable roles require the dedicated owner-management flow');
    }
    if (ownerCapable && !this.isOwnerCapable(actorPermissions)) {
      throw new ForbiddenException('Only an owner-capable identity can grant owner access');
    }
    this.assertPermissionsWithinActor(actorPermissions, rolePermissions);
  }

  canAssignRoleBy(role: RolePermissionSource, actorPermissions: ReadonlySet<string>, allowOwner = false): boolean {
    try {
      this.assertRoleAssignableBy(role, actorPermissions, allowOwner);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        return false;
      }
      throw error;
    }
  }

  assertRoleManageableBy(
    role: RolePermissionSource,
    actorPermissions: ReadonlySet<string>,
    rolePermissions = rolePermissionKeys(role),
  ): void {
    this.assertRoleAssignableBy(role, actorPermissions, true, rolePermissions);
  }

  isOwnerCapable(permissions: Iterable<string>): boolean {
    return isOwnerCapable(this.config.permissions, permissions);
  }

  assertOrdinaryMemberActionAllowed(
    actor: { userId: string; permissions: ReadonlySet<string> },
    target: {
      userId: string;
      assignedRole: RolePermissionSource;
    },
  ): void {
    this.assertRoleVisible(target.assignedRole);
    if (this.roleIsOwnerCapable(target.assignedRole)) {
      throw new ForbiddenException('Owner-capable members require the dedicated owner-management flow');
    }
    if (
      target.userId !== actor.userId &&
      !strictlyDominates(this.config.permissions, actor.permissions, rolePermissionKeys(target.assignedRole))
    ) {
      throw new ForbiddenException('Cannot manage a member whose permissions you do not strictly dominate');
    }
  }

  canPerformOrdinaryMemberAction(
    actor: { userId: string; permissions: ReadonlySet<string> },
    target: { userId: string; assignedRole: RolePermissionSource },
  ): boolean {
    try {
      this.assertOrdinaryMemberActionAllowed(actor, target);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        return false;
      }
      throw error;
    }
  }

  async createCustomRole(
    organizationId: string,
    data: { name: string; slug: string; description?: string; permissions: string[]; templateId?: string },
    actorPermissions: ReadonlySet<string>,
    emit?: TransactionEmit,
  ) {
    const existingSlug = await this.prisma.organizationMemberRole.findUnique({
      where: { slug_organizationId: { slug: data.slug, organizationId } },
    });
    if (existingSlug) {
      throw new BadRequestException(`Role slug "${data.slug}" already exists in this organization`);
    }

    this.validatePermissionKeys(data.permissions);
    this.assertPermissionsWithinActor(actorPermissions, data.permissions);
    this.assertOwnerPermissionShape(data.permissions, actorPermissions);
    if (data.templateId) {
      const template = await this.requireVisibleSystemRole(data.templateId);
      this.assertRoleManageableBy(template, actorPermissions);
    }

    const permissionRecords = await this.resolvePermissionRecords(data.permissions);

    return this.createCustomRoleUnderCapacityLock(
      organizationId,
      {
        name: data.name,
        slug: data.slug,
        description: data.description,
        isSystem: false,
        organizationId,
        templateId: data.templateId,
        rolePermissions: {
          create: permissionRecords.map((perm) => ({ permissionId: perm.id })),
        },
      },
      emit,
    );
  }

  async cloneSystemRole(
    organizationId: string,
    systemRoleId: string,
    name: string,
    slug: string,
    actorPermissions: ReadonlySet<string>,
    emit?: TransactionEmit,
  ) {
    const systemRole = await this.prisma.organizationMemberRole.findUnique({
      where: { id: systemRoleId },
      include: { rolePermissions: { include: { permission: true } } },
    });
    if (
      !systemRole ||
      systemRole.archivedAt ||
      !systemRole.isSystem ||
      systemRole.organizationId !== null ||
      !this.roleBelongsToCatalog(systemRole)
    ) {
      throw new NotFoundException('System role not found');
    }

    const sourcePermissions = rolePermissionKeys(systemRole);
    this.assertRoleManageableBy(systemRole, actorPermissions, sourcePermissions);
    this.assertOwnerPermissionShape(sourcePermissions, actorPermissions);

    const existingSlug = await this.prisma.organizationMemberRole.findUnique({
      where: { slug_organizationId: { slug, organizationId } },
    });
    if (existingSlug) {
      throw new BadRequestException(`Role slug "${slug}" already exists in this organization`);
    }

    return this.createCustomRoleUnderCapacityLock(
      organizationId,
      {
        name,
        slug,
        description: `Custom role based on ${systemRole.name}`,
        isSystem: false,
        organizationId,
        templateId: systemRoleId,
        rolePermissions: {
          create: systemRole.rolePermissions.map((rp) => ({ permissionId: rp.permissionId })),
        },
      },
      emit,
    );
  }

  async updateCustomRoleMetadata(
    roleId: string,
    organizationId: string,
    data: { name?: string; description?: string | null },
    actorPermissions: ReadonlySet<string>,
  ) {
    return this.withOwnerLock(organizationId, async (tx) => {
      const role = await tx.organizationMemberRole.findUnique({
        where: { id: roleId },
        select: {
          id: true,
          archivedAt: true,
          isSystem: true,
          organizationId: true,
          rolePermissions: {
            select: {
              permissionId: true,
              permission: { select: { resource: true, action: true } },
            },
          },
        },
      });
      if (
        !role ||
        role.archivedAt ||
        (role.organizationId !== null && role.organizationId !== organizationId) ||
        !this.roleBelongsToCatalog(role)
      ) {
        throw new NotFoundException('Role not found');
      }
      if (role.isSystem || role.organizationId !== organizationId) {
        throw new ForbiddenException('System roles cannot be modified');
      }
      this.assertRoleManageableBy(role, actorPermissions);
      const updated = await tx.organizationMemberRole.update({
        where: { id: roleId },
        data,
        include: {
          rolePermissions: { include: { permission: true } },
          _count: {
            select: {
              members: { where: { organizationId, deletedAt: null } },
              invitations: {
                where: { organizationId, status: 'pending', expiresAt: { gt: new Date() } },
              },
            },
          },
        },
      });
      return { ...updated, isOwnerCapable: this.roleIsOwnerCapable(updated) };
    });
  }

  async updateRolePermissions(
    roleId: string,
    permissions: string[],
    organizationId: string,
    actorPermissions: ReadonlySet<string>,
    emit?: TransactionEmit,
  ) {
    const role = await this.prisma.organizationMemberRole.findUnique({
      where: { id: roleId },
      include: rolePermissionsInclude,
    });
    if (
      !role ||
      role.archivedAt ||
      (role.organizationId !== null && role.organizationId !== organizationId) ||
      !this.roleBelongsToCatalog(role)
    ) {
      throw new NotFoundException('Role not found');
    }
    if (role.isSystem) {
      throw new ForbiddenException('Cannot modify system role permissions');
    }
    if (!role.organizationId) {
      throw new ForbiddenException('Cannot modify a role without an organization');
    }

    this.assertRoleManageableBy(role, actorPermissions);
    this.validatePermissionKeys(permissions);
    this.assertPermissionsWithinActor(actorPermissions, permissions);
    this.assertOwnerPermissionShape(permissions, actorPermissions);
    if (this.roleIsOwnerCapable(role) !== this.isOwnerCapable(permissions)) {
      throw new ForbiddenException('Role owner capability can only change through dedicated owner-management flows');
    }

    const permissionRecords = await this.resolvePermissionRecords(permissions);

    // Only replace grants within this instance's catalog: grants from another instance's superset catalog must survive a save untouched.
    const catalogKeys = this.catalogKeys();
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.rolePermission.findMany({
        where: { roleId },
        include: { permission: { select: { resource: true, action: true } } },
      });
      const replaceableIds = existing
        .filter((rp) => catalogKeys.has(permissionKey(rp.permission.resource, rp.permission.action)))
        .map((rp) => rp.permissionId);
      await tx.rolePermission.deleteMany({ where: { roleId, permissionId: { in: replaceableIds } } });
      await tx.rolePermission.createMany({
        data: permissionRecords.map((perm) => ({ roleId, permissionId: perm.id })),
        skipDuplicates: true,
      });
      await emit?.(tx);
    });

    return this.getRoleById(roleId, organizationId);
  }

  /** Permissions replace + metadata update in one transaction; catalog-scoped replacement as in updateRolePermissions. */
  async updateRolePermissionsAndMetadata(
    roleId: string,
    organizationId: string,
    data: { permissions?: string[]; name?: string; description?: string | null },
    actorPermissions: ReadonlySet<string>,
  ) {
    if (data.permissions) {
      this.validatePermissionKeys(data.permissions);
      this.assertPermissionsWithinActor(actorPermissions, data.permissions);
      this.assertOwnerPermissionShape(data.permissions, actorPermissions);
    }
    const permissionRecords = data.permissions ? await this.resolvePermissionRecords(data.permissions) : null;
    const catalogKeys = this.catalogKeys();

    return this.withOwnerLock(organizationId, async (tx) => {
      const role = await tx.organizationMemberRole.findUnique({
        where: { id: roleId },
        include: rolePermissionsInclude,
      });
      if (
        !role ||
        role.archivedAt ||
        (role.organizationId !== null && role.organizationId !== organizationId) ||
        !this.roleBelongsToCatalog(role)
      ) {
        throw new NotFoundException('Role not found');
      }
      if (role.isSystem || role.organizationId !== organizationId) {
        throw new ForbiddenException('System roles cannot be modified');
      }
      this.assertRoleManageableBy(role, actorPermissions);

      if (data.permissions && permissionRecords) {
        if (this.roleIsOwnerCapable(role) !== this.isOwnerCapable(data.permissions)) {
          throw new ForbiddenException(
            'Role owner capability can only change through dedicated owner-management flows',
          );
        }
        const replaceableIds = role.rolePermissions
          .filter((rp) => catalogKeys.has(permissionKey(rp.permission.resource, rp.permission.action)))
          .map((rp) => rp.permissionId);
        await tx.rolePermission.deleteMany({ where: { roleId, permissionId: { in: replaceableIds } } });
        await tx.rolePermission.createMany({
          data: permissionRecords.map((perm) => ({ roleId, permissionId: perm.id })),
          skipDuplicates: true,
        });
      }

      const updated = await tx.organizationMemberRole.update({
        where: { id: roleId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
        },
        include: {
          rolePermissions: { include: { permission: true } },
          _count: {
            select: {
              members: { where: { organizationId, deletedAt: null } },
              invitations: {
                where: { organizationId, status: 'pending', expiresAt: { gt: new Date() } },
              },
            },
          },
        },
      });
      return { ...updated, isOwnerCapable: this.roleIsOwnerCapable(updated) };
    });
  }

  async archiveCustomRole(
    roleId: string,
    organizationId: string,
    actorPermissions: ReadonlySet<string>,
    emit?: TransactionEmit,
  ) {
    return this.withOwnerLock(organizationId, async (tx) => {
      const now = new Date();
      const role = await tx.organizationMemberRole.findUnique({
        where: { id: roleId },
        include: {
          rolePermissions: { include: { permission: true } },
          _count: {
            select: {
              members: { where: { organizationId, deletedAt: null } },
              invitations: { where: { organizationId, status: 'pending', expiresAt: { gt: now } } },
            },
          },
        },
      });
      if (
        !role ||
        role.archivedAt ||
        (role.organizationId !== null && role.organizationId !== organizationId) ||
        !this.roleBelongsToCatalog(role)
      ) {
        throw new NotFoundException('Role not found');
      }
      if (role.isSystem) {
        throw new ForbiddenException('Cannot archive system roles');
      }
      this.assertRoleManageableBy(role, actorPermissions);
      if (role._count.members > 0) {
        throw new BadRequestException(
          `Cannot archive role "${role.name}" — ${role._count.members} active member(s) are still assigned to it. Reassign them first.`,
        );
      }
      if (role._count.invitations > 0) {
        throw new BadRequestException(
          `Cannot archive role "${role.name}" — ${role._count.invitations} pending invitation(s) still reference it.`,
        );
      }
      const archived = await tx.organizationMemberRole.update({
        where: { id: roleId },
        data: { archivedAt: now },
      });
      await emit?.(tx);
      return archived;
    });
  }

  async assignRoleToMember(
    organizationId: string,
    memberId: string,
    roleId: string,
    actor: { userId: string; permissions: ReadonlySet<string> },
    emit?: TransactionEmit,
  ) {
    return this.withOwnerLock(organizationId, async (tx) => {
      const [member, role] = await Promise.all([this.loadMember(tx, memberId), this.loadRole(tx, roleId)]);
      this.assertOrdinaryAssignmentAllowed(organizationId, member, role, actor);

      const updated = await tx.member.update({
        where: { id: memberId },
        data: { assignedRoleId: roleId },
        include: memberRoleInclude,
      });
      await emit?.(tx);
      return updated;
    });
  }

  async grantOwnerAccess(
    organizationId: string,
    memberId: string,
    ownerRoleId: string,
    actorPermissions: ReadonlySet<string>,
    emit?: TransactionEmit,
  ) {
    this.assertOwnerCapableActor(actorPermissions);
    return this.withOwnerLock(organizationId, async (tx) => {
      const member = await this.loadMember(tx, memberId);
      const ownerRole = await this.loadRole(tx, ownerRoleId);
      this.assertMemberInOrganization(member, organizationId);
      this.assertRoleInOrganization(ownerRole, organizationId);
      this.assertMemberCanReceiveOwner(member);
      if (!this.roleIsOwnerCapable(ownerRole)) {
        throw new BadRequestException('Selected role is not owner-capable');
      }
      this.assertRoleAssignableBy(ownerRole, actorPermissions, true);
      if (this.roleIsOwnerCapable(member.assignedRole)) {
        throw new BadRequestException('Member already has owner access');
      }
      const granted = await tx.member.update({
        where: { id: memberId },
        data: { assignedRoleId: ownerRoleId },
        include: memberRoleInclude,
      });
      await emit?.(tx);
      return granted;
    });
  }

  async revokeOwnerAccess(
    organizationId: string,
    memberId: string,
    replacementRoleId: string,
    actorPermissions: ReadonlySet<string>,
    emit?: TransactionEmit,
  ) {
    this.assertOwnerCapableActor(actorPermissions);
    return this.withOwnerLock(organizationId, async (tx) => {
      const member = await this.loadMember(tx, memberId);
      const replacementRole = await this.loadRole(tx, replacementRoleId);
      this.assertMemberInOrganization(member, organizationId);
      this.assertRoleInOrganization(replacementRole, organizationId);
      this.assertCurrentOwner(member);
      this.assertNonOwnerRole(replacementRole);
      this.assertRoleAssignableBy(replacementRole, actorPermissions);
      if (!this.userIsBanned(member.user) && (await this.countOwnerCapableMembers(tx, organizationId)) <= 1) {
        throw new BadRequestException('Cannot remove the last owner-capable member');
      }
      const revoked = await tx.member.update({
        where: { id: memberId },
        data: { assignedRoleId: replacementRoleId },
        include: memberRoleInclude,
      });
      await emit?.(tx);
      return revoked;
    });
  }

  async transferOwnership(
    organizationId: string,
    sourceMemberId: string,
    recipientMemberId: string,
    ownerRoleId: string,
    sourceReplacementRoleId: string,
    actorPermissions: ReadonlySet<string>,
    emit?: TransactionEmit,
  ) {
    this.assertOwnerCapableActor(actorPermissions);
    if (sourceMemberId === recipientMemberId) {
      throw new BadRequestException('Source and recipient must be different members');
    }
    return this.withOwnerLock(organizationId, async (tx) => {
      const [source, recipient, ownerRole, replacementRole] = await Promise.all([
        this.loadMember(tx, sourceMemberId),
        this.loadMember(tx, recipientMemberId),
        this.loadRole(tx, ownerRoleId),
        this.loadRole(tx, sourceReplacementRoleId),
      ]);
      this.assertMemberInOrganization(source, organizationId);
      this.assertMemberInOrganization(recipient, organizationId);
      this.assertRoleInOrganization(ownerRole, organizationId);
      this.assertRoleInOrganization(replacementRole, organizationId);
      this.assertCurrentOwner(source);
      this.assertMemberCanReceiveOwner(recipient);
      if (this.roleIsOwnerCapable(recipient.assignedRole)) {
        throw new BadRequestException('Recipient already has owner access');
      }
      if (!this.roleIsOwnerCapable(ownerRole)) {
        throw new BadRequestException('Selected owner role is not owner-capable');
      }
      this.assertNonOwnerRole(replacementRole);
      this.assertRoleAssignableBy(ownerRole, actorPermissions, true);
      this.assertRoleAssignableBy(replacementRole, actorPermissions);

      await tx.member.update({
        where: { id: recipientMemberId },
        data: { assignedRoleId: ownerRoleId },
      });
      await tx.member.update({
        where: { id: sourceMemberId },
        data: { assignedRoleId: sourceReplacementRoleId },
      });
      await emit?.(tx);
      return {
        source: await this.loadMember(tx, sourceMemberId),
        recipient: await this.loadMember(tx, recipientMemberId),
      };
    });
  }

  private assertOrdinaryAssignmentAllowed(
    organizationId: string,
    member: MemberWithRole | null,
    role: RoleWithPermissions | null,
    actor: { userId: string; permissions: ReadonlySet<string> },
  ): void {
    this.assertMemberInOrganization(member, organizationId);
    this.assertRoleInOrganization(role, organizationId);
    this.assertOrdinaryMemberActionAllowed(actor, member);
    if (this.roleIsOwnerCapable(role)) {
      throw new ForbiddenException('Owner-capable members and roles require the dedicated owner-management flow');
    }
    this.assertRoleAssignableBy(role, actor.permissions);
  }

  private assertOwnerPermissionShape(permissions: readonly string[], actorPermissions: ReadonlySet<string>): void {
    if (!permissions.includes(OWNER_MANAGEMENT_PERMISSION)) return;
    if (!this.isOwnerCapable(permissions)) {
      throw new BadRequestException(
        `${OWNER_MANAGEMENT_PERMISSION} may only be granted as part of an owner-capable role`,
      );
    }
    this.assertOwnerCapableActor(actorPermissions);
  }

  private assertOwnerCapableActor(actorPermissions: ReadonlySet<string>): void {
    if (!this.isOwnerCapable(actorPermissions)) {
      throw new ForbiddenException('This operation requires an owner-capable identity');
    }
  }

  private assertMemberInOrganization(
    member: MemberWithRole | null,
    organizationId: string,
  ): asserts member is MemberWithRole {
    if (!member || member.organizationId !== organizationId || member.deletedAt) {
      throw new NotFoundException('Member not found');
    }
  }

  private assertRoleInOrganization(
    role: RoleWithPermissions | null,
    organizationId: string,
  ): asserts role is RoleWithPermissions {
    if (
      !role ||
      role.archivedAt ||
      (role.organizationId !== null && role.organizationId !== organizationId) ||
      !this.roleBelongsToCatalog(role)
    ) {
      throw new NotFoundException('Role not found');
    }
  }

  private assertMemberCanReceiveOwner(member: MemberWithRole): void {
    if (this.userIsBanned(member.user)) {
      throw new ForbiddenException('Cannot grant owner access to a banned user');
    }
  }

  private assertCurrentOwner(member: MemberWithRole): void {
    if (!this.roleIsOwnerCapable(member.assignedRole)) {
      throw new BadRequestException('Member does not currently have owner access');
    }
  }

  private assertNonOwnerRole(role: RoleWithPermissions): void {
    if (this.roleIsOwnerCapable(role)) {
      throw new BadRequestException('Replacement role must not be owner-capable');
    }
  }

  private roleBelongsToCatalog(role: RolePermissionSource): boolean {
    return permissionsOfRoleBelongToCatalog(this.config.permissions, role);
  }

  private assertRoleVisible(role: RolePermissionSource): void {
    if (!this.roleBelongsToCatalog(role)) {
      throw new NotFoundException('Role not found');
    }
  }

  private roleIsOwnerCapable(role: RolePermissionSource): boolean {
    return this.isOwnerCapable(rolePermissionKeys(role));
  }

  private loadMember(tx: Prisma.TransactionClient, memberId: string) {
    return tx.member.findUnique({ where: { id: memberId }, include: memberRoleInclude });
  }

  private loadRole(tx: Prisma.TransactionClient, roleId: string) {
    return tx.organizationMemberRole.findUnique({ where: { id: roleId }, include: rolePermissionsInclude });
  }

  private async requireVisibleSystemRole(roleId: string) {
    const role = await this.prisma.organizationMemberRole.findUnique({
      where: { id: roleId },
      include: rolePermissionsInclude,
    });
    if (
      !role ||
      role.archivedAt ||
      !role.isSystem ||
      role.organizationId !== null ||
      !this.roleBelongsToCatalog(role)
    ) {
      throw new NotFoundException('System role not found');
    }
    return role;
  }

  private async countOwnerCapableMembers(tx: Prisma.TransactionClient, organizationId: string): Promise<number> {
    const now = new Date();
    const members = await tx.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        user: {
          OR: [{ banned: false }, { banExpires: { lte: now } }],
        },
        assignedRole: {
          rolePermissions: {
            some: {
              permission: {
                resource: 'organization',
                action: 'manage-owners',
              },
            },
          },
        },
      },
      include: memberRoleInclude,
    });
    return members.filter((member) => this.roleIsOwnerCapable(member.assignedRole)).length;
  }

  private userIsBanned(user: { banned: boolean | null; banExpires: Date | null }): boolean {
    return user.banned === true && (!user.banExpires || user.banExpires.getTime() > Date.now());
  }

  withOwnerLock<T>(organizationId: string, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ownerManagementLockKey(organizationId)}))`;
      return action(tx);
    });
  }

  private async createCustomRoleUnderCapacityLock(
    organizationId: string,
    data: Prisma.OrganizationMemberRoleUncheckedCreateInput,
    emit?: TransactionEmit,
  ) {
    const role = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`custom_role_create:${organizationId}`}))`;
      const existingCount = await tx.organizationMemberRole.count({
        where: { organizationId, isSystem: false, archivedAt: null },
      });
      if (existingCount >= MAX_CUSTOM_ROLES_PER_ORG) {
        throw new BadRequestException(`Maximum ${MAX_CUSTOM_ROLES_PER_ORG} custom roles per organization`);
      }
      const created = await tx.organizationMemberRole.create({
        data,
        include: {
          rolePermissions: { include: { permission: true } },
          _count: {
            select: {
              members: { where: { organizationId, deletedAt: null } },
              invitations: {
                where: { organizationId, status: 'pending', expiresAt: { gt: new Date() } },
              },
            },
          },
        },
      });
      await emit?.(tx);
      return created;
    });
    return { ...role, isOwnerCapable: this.roleIsOwnerCapable(role) };
  }

  private assertPermissionsWithinActor(actorPermissions: ReadonlySet<string>, granted: string[]): void {
    const escalated = granted.filter((key) => !actorPermissions.has(key));
    if (escalated.length > 0) {
      throw new ForbiddenException(`Cannot grant permissions you do not hold: ${escalated.join(', ')}`);
    }
  }

  private catalogKeys(): Set<string> {
    return new Set(this.config.permissions.map((p) => permissionKey(p.resource, p.action)));
  }

  private validatePermissionKeys(keys: string[]): void {
    const validKeys = this.catalogKeys();
    for (const key of keys) {
      if (!validKeys.has(key)) {
        throw new BadRequestException(`Invalid permission key: ${key}`);
      }
    }
  }

  private async resolvePermissionRecords(keys: string[]) {
    const records = await this.prisma.permission.findMany({
      where: {
        OR: keys.map((key) => {
          const [resource, action] = key.split(':');
          return { resource, action };
        }),
      },
    });
    const found = new Set(records.map((p) => permissionKey(p.resource, p.action)));
    const missing = keys.filter((key) => !found.has(key));
    if (missing.length > 0) {
      throw new InternalServerErrorException(
        `Permissions missing from database (seed out of sync): ${missing.join(', ')}`,
      );
    }
    return records;
  }
}
