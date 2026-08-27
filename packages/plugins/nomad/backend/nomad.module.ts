import { PLUGIN_OPERATOR_ADMIN_ORG, PluginOperatorGuard } from '@hydrahost/plugin-sdk/nest';
import { Module } from '@nestjs/common';

import type { NomadConfig } from '../schemas';
import { NOMAD_CONFIG_TOKEN } from './config.token';
import { NomadJobsService } from './nomad-jobs.service';
import { NomadClient } from './nomad.client';
import { NomadController } from './nomad.controller';

// PluginOperatorGuard must be a provider: an unresolvable controller-scoped guard is silently skipped.
@Module({
  controllers: [NomadController],
  providers: [
    NomadClient,
    NomadJobsService,
    PluginOperatorGuard,
    {
      provide: PLUGIN_OPERATOR_ADMIN_ORG,
      useFactory: (config: NomadConfig) => config.adminOrganizationId,
      inject: [NOMAD_CONFIG_TOKEN],
    },
  ],
  exports: [NomadClient, NomadJobsService],
})
export class NomadModule {}
