import { Module } from '@nestjs/common';

import { CloudInitPayloadService } from './cloud-init-payload.service';

@Module({
  providers: [CloudInitPayloadService],
  exports: [CloudInitPayloadService],
})
export class CloudInitModule {}
