import {
  BRIDGE_AGENT_DISPATCH,
  BRIDGE_PLUGIN_KV,
  definePlugin,
  type BridgeAgentDispatch,
  type BridgePluginKv,
} from '@hydrahost/plugin-sdk';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { Dispatcher } from '../../agent/dispatch/dispatcher.service.js';
import { RedisService } from '../../common/redis/redis.service.js';

import { resolveBridgePluginBackends } from '../resolve-plugin-backends.js';

@Module({})
class DemoPluginModule {}

@Module({})
class SecondPluginModule {}

@Injectable()
class AlphaProbe {
  constructor(
    @Inject(BRIDGE_PLUGIN_KV) readonly kv: BridgePluginKv,
    @Inject(BRIDGE_AGENT_DISPATCH) readonly agentDispatch: BridgeAgentDispatch,
  ) {}
}

@Module({ providers: [AlphaProbe] })
class AlphaProbeModule {}

@Injectable()
class BetaProbe {
  constructor(
    @Inject(BRIDGE_PLUGIN_KV) readonly kv: BridgePluginKv,
    @Inject(BRIDGE_AGENT_DISPATCH) readonly agentDispatch: BridgeAgentDispatch,
  ) {}
}

@Module({ providers: [BetaProbe] })
class BetaProbeModule {}

const setCalls: Array<{ key: string; value: string }> = [];

const fakeRedis = {
  get: async () => null,
  set: async (key: string, value: string) => {
    setCalls.push({ key, value });
    return 'OK';
  },
  delete: async () => 0,
  scan: async () => [],
};

@Global()
@Module({
  providers: [{ provide: RedisService, useValue: fakeRedis }],
  exports: [RedisService],
})
class FakeRedisModule {}

const dispatchCalls: Array<{ deviceId: string; operation: string }> = [];

const fakeDispatcher = {
  dispatch: async (deviceId: string, operation: string) => {
    dispatchCalls.push({ deviceId, operation });
    return { ok: true };
  },
};

@Global()
@Module({
  providers: [{ provide: Dispatcher, useValue: fakeDispatcher }],
  exports: [Dispatcher],
})
class FakeDispatcherModule {}

describe('resolveBridgePluginBackends', () => {
  it('skips disabled entries and entries without a backend module', async () => {
    const disabled = definePlugin({
      id: 'disabled',
      version: '0.0.1',
      bridgeModule: () => Promise.resolve(DemoPluginModule),
    });
    const backendless = definePlugin({ id: 'backendless', version: '0.0.1' });

    const resolved = await resolveBridgePluginBackends([
      { plugin: disabled, enabled: false },
      { plugin: backendless, enabled: true },
    ]);

    expect(resolved).toEqual([]);
  });

  it('resolves default and bare module exports and scopes a kv per plugin', async () => {
    const bare = definePlugin({
      id: 'bare',
      version: '0.0.1',
      bridgeModule: () => Promise.resolve(DemoPluginModule),
    });
    const wrapped = definePlugin({
      id: 'wrapped',
      version: '0.0.1',
      bridgeModule: () => Promise.resolve({ default: DemoPluginModule }),
    });

    const resolved = await resolveBridgePluginBackends([
      { plugin: bare, enabled: true },
      { plugin: wrapped, enabled: true },
    ]);

    expect(resolved).toHaveLength(2);
    for (const dynamicModule of resolved) {
      expect(dynamicModule.module).toBe(DemoPluginModule);
      expect(dynamicModule.imports).toHaveLength(1);
      const kvScope = dynamicModule.imports?.[0];
      const providers =
        typeof kvScope === 'object' && kvScope !== null && 'providers' in kvScope ? kvScope.providers : [];
      expect(providers?.[0]).toMatchObject({ provide: BRIDGE_PLUGIN_KV });
      expect(providers?.[1]).toMatchObject({ provide: BRIDGE_AGENT_DISPATCH });
      expect(kvScope).toMatchObject({ exports: [BRIDGE_PLUGIN_KV, BRIDGE_AGENT_DISPATCH] });
    }
  });
});

describe('resolveBridgePluginBackends kv isolation', () => {
  it('mints a distinct kv scope module class per plugin', async () => {
    const first = definePlugin({
      id: 'first',
      version: '0.0.1',
      bridgeModule: () => Promise.resolve(DemoPluginModule),
    });
    const second = definePlugin({
      id: 'second',
      version: '0.0.1',
      bridgeModule: () => Promise.resolve(SecondPluginModule),
    });

    const resolved = await resolveBridgePluginBackends([
      { plugin: first, enabled: true },
      { plugin: second, enabled: true },
    ]);

    const scopeClasses = resolved.map((dynamicModule) => {
      const scope = dynamicModule.imports?.[0];
      return typeof scope === 'object' && scope !== null && 'module' in scope ? scope.module : null;
    });
    expect(scopeClasses[0]).not.toBeNull();
    expect(scopeClasses[0]).not.toBe(scopeClasses[1]);
  });

  it('resolves a differently-prefixed kv inside each plugin module in a real nest app', async () => {
    setCalls.splice(0);
    const resolved = await resolveBridgePluginBackends([
      {
        plugin: definePlugin({
          id: 'alpha',
          version: '0.0.1',
          bridgeModule: () => Promise.resolve(AlphaProbeModule),
        }),
        enabled: true,
      },
      {
        plugin: definePlugin({
          id: 'beta',
          version: '0.0.1',
          bridgeModule: () => Promise.resolve(BetaProbeModule),
        }),
        enabled: true,
      },
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [FakeRedisModule, FakeDispatcherModule, ...resolved],
    }).compile();
    const alpha = moduleRef.get(AlphaProbe, { strict: false });
    const beta = moduleRef.get(BetaProbe, { strict: false });

    await alpha.kv.set('k', '1');
    await beta.kv.set('k', '2');
    dispatchCalls.splice(0);
    await alpha.agentDispatch.dispatch('dev-1', 'ping', {});
    await beta.agentDispatch.dispatch('dev-2', 'ping', {});
    await moduleRef.close();

    expect(setCalls.map((call) => call.key)).toEqual(['plugin:alpha:k', 'plugin:beta:k']);
    expect(dispatchCalls).toEqual([
      { deviceId: 'dev-1', operation: 'alpha.ping' },
      { deviceId: 'dev-2', operation: 'beta.ping' },
    ]);
  });
});
