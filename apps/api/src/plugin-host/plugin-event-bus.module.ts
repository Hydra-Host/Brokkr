import { PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { Global, Module } from '@nestjs/common';

import { HostPluginEventBus } from './host-plugin-event-bus';

@Global()
@Module({
  providers: [HostPluginEventBus, { provide: PLUGIN_EVENT_BUS, useExisting: HostPluginEventBus }],
  exports: [PLUGIN_EVENT_BUS, HostPluginEventBus],
})
export class PluginEventBusModule {}
