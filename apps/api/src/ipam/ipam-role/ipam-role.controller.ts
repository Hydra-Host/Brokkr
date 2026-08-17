import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { IpamRoleService } from './ipam-role.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class IpamRoleController {
  constructor(private readonly service: IpamRoleService) {}

  @TsRestHandler(contract.listIpamRoles)
  async list() {
    return tsRestHandler(contract.listIpamRoles, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query.search),
    }));
  }

  @TsRestHandler(contract.getIpamRole)
  async getById() {
    return tsRestHandler(contract.getIpamRole, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createIpamRole)
  async create() {
    return tsRestHandler(contract.createIpamRole, async ({ body }) => ({
      status: 201,
      body: await this.service.create({
        name: body.name,
        slug: body.slug,
        weight: body.weight,
        description: body.description,
      }),
    }));
  }

  @TsRestHandler(contract.updateIpamRole)
  async update() {
    return tsRestHandler(contract.updateIpamRole, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteIpamRole)
  async delete() {
    return tsRestHandler(contract.deleteIpamRole, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
