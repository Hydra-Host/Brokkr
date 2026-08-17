import { Module } from '@nestjs/common';

import { JobIdModule } from '../common/job-id.module.js';
import { OsImageController } from './os-image.controller.js';

@Module({
  imports: [JobIdModule],
  controllers: [OsImageController],
})
export class OsImageModule {}
