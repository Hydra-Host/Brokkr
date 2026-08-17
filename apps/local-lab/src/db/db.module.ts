import { Global, Module } from '@nestjs/common';

import { LabDbService } from './lab-db.service';

@Global()
@Module({
  providers: [LabDbService],
  exports: [LabDbService],
})
export class DbModule {}
