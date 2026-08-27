import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { AuditAction } from 'src/event-log/audit-action.decorator';
import { OrganizationInvitationsService } from './organization-invitations.service';

@Controller()
export class OrganizationInvitationsController {
  constructor(private readonly organizationInvitationsService: OrganizationInvitationsService) {}

  @AuditAction({ actionKey: 'member.invited', resource: 'invitation', action: 'create' })
  @TsRestHandler(contract.createInvitation)
  async createInvitation() {
    return tsRestHandler(contract.createInvitation, async ({ body }) => {
      const invitation = await this.organizationInvitationsService.createInvitation({
        email: body.email,
        roleId: body.roleId,
      });

      return {
        status: 200 as const,
        body: invitation,
      };
    });
  }

  @TsRestHandler(contract.listInvitations)
  async listInvitations() {
    return tsRestHandler(contract.listInvitations, async ({ query }) => {
      const result = await this.organizationInvitationsService.listInvitations(query);
      return {
        status: 200 as const,
        body: result,
      };
    });
  }

  @TsRestHandler(contract.getInvitation)
  async getInvitation() {
    return tsRestHandler(contract.getInvitation, async ({ params }) => {
      const invitation = await this.organizationInvitationsService.getInvitation(params.invitationId);

      return {
        status: 200 as const,
        body: invitation,
      };
    });
  }

  @TsRestHandler(contract.acceptInvitation)
  async acceptInvitation() {
    return tsRestHandler(contract.acceptInvitation, async ({ params }) => {
      const invitation = await this.organizationInvitationsService.acceptInvitation(params.invitationId);

      return {
        status: 200 as const,
        body: invitation,
      };
    });
  }

  @TsRestHandler(contract.rejectInvitation)
  async rejectInvitation() {
    return tsRestHandler(contract.rejectInvitation, async ({ params }) => {
      const invitation = await this.organizationInvitationsService.rejectInvitation(params.invitationId);

      return {
        status: 200 as const,
        body: invitation,
      };
    });
  }

  @AuditAction({ actionKey: 'invitation.cancelled', resource: 'invitation', action: 'delete' })
  @TsRestHandler(contract.cancelInvitation)
  async cancelInvitation() {
    return tsRestHandler(contract.cancelInvitation, async ({ params }) => {
      const invitation = await this.organizationInvitationsService.cancelInvitation(params.invitationId);

      return {
        status: 200 as const,
        body: invitation,
      };
    });
  }
}
