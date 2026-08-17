import { Module } from '@nestjs/common';

import { DatastoreModule } from '../datastore/datastore.module';
import { FleetModule } from '../fleet/fleet.module';
import { RunsModule } from '../runs/runs.module';
import { ServicesModule } from '../services/services.module';
import { StackModule } from '../stack/stack.module';
import { HttpProbeService } from './http-probe.service';
import { StatusController } from './status.controller';
import { StatusService } from './status.service';

@Module({
  imports: [ServicesModule, FleetModule, DatastoreModule, RunsModule, StackModule],
  controllers: [StatusController],
  providers: [StatusService, HttpProbeService],
})
export class StatusModule {}
