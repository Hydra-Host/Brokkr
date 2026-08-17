import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { ServiceTuningService } from './service-tuning.service';

@Controller()
export class ServiceTuningController {
  constructor(private readonly serviceTuningService: ServiceTuningService) {}

  @TsRestHandler(contract.getZoneServiceTuning)
  async getZoneServiceTuning() {
    return tsRestHandler(contract.getZoneServiceTuning, async ({ params }) => {
      const tuning = await this.serviceTuningService.getZoneServiceTuning(params.zoneId);
      return { status: 200 as const, body: tuning };
    });
  }

  @TsRestHandler(contract.updateZoneServiceTuning)
  async updateZoneServiceTuning() {
    return tsRestHandler(contract.updateZoneServiceTuning, async ({ params, body }) => {
      const tuning = await this.serviceTuningService.updateZoneServiceTuning(params.zoneId, body);
      return { status: 200 as const, body: tuning };
    });
  }
}
