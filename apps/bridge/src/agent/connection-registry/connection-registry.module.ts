import { DynamicModule, Module, Provider } from '@nestjs/common';

import { ConnectionRegistry } from './connection-registry.service';

@Module({
  providers: [ConnectionRegistry],
  exports: [ConnectionRegistry],
})
export class ConnectionRegistryModule {
  static forRoot(options: { registry?: ConnectionRegistry; global?: boolean } = {}): DynamicModule {
    const provider: Provider = options.registry
      ? { provide: ConnectionRegistry, useValue: options.registry }
      : ConnectionRegistry;
    return {
      module: ConnectionRegistryModule,
      global: options.global ?? false,
      providers: [provider],
      exports: [ConnectionRegistry],
    };
  }
}
