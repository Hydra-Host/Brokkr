import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { StacksService } from './stacks.service';

@Controller()
export class StacksController {
  constructor(private readonly stacks: StacksService) {}

  @TsRestHandler(contract.listStacks)
  @LabRoute({ exposure: 'loopback-only' })
  list() {
    return tsRestHandler(contract.listStacks, async () => ({
      status: 200 as const,
      body: await this.stacks.listStacks(),
    }));
  }
}
