import { DynamicModule, Module, Provider, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service';
import { register } from '../crons/cron-registry';
import { getLeaderConfig } from '../leader-election/leader-election.config';
import { getLeaderService } from '../leader-election/leader-election.service';
import { ContextLogger } from '../logger/logger.service';

import { VrrpReconcilerService, type LeaderStatusProvider } from './vrrp-reconciler.service';

// Whole-tick watchdog; sized above a full multi-VIP rebind on failover so a legitimate reconcile is never aborted mid-flight.
const RECONCILE_TIMEOUT_MS = 60_000;

export interface VrrpModuleOptions {
  jobId?: string;
  leaderStatusProvider?: LeaderStatusProvider;
}

@Module({})
export class VrrpModule implements OnModuleInit, OnApplicationShutdown {
  constructor(private readonly reconciler: VrrpReconcilerService) {}

  static forRoot(options: VrrpModuleOptions = {}): DynamicModule {
    const isLeader: LeaderStatusProvider =
      options.leaderStatusProvider ?? ((): boolean => getLeaderService()?.isLeader ?? false);
    const selfInstanceId = getLeaderConfig().instanceId;
    const reconcilerProvider: Provider = {
      provide: VrrpReconcilerService,
      useFactory: (redis: RedisService, logger: ContextLogger) =>
        new VrrpReconcilerService(isLeader, redis, logger, options.jobId, selfInstanceId),
      inject: [RedisService, ContextLogger],
    };
    return {
      module: VrrpModule,
      providers: [reconcilerProvider],
      exports: [VrrpReconcilerService],
    };
  }

  // Always registered — hub atoms alone decide what (if anything) this bridge binds.
  onModuleInit(): void {
    register({
      name: 'vrrp_reconcile',
      intervalMs: getLeaderConfig().leaderRenewIntervalSeconds * 1000,
      run: () => this.reconciler.reconcileOnce(),
      timeoutMs: RECONCILE_TIMEOUT_MS,
    });
  }

  // Must run before LeaderElectionModule's releaseLeadership — VrrpModule must be imported AFTER LeaderElectionModule in AppModule (Nest shuts down in reverse init order), else the next leader can bind the VIP while we still hold it.
  async onApplicationShutdown(): Promise<void> {
    await this.reconciler.detachAll();
  }
}
