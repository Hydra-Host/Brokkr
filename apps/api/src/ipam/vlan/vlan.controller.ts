import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { VlanService } from './vlan.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class VlanController {
  constructor(private readonly vlanService: VlanService) {}

  @TsRestHandler(contract.getVlan)
  async getById() {
    return tsRestHandler(contract.getVlan, async ({ params }) => ({
      status: 200 as const,
      body: await this.vlanService.findById(params.id),
    }));
  }

  @TsRestHandler(contract.listVlans)
  async listVlans() {
    return tsRestHandler(contract.listVlans, async ({ query }) => ({
      status: 200,
      body: await this.vlanService.listVlans(query),
    }));
  }

  @TsRestHandler(contract.createVlan)
  async createVlan() {
    return tsRestHandler(contract.createVlan, async ({ body }) => ({
      status: 201,
      body: await this.vlanService.createVlan(body),
    }));
  }

  @TsRestHandler(contract.updateVlan)
  async updateVlan() {
    return tsRestHandler(contract.updateVlan, async ({ params, body }) => ({
      status: 200,
      body: await this.vlanService.updateVlan(params.id, body),
    }));
  }

  @TsRestHandler(contract.archiveVlan)
  async archiveVlan() {
    return tsRestHandler(contract.archiveVlan, async ({ params }) => ({
      status: 200,
      body: await this.vlanService.archiveVlan(params.id),
    }));
  }
}
