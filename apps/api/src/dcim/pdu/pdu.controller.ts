import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { PduService } from './pdu.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class PduController {
  constructor(private readonly service: PduService) {}

  @TsRestHandler(contract.listPdus)
  async list() {
    return tsRestHandler(contract.listPdus, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getPduById)
  async getById() {
    return tsRestHandler(contract.getPduById, async ({ params }) => ({
      status: 200,
      body: await this.service.findByDeviceId(params.deviceId),
    }));
  }

  @TsRestHandler(contract.updatePdu)
  async update() {
    return tsRestHandler(contract.updatePdu, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.deviceId, body),
    }));
  }

  @TsRestHandler(contract.decommissionPdu)
  async decommission() {
    return tsRestHandler(contract.decommissionPdu, async ({ params }) => {
      await this.service.decommission(params.deviceId);
      return { status: 204 as const, body: undefined };
    });
  }
}
