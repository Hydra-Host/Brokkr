import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DeviceHealthChecksService } from './device-health-checks.service';

@Controller()
export class DeviceHealthChecksController {
  constructor(private readonly healthChecks: DeviceHealthChecksService) {}

  @TsRestHandler(contract.listDeviceHealthChecks)
  async listDeviceHealthChecks() {
    return tsRestHandler(contract.listDeviceHealthChecks, async ({ params, query }) => ({
      status: 200 as const,
      body: await this.healthChecks.list(params.deviceId, query),
    }));
  }

  @TsRestHandler(contract.getDeviceHealthSummary)
  async getDeviceHealthSummary() {
    return tsRestHandler(contract.getDeviceHealthSummary, async ({ params }) => ({
      status: 200 as const,
      body: await this.healthChecks.summary(params.deviceId),
    }));
  }
}
