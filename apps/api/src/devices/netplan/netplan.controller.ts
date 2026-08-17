import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { NetplanService } from './netplan.service';

@Controller()
export class NetplanController {
  constructor(private readonly netplanService: NetplanService) {}

  @TsRestHandler(contract.getDeviceNetplan)
  async getDeviceNetplan() {
    return tsRestHandler(contract.getDeviceNetplan, async ({ params, query }) => {
      const yaml = await this.netplanService.renderForUserDevice(params.deviceId, query.phase);
      return { status: 200 as const, body: { yaml } };
    });
  }
}
