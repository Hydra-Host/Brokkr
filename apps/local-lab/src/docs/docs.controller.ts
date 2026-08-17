import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { contract } from '../contract';
import { DocsService } from './docs.service';

@Controller()
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  @TsRestHandler(contract.getGettingStarted)
  getGettingStarted() {
    return tsRestHandler(contract.getGettingStarted, async () => ({
      status: 200 as const,
      body: await this.docs.gettingStarted(),
    }));
  }
}
