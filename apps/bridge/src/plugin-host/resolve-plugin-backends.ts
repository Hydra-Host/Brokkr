import { BRIDGE_AGENT_DISPATCH, BRIDGE_PLUGIN_KV, type PluginManifest } from '@hydrahost/plugin-sdk';
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import type { z } from 'zod';

import { Dispatcher } from '../agent/dispatch/dispatcher.service.js';
import { RedisService } from '../common/redis/redis.service.js';

import { PrefixedBridgeAgentDispatch } from './bridge-plugin-dispatch.js';
import { PrefixedBridgePluginKv } from './bridge-plugin-kv.js';

interface BackendEntry {
  plugin: PluginManifest<z.ZodTypeAny | undefined>;
  enabled: boolean;
}

function hasDefaultExport(mod: { default: Type<unknown> } | Type<unknown>): mod is { default: Type<unknown> } {
  return typeof mod === 'object' && mod !== null && 'default' in mod;
}

function scopedBridgePluginModule(moduleClass: Type<unknown>, pluginId: string): DynamicModule {
  @Module({})
  class BridgePluginScopeModule {}

  const scope: DynamicModule = {
    module: BridgePluginScopeModule,
    providers: [
      {
        provide: BRIDGE_PLUGIN_KV,
        useFactory: (redis: RedisService) => new PrefixedBridgePluginKv(redis, pluginId),
        inject: [RedisService],
      },
      {
        provide: BRIDGE_AGENT_DISPATCH,
        useFactory: (dispatcher: Dispatcher) => new PrefixedBridgeAgentDispatch(dispatcher, pluginId),
        inject: [Dispatcher],
      },
    ],
    exports: [BRIDGE_PLUGIN_KV, BRIDGE_AGENT_DISPATCH],
  };
  return {
    module: moduleClass,
    imports: [scope],
  };
}

export async function resolveBridgePluginBackends(entries: readonly BackendEntry[]): Promise<DynamicModule[]> {
  const resolved: DynamicModule[] = [];
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const thunk = entry.plugin.bridgeModule;
    if (!thunk) continue;
    const mod = await thunk();
    const moduleClass = hasDefaultExport(mod) ? mod.default : mod;
    resolved.push(scopedBridgePluginModule(moduleClass, entry.plugin.id));
  }
  return resolved;
}
