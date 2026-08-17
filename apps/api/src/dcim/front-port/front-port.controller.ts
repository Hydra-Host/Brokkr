import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { FrontPortService } from './front-port.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class FrontPortController {
  constructor(private readonly service: FrontPortService) {}

  @TsRestHandler(contract.listDcimFrontPorts)
  async list() {
    return tsRestHandler(contract.listDcimFrontPorts, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getDcimFrontPort)
  async getById() {
    return tsRestHandler(contract.getDcimFrontPort, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDcimFrontPort)
  async create() {
    return tsRestHandler(contract.createDcimFrontPort, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body.deviceId ?? '', {
        name: body.name ?? '',
        type: body.type ?? 'OTHER',
        rearPortId: body.rearPortId ?? '',
        rearPortPosition: body.rearPortPosition,
        description: body.description,
      }),
    }));
  }

  @TsRestHandler(contract.updateDcimFrontPort)
  async update() {
    return tsRestHandler(contract.updateDcimFrontPort, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDcimFrontPort)
  async delete() {
    return tsRestHandler(contract.deleteDcimFrontPort, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
