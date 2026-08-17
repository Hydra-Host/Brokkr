import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DeviceModelService } from './device-model.service';

@Controller()
export class DeviceModelController {
  constructor(private readonly service: DeviceModelService) {}

  @TsRestHandler(contract.listDeviceModels)
  async list() {
    return tsRestHandler(contract.listDeviceModels, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query.manufacturer),
    }));
  }

  @TsRestHandler(contract.getDeviceModel)
  async getById() {
    return tsRestHandler(contract.getDeviceModel, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createDeviceModel)
  async create() {
    return tsRestHandler(contract.createDeviceModel, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body),
    }));
  }

  @TsRestHandler(contract.updateDeviceModel)
  async update() {
    return tsRestHandler(contract.updateDeviceModel, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteDeviceModel)
  async delete() {
    return tsRestHandler(contract.deleteDeviceModel, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
