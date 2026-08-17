import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { WebVitalsService } from './web-vitals.service';

@Controller()
export class WebVitalsController {
  constructor(private readonly webVitalsService: WebVitalsService) {}

  @TsRestHandler(contract.reportWebVitals)
  reportWebVitals() {
    return tsRestHandler(contract.reportWebVitals, async ({ body }) => ({
      status: 202,
      body: this.webVitalsService.record(body.metrics),
    }));
  }
}
