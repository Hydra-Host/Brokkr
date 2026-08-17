import { Module } from '@nestjs/common';

import { JobIdModule } from '../common/job-id.module.js';
import { DiscoveryFileService } from './discovery-file.service.js';
import { DiscoveryController } from './discovery.controller.js';

@Module({
  imports: [JobIdModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryFileService],
})
export class DiscoveryModule {}
