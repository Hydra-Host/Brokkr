import { Module } from '@nestjs/common';

import { FileServeService } from '../common/file-serve.service.js';
import { JobIdModule } from '../common/job-id.module.js';
import { GrubController } from './grub.controller.js';

@Module({
  imports: [JobIdModule],
  controllers: [GrubController],
  providers: [FileServeService],
})
export class GrubModule {}
