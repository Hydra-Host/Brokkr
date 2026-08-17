import { DynamicModule, Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';

import type { PluginManifest } from '@hydrahost/plugin-sdk';

import { PluginMigrator, PluginMigratorLogger } from './migrator';

const PLUGIN_RUNTIME_OPTIONS = Symbol.for('@hydrahost/plugin-runtime/OPTIONS');

export interface PluginRuntimeOptions {
  manifests: PluginManifest[];
  connectionString?: string;
  logger?: PluginMigratorLogger;
}

@Injectable()
class PluginRuntimeBootstrap implements OnApplicationBootstrap {
  constructor(@Inject(PLUGIN_RUNTIME_OPTIONS) private readonly options: PluginRuntimeOptions) {}

  async onApplicationBootstrap(): Promise<void> {
    const connectionString = this.options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'PluginRuntimeModule requires a database connection string ' +
          '(set DATABASE_URL or pass options.connectionString).',
      );
    }
    const migrator = new PluginMigrator(connectionString, this.options.logger);
    await migrator.applyAll(this.options.manifests);
  }
}

@Module({})
export class PluginRuntimeModule {
  static forRoot(options: PluginRuntimeOptions): DynamicModule {
    return {
      module: PluginRuntimeModule,
      providers: [{ provide: PLUGIN_RUNTIME_OPTIONS, useValue: options }, PluginRuntimeBootstrap],
    };
  }
}
