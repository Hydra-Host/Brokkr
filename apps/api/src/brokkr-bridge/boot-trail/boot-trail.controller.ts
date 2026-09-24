import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { BootTrailService } from './boot-trail.service';
import { DeviceBootReadinessService } from './device-boot-readiness.service';

@Controller()
export class BootTrailController {
  constructor(
    private readonly bootTrail: BootTrailService,
    private readonly readiness: DeviceBootReadinessService,
  ) {}

  @TsRestHandler(contract.getDeviceBootTrail)
  async getDeviceBootTrail() {
    return tsRestHandler(contract.getDeviceBootTrail, async ({ params }) => ({
      status: 200 as const,
      body: await this.bootTrail.read(params.deviceId),
    }));
  }

  @TsRestHandler(contract.getDeviceBootReadiness)
  async getDeviceBootReadiness() {
    return tsRestHandler(contract.getDeviceBootReadiness, async ({ params }) => ({
      status: 200 as const,
      body: await this.readiness.evaluate(params.deviceId),
    }));
  }
}
