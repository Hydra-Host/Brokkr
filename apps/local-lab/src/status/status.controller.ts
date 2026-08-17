import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { contract } from '../contract';
import { StatusService } from './status.service';

@Controller()
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @TsRestHandler(contract.getStatus)
  get() {
    return tsRestHandler(contract.getStatus, async () => ({
      status: 200 as const,
      body: await this.status.overview(),
    }));
  }
}
