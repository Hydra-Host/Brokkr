import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { CurrentSessionUser } from 'src/auth/decorators/current-session-user.decorator';
import { SessionOnly } from 'src/auth/decorators/session-only.decorator';
import type { SessionUser } from 'src/common/context/context.service';
import { OrganizationsService } from './organizations.service';

@Controller()
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @SessionOnly()
  @TsRestHandler(contract.createOrganization)
  async create(@CurrentSessionUser() user: SessionUser) {
    return tsRestHandler(contract.createOrganization, async ({ body }) => {
      const organization = await this.organizationsService.create(body, user.id);
      return {
        status: 201 as const,
        body: organization,
      };
    });
  }

  @SessionOnly()
  @TsRestHandler(contract.getAllowedOrganizationTypes)
  async getAllowedOrganizationTypes() {
    return tsRestHandler(contract.getAllowedOrganizationTypes, async () => {
      const body = this.organizationsService.getAllowedOrganizationTypes();
      return { status: 200 as const, body };
    });
  }

  @SessionOnly()
  @TsRestHandler(contract.listOrganizations)
  async list(@CurrentSessionUser() user: SessionUser) {
    return tsRestHandler(contract.listOrganizations, async ({ query }) => {
      const paginated = await this.organizationsService.listForUser(user.id, query);
      return {
        status: 200 as const,
        body: paginated,
      };
    });
  }

  @TsRestHandler(contract.getOrganization)
  async getById() {
    return tsRestHandler(contract.getOrganization, async () => {
      const organization = await this.organizationsService.getById();
      return {
        status: 200 as const,
        body: organization,
      };
    });
  }

  @TsRestHandler(contract.updateOrganization)
  async update() {
    return tsRestHandler(contract.updateOrganization, async ({ body }) => {
      const organization = await this.organizationsService.update(body);
      return {
        status: 200 as const,
        body: organization,
      };
    });
  }

  @SessionOnly()
  @TsRestHandler(contract.setActiveOrganization)
  async setActive(@CurrentSessionUser() user: SessionUser) {
    return tsRestHandler(contract.setActiveOrganization, async ({ params }) => {
      const result = await this.organizationsService.setActiveOrganization(user.id, params.id);
      return {
        status: 200 as const,
        body: result,
      };
    });
  }
}
