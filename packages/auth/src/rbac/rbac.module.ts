import { DynamicModule, Module, Type } from '@nestjs/common';
import { PrismaClient } from '@repo/database';
import { RBAC_CONFIG } from './constants';
import { PRISMA_CLIENT, RbacResolverService } from './rbac-resolver.service';
import { RbacService } from './rbac.service';
import type { RbacConfig } from './types';

export interface RbacModuleOptions {
  config: RbacConfig;
  prismaClient: { useExisting: Type<PrismaClient> } | PrismaClient;
}

@Module({})
export class RbacModule {
  static forRoot(options: RbacModuleOptions): DynamicModule {
    const prismaProvider =
      'useExisting' in options.prismaClient
        ? { provide: PRISMA_CLIENT, useExisting: options.prismaClient.useExisting }
        : { provide: PRISMA_CLIENT, useValue: options.prismaClient };

    return {
      module: RbacModule,
      global: true,
      providers: [{ provide: RBAC_CONFIG, useValue: options.config }, prismaProvider, RbacResolverService, RbacService],
      exports: [RbacResolverService, RbacService, RBAC_CONFIG],
    };
  }
}
