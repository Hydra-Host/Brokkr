import { buildPluginConfigProviders } from '@hydrahost/plugin-runtime';
import { PLUGIN_PRISMA_CLIENT, PLUGIN_REQUEST_CONTEXT } from '@hydrahost/plugin-sdk';
import { Global, Module, type Provider } from '@nestjs/common';

import pluginsConfig from '@hydrahost/plugins-config';
import { ContextModule } from '../common/context/context.module';
import { PrismaClient } from '../prisma/prisma.client';
import { PrismaModule } from '../prisma/prisma.module';
import { HostPluginGateBus } from './host-plugin-gate-bus';
import { HostPluginGateBusModule } from './host-plugin-gate-bus.module';
import { HostPluginRequestContext } from './host-plugin-request-context';
import { PluginEventBusModule } from './plugin-event-bus.module';

const pluginConfigProviders: Provider[] = buildPluginConfigProviders(pluginsConfig);
const pluginConfigTokens = pluginConfigProviders.map((p) => (typeof p === 'object' && 'provide' in p ? p.provide : p));

const GATE_ALLOWLIST_SEEDED = Symbol.for('@hydrahost/plugin-host/GATE_ALLOWLIST_SEEDED');

function seedGateAllowlist(gateBus: HostPluginGateBus): HostPluginGateBus {
  for (const entry of pluginsConfig) {
    if (!entry.enabled) continue;
    gateBus.authorize(entry.plugin.id, entry.plugin.allowedGates);
  }
  return gateBus;
}

@Global()
@Module({
  imports: [PrismaModule, PluginEventBusModule, HostPluginGateBusModule, ContextModule],
  providers: [
    { provide: PLUGIN_PRISMA_CLIENT, useExisting: PrismaClient },
    HostPluginRequestContext,
    { provide: PLUGIN_REQUEST_CONTEXT, useExisting: HostPluginRequestContext },
    { provide: GATE_ALLOWLIST_SEEDED, useFactory: seedGateAllowlist, inject: [HostPluginGateBus] },
    ...pluginConfigProviders,
  ],
  exports: [PLUGIN_PRISMA_CLIENT, PLUGIN_REQUEST_CONTEXT, PluginEventBusModule, ...pluginConfigTokens],
})
export class PluginHostModule {}
