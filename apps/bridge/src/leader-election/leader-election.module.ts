import {
  DynamicModule,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
  Provider,
  Type,
} from '@nestjs/common';

import { getErrorMessage } from '../common/error-utils';
import { NIL_JOB_ID } from '../constants';
import { register } from '../crons/cron-registry';
import { ContextLogger, logWarning } from '../logger/logger.service';

import { type LeaderConfig } from './leader-election.config';
import {
  type InterfaceEnumerator,
  type LeaderCache,
  LeaderElectionService,
  setLeaderService,
  type VersionInfo,
} from './leader-election.service';
import { LeaderHeartbeatCron } from './leader-heartbeat.cron';

export interface LeaderElectionModuleOptions {
  cacheToken: Type<LeaderCache> | symbol | string;
  interfacesToken: Type<InterfaceEnumerator> | symbol | string;
  versionInfo: () => VersionInfo;
  config?: LeaderConfig;
  jobId?: string;
}

@Module({})
export class LeaderElectionModule implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  // Explicit @Inject: the SWC decorator transform emits no design:paramtypes, so implicit injection would leave these undefined.
  constructor(
    @Inject(LeaderElectionService) private readonly service: LeaderElectionService,
    @Inject(LeaderHeartbeatCron) private readonly cron: LeaderHeartbeatCron,
  ) {}

  static forRoot(options: LeaderElectionModuleOptions): DynamicModule {
    const serviceProvider: Provider = {
      provide: LeaderElectionService,
      useFactory: (cache: LeaderCache, interfaces: InterfaceEnumerator, logger: ContextLogger) =>
        new LeaderElectionService(cache, interfaces, options.versionInfo, logger, options.config, options.jobId),
      inject: [options.cacheToken, options.interfacesToken, ContextLogger],
    };
    const cronProvider: Provider = {
      provide: LeaderHeartbeatCron,
      useFactory: (service: LeaderElectionService) => new LeaderHeartbeatCron(service),
      inject: [LeaderElectionService],
    };
    return {
      module: LeaderElectionModule,
      providers: [serviceProvider, cronProvider],
      exports: [LeaderElectionService, LeaderHeartbeatCron],
    };
  }

  onModuleInit(): void {
    const cfg = this.service.config;
    register({
      name: 'leader_heartbeat',
      intervalMs: cfg.leaderRenewIntervalSeconds * 1000,
      run: (signal) => this.cron.tick(signal),
      timeoutMs: cfg.leaderHeartbeatTimeoutSeconds * 1000,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.service.start();
    setLeaderService(this.service);
  }

  async onApplicationShutdown(): Promise<void> {
    // Fail-soft: stop() failure must not break shutdown, and the holder must always clear so bridge-status can't read a stale instance.
    try {
      await this.service.stop();
    } catch (error) {
      void logWarning(`Leader election stop failed during shutdown: ${getErrorMessage(error)}`, { jobId: NIL_JOB_ID });
    } finally {
      setLeaderService(null);
    }
  }
}
