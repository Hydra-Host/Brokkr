import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SessionOnly } from 'src/auth/decorators/session-only.decorator';
import { ContextService } from 'src/common/context/context.service';
import { OrganizationMembershipsService } from 'src/organizations/members/organization-members.service';
import { UsersService } from './users.service';

@Controller()
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly contextService: ContextService,
    private readonly organizationMembershipsService: OrganizationMembershipsService,
  ) {}

  @TsRestHandler(contract.getMe)
  async getMe() {
    return tsRestHandler(contract.getMe, async () => {
      const user = await this.usersService.getAuthenticatedUser(this.contextService.userId);
      return { status: 200 as const, body: user };
    });
  }

  @TsRestHandler(contract.updateUserProfile)
  async updateUserProfile() {
    return tsRestHandler(contract.updateUserProfile, async ({ body }) => {
      const updatedUser = await this.usersService.updateUser(this.contextService.userId, body);
      return { status: 200 as const, body: updatedUser };
    });
  }

  @TsRestHandler(contract.setDefaultOrganization)
  async setDefaultOrganization() {
    return tsRestHandler(contract.setDefaultOrganization, async ({ body }) => {
      const membership = await this.organizationMembershipsService.setDefaultOrganization(
        this.contextService.userId,
        body.organizationId,
      );
      return { status: 200 as const, body: membership };
    });
  }

  @SessionOnly()
  @TsRestHandler(contract.listMyInvitations)
  async listMyInvitations() {
    return tsRestHandler(contract.listMyInvitations, async ({ query }) => {
      const body = await this.usersService.listPendingInvitationsForUserPaginated(
        this.contextService.requireSessionUser.email,
        query,
      );
      return { status: 200 as const, body };
    });
  }

  @SessionOnly()
  @TsRestHandler(contract.acceptMyInvitation)
  async acceptMyInvitation() {
    return tsRestHandler(contract.acceptMyInvitation, async ({ params }) => {
      const invitation = await this.usersService.acceptInvitationForUser(params.invitationId);
      return {
        status: 200 as const,
        body: invitation,
      };
    });
  }

  @SessionOnly()
  @TsRestHandler(contract.rejectMyInvitation)
  async rejectMyInvitation() {
    return tsRestHandler(contract.rejectMyInvitation, async ({ params }) => {
      const invitation = await this.usersService.rejectInvitationForUser(params.invitationId);
      return {
        status: 200 as const,
        body: invitation,
      };
    });
  }
}
