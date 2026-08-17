import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

import { AgentTokenService, type AgentTokenCache } from '../auth/agent-token.service.js';
import { ATOM_FETCHER, NetplanAtomService, type AtomFetcher } from '../bridge-network/netplan-atom.service.js';
import { RedisService } from '../common/redis/redis.service.js';
import { getAtom, type AtomCache, type EnqueueRenderRequest } from '../device-record/atom/atom-fetcher.js';
import {
  DEVICE_RECORD_CACHE,
  DEVICE_RECORD_RENDER_ENQUEUER,
  DeviceRecordService,
} from '../device-record/device-record.service.js';
import { getLeaderConfig } from '../leader-election/leader-election.config.js';
import { ContextLogger } from '../logger/logger.service.js';

import { InitrdOrchestrationService } from './initrd-orchestration.service.js';
import { InitrdController } from './initrd.controller.js';

export interface InitrdModuleOptions {
  cache?: RedisService & AtomCache & AgentTokenCache;
  enqueueRenderRequest?: EnqueueRenderRequest;
  enqueueRenderRequestToken?: Type<unknown> | symbol | string;
  bridgeId?: string;
}

@Module({})
export class InitrdModule {
  static forRoot(options: InitrdModuleOptions): DynamicModule {
    if (options.enqueueRenderRequest === undefined && options.enqueueRenderRequestToken === undefined) {
      throw new Error(
        'InitrdModule.forRoot: exactly one of `enqueueRenderRequest` (value) or `enqueueRenderRequestToken` (DI token) must be supplied',
      );
    }
    if (options.enqueueRenderRequestToken === undefined && options.cache === undefined) {
      throw new Error(
        'InitrdModule.forRoot: `cache` is required on the value-form path (no `enqueueRenderRequestToken` supplied)',
      );
    }

    const cacheProvider: Provider | null =
      options.cache !== undefined
        ? {
            provide: RedisService,
            useValue: options.cache,
          }
        : null;

    const agentTokenProvider: Provider = {
      provide: AgentTokenService,
      useFactory: (cache: AgentTokenCache, logger: ContextLogger) => new AgentTokenService(cache, logger),
      inject: [RedisService, ContextLogger],
    };

    const deviceRecordCacheProvider: Provider = {
      provide: DEVICE_RECORD_CACHE,
      useExisting: RedisService,
    };

    const deviceRecordEnqueuerProvider: Provider =
      options.enqueueRenderRequestToken !== undefined
        ? {
            provide: DEVICE_RECORD_RENDER_ENQUEUER,
            useFactory: (enqueuer: EnqueueRenderRequest) => enqueuer,
            inject: [options.enqueueRenderRequestToken],
          }
        : {
            provide: DEVICE_RECORD_RENDER_ENQUEUER,
            useValue: options.enqueueRenderRequest as EnqueueRenderRequest,
          };

    const atomFetcherProvider: Provider = {
      provide: ATOM_FETCHER,
      useFactory: (cache: AtomCache, enqueueRenderRequest: EnqueueRenderRequest): AtomFetcher => ({
        getAtom: <T>(args: {
          domain: string;
          entityId: string;
          atomKey: string;
          valueSchema: { parse(input: unknown): T };
          timeoutS?: number;
          jobId?: string;
        }) =>
          getAtom({
            cache,
            enqueueRenderRequest,
            bridgeId: options.bridgeId ?? getLeaderConfig().instanceId,
            domain: args.domain,
            entityId: args.entityId,
            atomKey: args.atomKey,
            valueSchema: args.valueSchema as unknown as ZodType<T, ZodTypeDef, unknown>,
            timeoutS: args.timeoutS,
            jobId: args.jobId,
          }),
      }),
      inject: [RedisService, DEVICE_RECORD_RENDER_ENQUEUER],
    };

    const providers: Provider[] = [
      ...(cacheProvider !== null ? [cacheProvider] : []),
      agentTokenProvider,
      deviceRecordCacheProvider,
      deviceRecordEnqueuerProvider,
      DeviceRecordService,
      atomFetcherProvider,
      NetplanAtomService,
      InitrdOrchestrationService,
    ];

    // only re-export RedisService when this module provides it; re-exporting a non-local provider crashes Nest
    const exports: DynamicModule['exports'] =
      cacheProvider !== null ? [InitrdOrchestrationService, RedisService] : [InitrdOrchestrationService];

    return {
      module: InitrdModule,
      controllers: [InitrdController],
      providers,
      exports,
    };
  }
}
