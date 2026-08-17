import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { contract } from '../contract';
import { ZoneRuntimeService } from './zone-runtime.service';

@Controller()
export class RuntimeController {
  constructor(private readonly zoneRuntime: ZoneRuntimeService) {}

  @TsRestHandler(contract.listZoneRuntimes)
  listZoneRuntimes() {
    return tsRestHandler(contract.listZoneRuntimes, async () => ({
      status: 200 as const,
      body: await this.zoneRuntime.list(),
    }));
  }
}
