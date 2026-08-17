import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { PowerOutletService } from './power-outlet.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class PowerOutletController {
  constructor(private readonly service: PowerOutletService) {}

  @TsRestHandler(contract.listDcimPowerOutlets)
  async list() {
    return tsRestHandler(contract.listDcimPowerOutlets, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getDcimPowerOutlet)
  async getById() {
    return tsRestHandler(contract.getDcimPowerOutlet, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDcimPowerOutlet)
  async create() {
    return tsRestHandler(contract.createDcimPowerOutlet, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body.deviceId ?? '', {
        name: body.name ?? '',
        type: body.type,
        feedLegPhase: body.feedLegPhase,
        description: body.description,
      }),
    }));
  }

  @TsRestHandler(contract.updateDcimPowerOutlet)
  async update() {
    return tsRestHandler(contract.updateDcimPowerOutlet, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDcimPowerOutlet)
  async delete() {
    return tsRestHandler(contract.deleteDcimPowerOutlet, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
