import { Module } from '@nestjs/common';
import { CloudInitProcessor, ProvisionValidatorService } from './processors';

@Module({
  providers: [CloudInitProcessor, ProvisionValidatorService],
  exports: [CloudInitProcessor, ProvisionValidatorService],
})
export class ProvisionModule {}
