import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { AuditAction } from 'src/event-log/audit-action.decorator';
import { OrganizationMembershipsService } from './organization-members.service';

@Controller()
export class OrganizationMembershipsController {
  constructor(private readonly organizationMembershipsService: OrganizationMembershipsService) {}

  @TsRestHandler(contract.getOrganizationMemberships)
  async getOrganizationMemberships() {
    return tsRestHandler(contract.getOrganizationMemberships, async ({ query }) => {
      const result = await this.organizationMembershipsService.getOrganizationMemberships(query);
      return {
        status: 200 as const,
        body: result,
      };
    });
  }

  @TsRestHandler(contract.getOrganizationMember)
  async getOrganizationMember() {
    return tsRestHandler(contract.getOrganizationMember, async ({ params }) => {
      const membership = await this.organizationMembershipsService.getOrganizationMembershipById(params.memberId);
      return {
        status: 200 as const,
        body: membership,
      };
    });
  }

  @AuditAction({ actionKey: 'member.role-changed', resource: 'member', action: 'change-role' })
  @TsRestHandler(contract.updateOrganizationMemberRole)
  async updateOrganizationMemberRole() {
    return tsRestHandler(contract.updateOrganizationMemberRole, async ({ params, body }) => {
      const membership = await this.organizationMembershipsService.updateOrganizationMembershipRole(
        params.memberId,
        body,
      );
      return {
        status: 200 as const,
        body: membership,
      };
    });
  }

  @AuditAction({ actionKey: 'member.removed', resource: 'member', action: 'delete' })
  @TsRestHandler(contract.deleteOrganizationMembership)
  async deleteOrganizationMembership() {
    return tsRestHandler(contract.deleteOrganizationMembership, async ({ params }) => {
      const deletedMembership = await this.organizationMembershipsService.removeOrganizationMembership(
        params.membershipId,
      );
      const { organization: _organization, ...membership } = deletedMembership;
      void _organization;
      return {
        status: 200 as const,
        body: membership,
      };
    });
  }
}
