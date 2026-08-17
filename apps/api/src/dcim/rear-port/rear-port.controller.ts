import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { RearPortService } from './rear-port.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class RearPortController {
  constructor(private readonly service: RearPortService) {}

  @TsRestHandler(contract.listDcimRearPorts)
  async list() {
    return tsRestHandler(contract.listDcimRearPorts, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getDcimRearPort)
  async getById() {
    return tsRestHandler(contract.getDcimRearPort, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDcimRearPort)
  async create() {
    return tsRestHandler(contract.createDcimRearPort, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body.deviceId ?? '', {
        name: body.name ?? '',
        type: body.type ?? 'OTHER',
        positions: body.positions,
        description: body.description,
      }),
    }));
  }

  @TsRestHandler(contract.updateDcimRearPort)
  async update() {
    return tsRestHandler(contract.updateDcimRearPort, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDcimRearPort)
  async delete() {
    return tsRestHandler(contract.deleteDcimRearPort, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
