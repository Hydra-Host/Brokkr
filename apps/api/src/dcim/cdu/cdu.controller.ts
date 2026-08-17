import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { CduService } from './cdu.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class CduController {
  constructor(private readonly service: CduService) {}

  @TsRestHandler(contract.listCdus)
  async list() {
    return tsRestHandler(contract.listCdus, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getCduById)
  async getById() {
    return tsRestHandler(contract.getCduById, async ({ params }) => ({
      status: 200,
      body: await this.service.findByDeviceId(params.deviceId),
    }));
  }

  @TsRestHandler(contract.updateCdu)
  async update() {
    return tsRestHandler(contract.updateCdu, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.deviceId, body),
    }));
  }

  @TsRestHandler(contract.decommissionCdu)
  async decommission() {
    return tsRestHandler(contract.decommissionCdu, async ({ params }) => {
      await this.service.decommission(params.deviceId);
      return { status: 204 as const, body: undefined };
    });
  }
}
