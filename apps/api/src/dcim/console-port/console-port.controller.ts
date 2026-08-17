import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { ConsolePortService } from './console-port.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class ConsolePortController {
  constructor(private readonly service: ConsolePortService) {}

  @TsRestHandler(contract.listDcimConsolePorts)
  async list() {
    return tsRestHandler(contract.listDcimConsolePorts, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getDcimConsolePort)
  async getById() {
    return tsRestHandler(contract.getDcimConsolePort, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDcimConsolePort)
  async create() {
    return tsRestHandler(contract.createDcimConsolePort, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body.deviceId ?? '', {
        name: body.name ?? '',
        type: body.type,
        speed: body.speed,
        description: body.description,
      }),
    }));
  }

  @TsRestHandler(contract.updateDcimConsolePort)
  async update() {
    return tsRestHandler(contract.updateDcimConsolePort, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDcimConsolePort)
  async delete() {
    return tsRestHandler(contract.deleteDcimConsolePort, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
