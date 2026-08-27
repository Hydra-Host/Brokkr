import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { ZonesService } from './zones.service';

@Controller()
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @TsRestHandler(contract.getZonesConfig)
  getConfig() {
    return tsRestHandler(contract.getZonesConfig, async () => ({
      status: 200 as const,
      body: await this.zones.getConfig(),
    }));
  }

  @TsRestHandler(contract.putZonesConfig)
  @LabRoute({ exposure: 'loopback-only' })
  putConfig() {
    return tsRestHandler(contract.putZonesConfig, async ({ body }) => ({
      status: 200 as const,
      body: await this.zones.putConfig(body),
    }));
  }
}
