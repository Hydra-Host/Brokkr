import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { VlanGroupService } from './vlan-group.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class VlanGroupController {
  constructor(private readonly service: VlanGroupService) {}

  @TsRestHandler(contract.listVlanGroups)
  async list() {
    return tsRestHandler(contract.listVlanGroups, async ({ query }) => ({
      status: 200,
      body: await this.service.list({ zoneId: query.zoneId }),
    }));
  }

  @TsRestHandler(contract.getVlanGroup)
  async getById() {
    return tsRestHandler(contract.getVlanGroup, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createVlanGroup)
  async create() {
    return tsRestHandler(contract.createVlanGroup, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body),
    }));
  }

  @TsRestHandler(contract.updateVlanGroup)
  async update() {
    return tsRestHandler(contract.updateVlanGroup, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteVlanGroup)
  async delete() {
    return tsRestHandler(contract.deleteVlanGroup, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
