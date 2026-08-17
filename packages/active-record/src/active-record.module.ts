import { DynamicModule, Global, Module, Type } from '@nestjs/common';
import { PrismaClient } from '@repo/database';
import type { ActiveRecordContext } from './active-record.context';
import { ActiveRecordRegistry } from './active-record.registry';

export interface ActiveRecordContextProviderLike {
  getContext(): ActiveRecordContext | undefined;
}

interface ForRootOptions {
  contextProvider?: { useExisting: Type<ActiveRecordContextProviderLike> };
}

@Global()
@Module({})
export class ActiveRecordModule {
  static forRoot(prismaToken: Type<PrismaClient> | symbol | string, options?: ForRootOptions): DynamicModule {
    const providers = options?.contextProvider
      ? [
          {
            provide: 'ACTIVE_RECORD_CONFIGURED',
            useFactory: (prisma: PrismaClient, ctxProvider: ActiveRecordContextProviderLike) => {
              ActiveRecordRegistry.configure(prisma, () => ctxProvider.getContext());
              return true;
            },
            inject: [prismaToken, options.contextProvider.useExisting],
          },
        ]
      : [
          {
            provide: 'ACTIVE_RECORD_CONFIGURED',
            useFactory: (prisma: PrismaClient) => {
              ActiveRecordRegistry.configure(prisma);
              return true;
            },
            inject: [prismaToken],
          },
        ];

    return {
      module: ActiveRecordModule,
      global: true,
      providers,
    };
  }
}
