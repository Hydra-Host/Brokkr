import { Global, Module } from '@nestjs/common';

import { RunnerService } from './runner.service';

@Global()
@Module({
  providers: [RunnerService],
  exports: [RunnerService],
})
export class RunnerModule {}
