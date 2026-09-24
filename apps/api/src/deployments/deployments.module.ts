import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BrokkrBridgeModule } from 'src/brokkr-bridge/brokkr-bridge.module';
import { SolLogModule } from 'src/brokkr-bridge/sol-logs/sol-log.module';
import { CloudInitTemplatesModule } from 'src/cloud-init-templates/cloud-init-templates.module';
import { LifecycleModule } from 'src/lifecycle/lifecycle.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ProvisionModule } from 'src/provision/provision.module';
import { SshKeysModule } from 'src/sshkeys/sshkeys.module';
import { WebhookModule } from 'src/webhook/webhook.module';
import { DeploymentJobsController } from './controllers/deployment-jobs.controller';
import { DeploymentsController } from './controllers/deployments.controller';
import { DeploymentsProjectsController } from './controllers/deployments.projects.controller';
import { LifecycleRequestsController } from './controllers/lifecycle-requests.controller';
import { DEPLOYMENTS_SERVICE } from './deployments.tokens';
import { RescueModeService } from './rescue-mode.service';
import { DeploymentJobsService } from './services/deployment-jobs.service';
import { DeploymentsProjectsService } from './services/deployments.projects.service';
import { DeploymentsService } from './services/deployments.service';
import { LifecycleRequestsService } from './services/lifecycle-requests.service';
@Module({
  imports: [
    SshKeysModule,
    forwardRef(() => ProvisionModule),
    PrismaModule,
    ConfigModule,
    SolLogModule,
    WebhookModule,
    forwardRef(() => BrokkrBridgeModule),
    forwardRef(() => LifecycleModule),
    CloudInitTemplatesModule,
  ],
  controllers: [
    DeploymentsProjectsController,
    DeploymentsController,
    LifecycleRequestsController,
    DeploymentJobsController,
  ],
  providers: [
    DeploymentsService,
    DeploymentsProjectsService,
    LifecycleRequestsService,
    DeploymentJobsService,
    RescueModeService,
    {
      provide: DEPLOYMENTS_SERVICE,
      useExisting: DeploymentsService,
    },
  ],
  exports: [DeploymentsService, DEPLOYMENTS_SERVICE, DeploymentsProjectsService, RescueModeService],
})
export class DeploymentsModule {}
