import { Module } from '@nestjs/common';

import { DatastoreModule } from '../datastore/datastore.module';
import { FleetModule } from '../fleet/fleet.module';
import { RunnerModule } from '../runner/runner.module';
import { RunsModule } from '../runs/runs.module';
import { ServicesModule } from '../services/services.module';
import { TestController } from './test.controller';
import { TestService } from './test.service';

@Module({
  imports: [RunnerModule, RunsModule, ServicesModule, FleetModule, DatastoreModule],
  controllers: [TestController],
  providers: [TestService],
})
export class TestModule {}
