import { Global, Module } from '@nestjs/common';

import { JobIdService } from './job-id.service';

@Global()
@Module({
  providers: [JobIdService],
  exports: [JobIdService],
})
export class JobIdModule {}
