import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { SwitchService } from './switch.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class SwitchController {
  constructor(private readonly service: SwitchService) {}

  @TsRestHandler(contract.listSwitches)
  async list() {
    return tsRestHandler(contract.listSwitches, async ({ query }) => ({
      status: 200,
      body: await this.service.list(query),
    }));
  }

  @TsRestHandler(contract.getSwitchById)
  async getById() {
    return tsRestHandler(contract.getSwitchById, async ({ params }) => ({
      status: 200,
      body: await this.service.findByDeviceId(params.deviceId),
    }));
  }

  @TsRestHandler(contract.updateSwitch)
  async update() {
    return tsRestHandler(contract.updateSwitch, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.deviceId, body),
    }));
  }

  @TsRestHandler(contract.decommissionSwitch)
  async decommission() {
    return tsRestHandler(contract.decommissionSwitch, async ({ params }) => {
      await this.service.decommission(params.deviceId);
      return { status: 204 as const, body: undefined };
    });
  }
}
