import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { AuditAction } from 'src/event-log/audit-action.decorator';
import { OrganizationRolesService } from './organization-roles.service';

@Controller()
export class OrganizationRolesController {
  constructor(private readonly organizationRolesService: OrganizationRolesService) {}

  @TsRestHandler(contract.listOrganizationRoles)
  async listOrganizationRoles() {
    return tsRestHandler(contract.listOrganizationRoles, async () => {
      const roles = await this.organizationRolesService.list();
      return { status: 200 as const, body: roles };
    });
  }

  @TsRestHandler(contract.getOrganizationRole)
  async getOrganizationRole() {
    return tsRestHandler(contract.getOrganizationRole, async ({ params }) => {
      const role = await this.organizationRolesService.getById(params.roleId);
      return { status: 200 as const, body: role };
    });
  }

  @AuditAction({ actionKey: 'role.created', resource: 'role', action: 'create' })
  @TsRestHandler(contract.createCustomRole)
  async createCustomRole() {
    return tsRestHandler(contract.createCustomRole, async ({ body }) => {
      const role = await this.organizationRolesService.createCustom({
        name: body.name,
        slug: body.slug,
        description: body.description,
        permissions: body.permissions,
        templateId: body.templateId,
      });
      return { status: 201 as const, body: role };
    });
  }

  @AuditAction({ actionKey: 'role.created', resource: 'role', action: 'create' })
  @TsRestHandler(contract.cloneSystemRole)
  async cloneSystemRole() {
    return tsRestHandler(contract.cloneSystemRole, async ({ body }) => {
      const role = await this.organizationRolesService.cloneSystemRole({
        systemRoleId: body.systemRoleId,
        name: body.name,
        slug: body.slug,
      });
      return { status: 201 as const, body: role };
    });
  }

  @AuditAction({ actionKey: 'role.permissions-changed', resource: 'role', action: 'permissions-changed' })
  @TsRestHandler(contract.updateRolePermissions)
  async updateRolePermissions() {
    return tsRestHandler(contract.updateRolePermissions, async ({ params, body }) => {
      const role = await this.organizationRolesService.updatePermissions(params.roleId, body.permissions);
      return { status: 200 as const, body: role };
    });
  }

  @AuditAction({ actionKey: 'role.archived', resource: 'role', action: 'archive' })
  @TsRestHandler(contract.archiveCustomRole)
  async archiveCustomRole() {
    return tsRestHandler(contract.archiveCustomRole, async ({ params }) => {
      await this.organizationRolesService.archiveCustom(params.roleId);
      return { status: 200 as const, body: { success: true } };
    });
  }

  @TsRestHandler(contract.listPermissions)
  async listPermissions() {
    return tsRestHandler(contract.listPermissions, async () => {
      const permissions = this.organizationRolesService.listPermissions();
      return { status: 200 as const, body: permissions };
    });
  }

  @AuditAction({ actionKey: 'member.role-changed', resource: 'member', action: 'role-changed' })
  @TsRestHandler(contract.assignRoleToMember)
  async assignRoleToMember() {
    return tsRestHandler(contract.assignRoleToMember, async ({ params, body }) => {
      await this.organizationRolesService.assignToMember(params.memberId, body.roleId);
      return { status: 200 as const, body: { success: true } };
    });
  }

  @AuditAction({ actionKey: 'organization.owner-granted', resource: 'organization', action: 'owner-granted' })
  @TsRestHandler(contract.grantOwnerAccess)
  async grantOwnerAccess() {
    return tsRestHandler(contract.grantOwnerAccess, async ({ params, body }) => {
      await this.organizationRolesService.grantOwnerAccess(params.memberId, body.roleId);
      return { status: 200 as const, body: { success: true } };
    });
  }

  @AuditAction({ actionKey: 'organization.owner-revoked', resource: 'organization', action: 'owner-revoked' })
  @TsRestHandler(contract.revokeOwnerAccess)
  async revokeOwnerAccess() {
    return tsRestHandler(contract.revokeOwnerAccess, async ({ params, body }) => {
      await this.organizationRolesService.revokeOwnerAccess(params.memberId, body.replacementRoleId);
      return { status: 200 as const, body: { success: true } };
    });
  }

  @AuditAction({
    actionKey: 'organization.ownership-transferred',
    resource: 'organization',
    action: 'ownership-transferred',
  })
  @TsRestHandler(contract.transferOwnership)
  async transferOwnership() {
    return tsRestHandler(contract.transferOwnership, async ({ body }) => {
      await this.organizationRolesService.transferOwnership(body);
      return { status: 200 as const, body: { success: true } };
    });
  }
}
