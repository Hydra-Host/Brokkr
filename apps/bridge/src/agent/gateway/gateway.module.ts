import { DynamicModule, Module, Provider, type ForwardReference, type Type } from '@nestjs/common';

import { AgentServicer } from './agent.servicer';
import type { AgentServicerDeps } from './agent.servicer.types';
import {
  DeviceAuthInterceptor,
  type AuthContextBinder,
  type AuthInterceptorLogger,
  type TokenVerifierPort,
} from './auth.interceptor';
import {
  GrpcServerService,
  type AgentServicerFactory,
  type AuthInterceptorFactory,
  type GrpcServerOptions,
  type GrpcTransportFactory,
} from './grpc-server.service';
import { GrpcTransportFactoryImpl, type GrpcTransportFactoryOptions } from './grpc-transport.factory';

export interface AuthInterceptorDeps {
  tokenService: TokenVerifierPort;
  binder: AuthContextBinder;
  logger: AuthInterceptorLogger;
}

export type GatewayInjectToken = Type<unknown> | string | symbol;

export interface GatewayModuleOptions {
  agentServicerDeps: (...injected: unknown[]) => AgentServicerDeps;
  agentServicerDepsInject?: readonly GatewayInjectToken[];
  authInterceptorDeps: (...injected: unknown[]) => AuthInterceptorDeps;
  authInterceptorDepsInject?: readonly GatewayInjectToken[];
  transportFactory?: GrpcTransportFactory;
  transportFactoryOptions?: GrpcTransportFactoryOptions;
  serverOptions?: GrpcServerOptions;
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
}

@Module({})
export class GatewayModule {
  static forRoot(options: GatewayModuleOptions): DynamicModule {
    const agentServicerInject = (options.agentServicerDepsInject ?? []) as GatewayInjectToken[];
    const authInterceptorInject = (options.authInterceptorDepsInject ?? []) as GatewayInjectToken[];

    const servicerProvider: Provider = {
      provide: AgentServicer,
      useFactory: (...injected: unknown[]) => new AgentServicer(options.agentServicerDeps(...injected)),
      inject: agentServicerInject,
    };
    const interceptorProvider: Provider = {
      provide: DeviceAuthInterceptor,
      useFactory: (...injected: unknown[]) => {
        const deps = options.authInterceptorDeps(...injected);
        return new DeviceAuthInterceptor(deps.tokenService, deps.binder, deps.logger);
      },
      inject: authInterceptorInject,
    };
    const transportFactoryProvider: Provider = {
      provide: GrpcTransportFactoryImpl,
      useFactory: () => options.transportFactory ?? new GrpcTransportFactoryImpl(options.transportFactoryOptions),
    };
    const grpcServerServiceInject: GatewayInjectToken[] = [
      GrpcTransportFactoryImpl,
      ...agentServicerInject,
      ...authInterceptorInject,
    ];
    const grpcServerServiceProvider: Provider = {
      provide: GrpcServerService,
      useFactory: (...injected: unknown[]): GrpcServerService => {
        const transport = injected[0] as GrpcTransportFactory;
        const agentServicerArgs = injected.slice(1, 1 + agentServicerInject.length);
        const authInterceptorArgs = injected.slice(1 + agentServicerInject.length);
        const servicerFactory: AgentServicerFactory = {
          build: () => new AgentServicer(options.agentServicerDeps(...agentServicerArgs)),
        };
        const authInterceptorFactory: AuthInterceptorFactory = {
          build: () => {
            const deps = options.authInterceptorDeps(...authInterceptorArgs);
            return new DeviceAuthInterceptor(deps.tokenService, deps.binder, deps.logger);
          },
        };
        return new GrpcServerService({
          servicerFactory,
          authInterceptorFactory,
          transportFactory: transport,
          options: options.serverOptions,
        });
      },
      inject: grpcServerServiceInject,
    };
    return {
      module: GatewayModule,
      imports: options.imports ?? [],
      providers: [servicerProvider, interceptorProvider, transportFactoryProvider, grpcServerServiceProvider],
      exports: [AgentServicer, DeviceAuthInterceptor, GrpcTransportFactoryImpl, GrpcServerService],
    };
  }
}
