import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';

import bridgePluginsConfig from '../plugins.config.js';

import { activePluginRoster, setActiveBridgePlugins } from './active-plugins-holder.js';
import { buildBridgePluginConfigProviders } from './bridge-plugin-config-providers.js';
import { HostBridgePluginEventBus } from './bridge-plugin-event-bus.js';
import { setBridgePluginEventBus } from './bridge-plugin-event-holder.js';

const pluginConfigProviders = buildBridgePluginConfigProviders(bridgePluginsConfig);
const pluginConfigTokens = pluginConfigProviders.map((provider) =>
  typeof provider === 'object' && 'provide' in provider ? provider.provide : provider,
);

setActiveBridgePlugins(activePluginRoster(bridgePluginsConfig));

@Global()
@Module({
  providers: [
    { provide: PLUGIN_EVENT_BUS, useFactory: () => new HostBridgePluginEventBus() },
    ...pluginConfigProviders,
  ],
  exports: [PLUGIN_EVENT_BUS, ...pluginConfigTokens],
})
export class BridgePluginHostModule implements OnModuleInit {
  constructor(@Inject(PLUGIN_EVENT_BUS) private readonly bus: PluginEventBus) {}

  onModuleInit(): void {
    setBridgePluginEventBus(this.bus);
  }
}
