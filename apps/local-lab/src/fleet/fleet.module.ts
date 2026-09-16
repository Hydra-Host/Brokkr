import { Module } from '@nestjs/common';

import { DatastoreModule } from '../datastore/datastore.module';
import { QueuesModule } from '../queues/queues.module';
import { RunnerModule } from '../runner/runner.module';
import { ServicesModule } from '../services/services.module';
import { BootReadinessService } from './boot-readiness.service';
import { BootTrailReader } from './boot-trail.reader';
import { FleetExecService } from './fleet-exec.service';
import { FleetOpRegistry } from './fleet-op-registry';
import { FleetPowerService } from './fleet-power.service';
import { FleetResetService } from './fleet-reset.service';
import { FleetStatusService } from './fleet-status.service';
import { FleetTopologyService } from './fleet-topology.service';
import { FleetVerifyService } from './fleet-verify.service';
import { FleetController } from './fleet.controller';
import { UplinkPrefixService } from './uplink-prefix.service';

@Module({
  imports: [RunnerModule, ServicesModule, QueuesModule, DatastoreModule],
  controllers: [FleetController],
  providers: [
    FleetOpRegistry,
    BootReadinessService,
    BootTrailReader,
    FleetTopologyService,
    FleetExecService,
    FleetPowerService,
    FleetResetService,
    FleetStatusService,
    FleetVerifyService,
    UplinkPrefixService,
  ],
  exports: [
    BootReadinessService,
    FleetTopologyService,
    FleetExecService,
    FleetPowerService,
    FleetResetService,
    FleetStatusService,
    FleetVerifyService,
    UplinkPrefixService,
  ],
})
export class FleetModule {}
