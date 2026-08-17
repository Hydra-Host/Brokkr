import { Module } from '@nestjs/common';

import { RunnerModule } from '../runner/runner.module';
import { ServicesModule } from '../services/services.module';
import { BuildController } from './build.controller';
import { BuildService } from './build.service';

@Module({
  imports: [RunnerModule, ServicesModule],
  controllers: [BuildController],
  providers: [BuildService],
  exports: [BuildService],
})
export class BuildModule {}
