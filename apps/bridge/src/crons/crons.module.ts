import { Global, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import { getErrorMessage } from '../common/error-utils.js';
import { NIL_JOB_ID } from '../constants.js';
import { logWarning } from '../logger/logger.service.js';
import { configureCronSupervisor } from '../startup/cron-supervisor-singleton.js';

import { CronSupervisor } from './cron-supervisor.service.js';

@Global()
@Module({
  providers: [CronSupervisor],
  exports: [CronSupervisor],
})
export class CronsModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly supervisor: CronSupervisor) {
    configureCronSupervisor(() => this.supervisor);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.supervisor.startAll();
  }

  // fail-soft: Nest's shutdown sweep has no per-module try/catch, so a throw here would skip
  // every module that inits before this one — including the Redis closers.
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.supervisor.stopAll();
    } catch (error) {
      void logWarning(`Cron supervisor stop failed during shutdown: ${getErrorMessage(error)}`, { jobId: NIL_JOB_ID });
    }
  }
}
