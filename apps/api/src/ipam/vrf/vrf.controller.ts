import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { VrfService } from './vrf.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class VrfController {
  constructor(private readonly vrfService: VrfService) {}

  @TsRestHandler(contract.getVrf)
  async getById() {
    return tsRestHandler(contract.getVrf, async ({ params }) => ({
      status: 200 as const,
      body: await this.vrfService.findById(params.id),
    }));
  }

  @TsRestHandler(contract.listVrfs)
  async listVrfs() {
    return tsRestHandler(contract.listVrfs, async ({ query }) => ({
      status: 200,
      body: await this.vrfService.listVrfs(query),
    }));
  }

  @TsRestHandler(contract.createVrf)
  async createVrf() {
    return tsRestHandler(contract.createVrf, async ({ body }) => ({
      status: 201,
      body: await this.vrfService.createVrf(body),
    }));
  }

  @TsRestHandler(contract.updateVrf)
  async updateVrf() {
    return tsRestHandler(contract.updateVrf, async ({ params, body }) => ({
      status: 200,
      body: await this.vrfService.updateVrf(params.id, body),
    }));
  }

  @TsRestHandler(contract.archiveVrf)
  async archiveVrf() {
    return tsRestHandler(contract.archiveVrf, async ({ params }) => ({
      status: 200,
      body: await this.vrfService.archiveVrf(params.id),
    }));
  }
}
