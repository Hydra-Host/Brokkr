import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DiscoveryRunsService } from './discovery-runs.service';

@Controller()
export class DiscoveryRunsController {
  constructor(private readonly service: DiscoveryRunsService) {}

  @TsRestHandler(contract.listDeviceDiscoveryRuns)
  listDeviceDiscoveryRuns() {
    return tsRestHandler(contract.listDeviceDiscoveryRuns, async ({ params, query }) => ({
      status: 200,
      body: await this.service.listForDevice(params.deviceId, query),
    }));
  }
}
