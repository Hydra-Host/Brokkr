import { Module } from '@nestjs/common';

import { SudoModule } from '../sudo/sudo.module';
import { OverlayStoreService } from './overlay-store';
import { ProcessComposeClient } from './process-compose.client';
import { ProcessEnvService } from './process-env.service';
import { RedeployService } from './redeploy.service';
import { RenderedConfigService } from './rendered-config.service';
import { RepoBranchService } from './repo-branch.service';
import { RosterService } from './roster.service';
import { ServicesController } from './services.controller';
import { StackRegistryClient } from './stack-registry-client';
import { StackRestartService } from './stack-restart.service';
import { StacksController } from './stacks.controller';
import { socketProbe, StacksService } from './stacks.service';

@Module({
  imports: [SudoModule],
  controllers: [ServicesController, StacksController],
  providers: [
    ProcessComposeClient,
    RenderedConfigService,
    OverlayStoreService,
    RosterService,
    ProcessEnvService,
    RepoBranchService,
    { provide: StackRegistryClient, useFactory: () => new StackRegistryClient() },
    StackRestartService,
    RedeployService,
    {
      provide: StacksService,
      useFactory: (registry: StackRegistryClient, pc: ProcessComposeClient) =>
        new StacksService(registry, socketProbe(pc)),
      inject: [StackRegistryClient, ProcessComposeClient],
    },
  ],
  exports: [
    ProcessComposeClient,
    RenderedConfigService,
    OverlayStoreService,
    RosterService,
    ProcessEnvService,
    RepoBranchService,
    StackRegistryClient,
    StackRestartService,
    RedeployService,
  ],
})
export class ServicesModule {}
