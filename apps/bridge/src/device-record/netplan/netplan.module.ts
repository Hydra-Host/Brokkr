import { DynamicModule, Module, Provider, Type } from '@nestjs/common';

import type { AtomCache, AtomFetcherLogger, EnqueueRenderRequest } from '../atom/atom-fetcher';

import {
  INITRD_NETPLAN_ATOM,
  INITRD_NETPLAN_LOGGER,
  InitrdNetplanService,
  type InitrdNetplanLogger,
  type NetplanAtomLike,
} from './initrd-netplan.service';
import {
  NETPLAN_ATOM_BRIDGE_ID,
  NETPLAN_ATOM_CACHE,
  NETPLAN_ATOM_LOGGER,
  NETPLAN_ATOM_RENDER_ENQUEUER,
  NetplanAtomService,
} from './netplan-atom.service';

export interface NetplanModuleOptions {
  netplanAtom?: NetplanAtomLike;
  cache?: AtomCache;
  cacheToken?: Type<AtomCache> | symbol | string;
  enqueueRenderRequest?: EnqueueRenderRequest;
  enqueueRenderRequestToken?: Type<unknown> | symbol | string;
  bridgeId: string;
  logger?: InitrdNetplanLogger;
  atomLogger?: AtomFetcherLogger;
}

@Module({})
export class NetplanModule {
  static forRoot(options: NetplanModuleOptions): DynamicModule {
    if (options.enqueueRenderRequest === undefined && options.enqueueRenderRequestToken === undefined) {
      throw new Error(
        'NetplanModule.forRoot: exactly one of `enqueueRenderRequest` (value) or `enqueueRenderRequestToken` (DI token) must be supplied',
      );
    }
    if (options.cache === undefined && options.cacheToken === undefined) {
      throw new Error(
        'NetplanModule.forRoot: exactly one of `cache` (value) or `cacheToken` (DI token) must be supplied',
      );
    }

    const enqueuerProvider: Provider =
      options.enqueueRenderRequestToken !== undefined
        ? {
            provide: NETPLAN_ATOM_RENDER_ENQUEUER,
            useFactory: (enqueuer: EnqueueRenderRequest) => enqueuer,
            inject: [options.enqueueRenderRequestToken],
          }
        : {
            provide: NETPLAN_ATOM_RENDER_ENQUEUER,
            useValue: options.enqueueRenderRequest as EnqueueRenderRequest,
          };

    const cacheProvider: Provider =
      options.cacheToken !== undefined
        ? {
            provide: NETPLAN_ATOM_CACHE,
            useFactory: (cache: AtomCache) => cache,
            inject: [options.cacheToken],
          }
        : {
            provide: NETPLAN_ATOM_CACHE,
            useValue: options.cache as AtomCache,
          };

    const netplanAtomProvider: Provider =
      options.netplanAtom !== undefined
        ? { provide: INITRD_NETPLAN_ATOM, useValue: options.netplanAtom }
        : { provide: INITRD_NETPLAN_ATOM, useExisting: NetplanAtomService };

    const providers: Provider[] = [
      netplanAtomProvider,
      cacheProvider,
      enqueuerProvider,
      { provide: NETPLAN_ATOM_BRIDGE_ID, useValue: options.bridgeId },
      ...(options.logger ? [{ provide: INITRD_NETPLAN_LOGGER, useValue: options.logger } satisfies Provider] : []),
      ...(options.atomLogger
        ? [{ provide: NETPLAN_ATOM_LOGGER, useValue: options.atomLogger } satisfies Provider]
        : []),
      InitrdNetplanService,
      NetplanAtomService,
    ];
    return {
      module: NetplanModule,
      global: true,
      providers,
      exports: [InitrdNetplanService, NetplanAtomService],
    };
  }
}
