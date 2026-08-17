import { PLUGIN_GATE_BUS, type PluginGateBus } from '@hydrahost/plugin-sdk';
import { Inject, Injectable, Module, Optional, type DynamicModule, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { HostPluginGateBus } from '../host-plugin-gate-bus';
import {
  HostPluginGateBusModule,
  PLUGIN_GATE_BUS_SCOPED_FACTORY,
  type ScopedGateBusFactory,
} from '../host-plugin-gate-bus.module';

function scopedGateBusModule(pluginId: string): DynamicModule {
  const ScopedGateBusModule = class {};
  Object.defineProperty(ScopedGateBusModule, 'name', { value: `ScopedGateBusModule(${pluginId})` });
  return {
    module: ScopedGateBusModule,
    imports: [HostPluginGateBusModule],
    providers: [
      {
        provide: PLUGIN_GATE_BUS,
        useFactory: (scopedFor: ScopedGateBusFactory) => scopedFor(pluginId),
        inject: [PLUGIN_GATE_BUS_SCOPED_FACTORY],
      },
    ],
    exports: [PLUGIN_GATE_BUS],
  };
}

@Injectable()
class PluginProbe {
  constructor(
    @Inject(PLUGIN_GATE_BUS) readonly bus: PluginGateBus,
    @Optional() @Inject(PLUGIN_GATE_BUS_SCOPED_FACTORY) readonly factory?: ScopedGateBusFactory,
  ) {}
}

function pluginModule(pluginId: string): Type<unknown> {
  @Module({
    imports: [scopedGateBusModule(pluginId)],
    providers: [PluginProbe],
  })
  class PluginModule {}
  return PluginModule;
}

describe('scoped gate bus DI encapsulation', () => {
  it('binds a plugin its own PLUGIN_GATE_BUS but hides the spoofable scoping factory', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [pluginModule('victim')] }).compile();
    const probe = moduleRef.get(PluginProbe, { strict: false });
    expect(probe.bus).toBeDefined();
    expect(typeof probe.bus.register).toBe('function');
    expect(probe.factory).toBeUndefined();
    await moduleRef.close();
  });

  it('shares one HostPluginGateBus singleton across scoped wrappers so the host-seeded allowlist applies', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HostPluginGateBusModule, scopedGateBusModule('p1'), scopedGateBusModule('p2')],
    }).compile();
    const seen = new Set<HostPluginGateBus>();
    seen.add(moduleRef.get(HostPluginGateBus, { strict: false }));
    expect(seen.size).toBe(1);
    await moduleRef.close();
  });
});
