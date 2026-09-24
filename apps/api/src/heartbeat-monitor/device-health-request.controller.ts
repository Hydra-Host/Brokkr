import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DeviceHealthRequestService } from './device-health-request.service';

@Controller()
export class DeviceHealthRequestController {
  constructor(private readonly requests: DeviceHealthRequestService) {}

  @TsRestHandler(contract.requestDeviceHealthCheck)
  async requestDeviceHealthCheck() {
    return tsRestHandler(contract.requestDeviceHealthCheck, async ({ params }) => ({
      status: 200 as const,
      body: await this.requests.request(params.deviceId),
    }));
  }
}
