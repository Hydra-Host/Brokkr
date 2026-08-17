import { DynamicModule, type ForwardReference, Module, Provider, type Type } from '@nestjs/common';

import type {
  AgentVersionGate,
  CancelWorkEncoder,
  ConnectionRegistry as DispatcherConnectionRegistry,
  DispatchLogger,
  ResultPublisher,
} from './dispatcher.service';
import { Dispatcher } from './dispatcher.service';

export interface DispatchModuleDeps {
  registry: DispatcherConnectionRegistry;
  publisher: ResultPublisher;
  logger: DispatchLogger;
  versionGate: AgentVersionGate;
  cancelEncoder: CancelWorkEncoder;
}

export type DispatchInjectToken = Type<unknown> | string | symbol;

export interface DispatchModuleOptions {
  deps: (...injected: unknown[]) => DispatchModuleDeps;
  inject?: readonly DispatchInjectToken[];
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  global?: boolean;
}

@Module({})
export class DispatchModule {
  static forRoot(options: DispatchModuleOptions): DynamicModule {
    const provider: Provider = {
      provide: Dispatcher,
      useFactory: (...injected: unknown[]) => {
        const deps = options.deps(...injected);
        return new Dispatcher(deps.registry, deps.publisher, deps.logger, deps.versionGate, deps.cancelEncoder);
      },
      inject: (options.inject ?? []) as DispatchInjectToken[],
    };
    return {
      module: DispatchModule,
      global: options.global ?? false,
      imports: options.imports ?? [],
      providers: [provider],
      exports: [Dispatcher],
    };
  }
}
