import type { PluginGateBus } from '@hydrahost/plugin-sdk';
import { Module } from '@nestjs/common';

import { HostPluginGateBus } from './host-plugin-gate-bus';

export const PLUGIN_GATE_BUS_SCOPED_FACTORY = Symbol.for('@hydrahost/plugin-host/PLUGIN_GATE_BUS_SCOPED_FACTORY');

export type ScopedGateBusFactory = (pluginId: string) => PluginGateBus;

@Module({
  providers: [
    HostPluginGateBus,
    {
      provide: PLUGIN_GATE_BUS_SCOPED_FACTORY,
      useFactory:
        (gateBus: HostPluginGateBus): ScopedGateBusFactory =>
        (pluginId) =>
          gateBus.scopedFor(pluginId),
      inject: [HostPluginGateBus],
    },
  ],
  exports: [HostPluginGateBus, PLUGIN_GATE_BUS_SCOPED_FACTORY],
})
export class HostPluginGateBusModule {}
