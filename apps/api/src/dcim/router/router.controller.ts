import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { RouterService } from './router.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class RouterController {
  constructor(private readonly service: RouterService) {}

  @TsRestHandler(contract.listRouters)
  async list() {
    return tsRestHandler(contract.listRouters, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getRouterById)
  async getById() {
    return tsRestHandler(contract.getRouterById, async ({ params }) => ({
      status: 200,
      body: await this.service.findByDeviceId(params.deviceId),
    }));
  }

  @TsRestHandler(contract.updateRouter)
  async update() {
    return tsRestHandler(contract.updateRouter, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.deviceId, body),
    }));
  }

  @TsRestHandler(contract.decommissionRouter)
  async decommission() {
    return tsRestHandler(contract.decommissionRouter, async ({ params }) => {
      await this.service.decommission(params.deviceId);
      return { status: 204 as const, body: undefined };
    });
  }
}
