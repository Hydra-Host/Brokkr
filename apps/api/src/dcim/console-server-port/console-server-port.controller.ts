import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { ConsoleServerPortService } from './console-server-port.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class ConsoleServerPortController {
  constructor(private readonly service: ConsoleServerPortService) {}

  @TsRestHandler(contract.listDcimConsoleServerPorts)
  async list() {
    return tsRestHandler(contract.listDcimConsoleServerPorts, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getDcimConsoleServerPort)
  async getById() {
    return tsRestHandler(contract.getDcimConsoleServerPort, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDcimConsoleServerPort)
  async create() {
    return tsRestHandler(contract.createDcimConsoleServerPort, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body.deviceId ?? '', {
        name: body.name ?? '',
        type: body.type,
        speed: body.speed,
        description: body.description,
      }),
    }));
  }

  @TsRestHandler(contract.updateDcimConsoleServerPort)
  async update() {
    return tsRestHandler(contract.updateDcimConsoleServerPort, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDcimConsoleServerPort)
  async delete() {
    return tsRestHandler(contract.deleteDcimConsoleServerPort, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
