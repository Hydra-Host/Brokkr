import { DynamicModule, Module, Provider, Type } from '@nestjs/common';

import { ContextLogger } from '../logger/logger.service';

import {
  AUTO_COLLECTION_CACHE,
  AUTO_COLLECTION_ENQUEUE,
  AUTO_COLLECTION_LOGGER,
  AUTO_COLLECTION_READ_ATOM,
  AutoCollectionService,
  type AutoCollectionCache,
  type AutoCollectionLogger,
  type EnqueueCollectionJob,
  type ReadAtom,
} from './auto-collection.service';

export interface AutoCollectionModuleDeps {
  cache: AutoCollectionCache;
  readAtom: ReadAtom;
  enqueueCollectionJob?: EnqueueCollectionJob;
  logger?: AutoCollectionLogger;
}

export interface AutoCollectionModuleOptions {
  deps?: () => AutoCollectionModuleDeps;
  enqueueCollectionJobToken?: Type<unknown> | symbol | string;
  cacheToken?: Type<unknown> | symbol | string;
  readAtomToken?: Type<unknown> | symbol | string;
}

@Module({})
export class AutoCollectionModule {
  static forRoot(options: AutoCollectionModuleOptions): DynamicModule {
    const requireDeps = (): AutoCollectionModuleDeps => {
      if (options.deps === undefined) {
        throw new Error(
          'AutoCollectionModule.forRoot: value-form `deps` was not supplied and a token-less provider was requested',
        );
      }
      return options.deps();
    };

    const enqueueProvider: Provider =
      options.enqueueCollectionJobToken !== undefined
        ? {
            provide: AUTO_COLLECTION_ENQUEUE,
            useFactory: (enqueuer: EnqueueCollectionJob) => enqueuer,
            inject: [options.enqueueCollectionJobToken],
          }
        : {
            provide: AUTO_COLLECTION_ENQUEUE,
            useFactory: () => {
              const resolved = requireDeps().enqueueCollectionJob;
              if (resolved === undefined) {
                throw new Error(
                  'AutoCollectionModule.forRoot: deps().enqueueCollectionJob is undefined and no enqueueCollectionJobToken was supplied',
                );
              }
              return resolved;
            },
          };

    const cacheProvider: Provider =
      options.cacheToken !== undefined
        ? {
            provide: AUTO_COLLECTION_CACHE,
            useFactory: (cache: AutoCollectionCache) => cache,
            inject: [options.cacheToken],
          }
        : {
            provide: AUTO_COLLECTION_CACHE,
            useFactory: () => requireDeps().cache,
          };

    const readAtomProvider: Provider =
      options.readAtomToken !== undefined
        ? {
            provide: AUTO_COLLECTION_READ_ATOM,
            useFactory: (readAtom: ReadAtom) => readAtom,
            inject: [options.readAtomToken],
          }
        : {
            provide: AUTO_COLLECTION_READ_ATOM,
            useFactory: () => requireDeps().readAtom,
          };

    const providers: Provider[] = [
      cacheProvider,
      readAtomProvider,
      enqueueProvider,
      {
        provide: AUTO_COLLECTION_LOGGER,
        useFactory: (defaultLogger: ContextLogger) => options.deps?.().logger ?? defaultLogger,
        inject: [ContextLogger],
      },
      AutoCollectionService,
    ];
    return {
      module: AutoCollectionModule,
      providers,
      exports: [AutoCollectionService],
    };
  }
}
