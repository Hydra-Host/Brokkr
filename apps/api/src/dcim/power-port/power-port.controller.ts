import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { PowerPortService } from './power-port.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class PowerPortController {
  constructor(private readonly service: PowerPortService) {}

  @TsRestHandler(contract.listDcimPowerPorts)
  async list() {
    return tsRestHandler(contract.listDcimPowerPorts, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getDcimPowerPort)
  async getById() {
    return tsRestHandler(contract.getDcimPowerPort, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDcimPowerPort)
  async create() {
    return tsRestHandler(contract.createDcimPowerPort, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body.deviceId ?? '', {
        name: body.name ?? '',
        type: body.type,
        maximumDraw: body.maximumDraw,
        allocatedDraw: body.allocatedDraw,
        description: body.description,
      }),
    }));
  }

  @TsRestHandler(contract.updateDcimPowerPort)
  async update() {
    return tsRestHandler(contract.updateDcimPowerPort, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDcimPowerPort)
  async delete() {
    return tsRestHandler(contract.deleteDcimPowerPort, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
