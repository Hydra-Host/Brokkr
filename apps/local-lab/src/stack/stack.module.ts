import { Module } from '@nestjs/common';

import { FleetModule } from '../fleet/fleet.module';
import { RunnerModule } from '../runner/runner.module';
import { ServicesModule } from '../services/services.module';
import { SudoModule } from '../sudo/sudo.module';
import { InitTasksService } from './init-tasks.service';
import { StackController } from './stack.controller';
import { StackService } from './stack.service';

@Module({
  imports: [RunnerModule, ServicesModule, FleetModule, SudoModule],
  controllers: [StackController],
  providers: [StackService, InitTasksService],
  exports: [StackService, InitTasksService],
})
export class StackModule {}
