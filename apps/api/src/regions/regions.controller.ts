import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { RegionsService } from './regions.service';

@Controller()
export class RegionsController {
  constructor(private readonly regionsService: RegionsService) {}

  @TsRestHandler(contract.listRegions)
  listRegions() {
    return tsRestHandler(contract.listRegions, async () => ({
      status: 200,
      body: await this.regionsService.list(),
    }));
  }
}
