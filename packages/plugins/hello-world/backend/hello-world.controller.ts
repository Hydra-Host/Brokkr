import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { contractFragment } from '../contract';
import { HelloWorldService } from './hello-world.service';

@Controller()
export class HelloWorldController {
  constructor(private readonly service: HelloWorldService) {}

  @TsRestHandler(contractFragment.helloWorldListGreetings)
  listGreetings() {
    return tsRestHandler(contractFragment.helloWorldListGreetings, async () => ({
      status: 200,
      body: await this.service.listGreetings(),
    }));
  }
}
