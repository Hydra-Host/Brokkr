import { buildPluginConfigProviders } from '@hydrahost/plugin-runtime';
import {
  PLUGIN_AUTH_CLIENT,
  PLUGIN_IDENTITY_BINDER,
  PLUGIN_PRISMA_CLIENT,
  PLUGIN_REQUEST_CONTEXT,
} from '@hydrahost/plugin-sdk';
import { Global, Module, type Provider } from '@nestjs/common';

import pluginsConfig from '@hydrahost/plugins-config';
import { AuthClientModule } from '../auth/auth-client.module';
import { ContextModule } from '../common/context/context.module';
import { PrismaClient } from '../prisma/prisma.client';
import { PrismaModule } from '../prisma/prisma.module';
import { HostPluginAuthClient } from './host-plugin-auth-client';
import { HostPluginGateBus } from './host-plugin-gate-bus';
import { HostPluginGateBusModule } from './host-plugin-gate-bus.module';
import { HostPluginIdentityBinder } from './host-plugin-identity-binder';
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
  imports: [PrismaModule, PluginEventBusModule, HostPluginGateBusModule, ContextModule, AuthClientModule],
  providers: [
    { provide: PLUGIN_PRISMA_CLIENT, useExisting: PrismaClient },
    HostPluginRequestContext,
    { provide: PLUGIN_REQUEST_CONTEXT, useExisting: HostPluginRequestContext },
    HostPluginIdentityBinder,
    { provide: PLUGIN_IDENTITY_BINDER, useExisting: HostPluginIdentityBinder },
    HostPluginAuthClient,
    { provide: PLUGIN_AUTH_CLIENT, useExisting: HostPluginAuthClient },
    { provide: GATE_ALLOWLIST_SEEDED, useFactory: seedGateAllowlist, inject: [HostPluginGateBus] },
    ...pluginConfigProviders,
  ],
  exports: [
    PLUGIN_PRISMA_CLIENT,
    PLUGIN_REQUEST_CONTEXT,
    PLUGIN_IDENTITY_BINDER,
    PLUGIN_AUTH_CLIENT,
    PluginEventBusModule,
    ...pluginConfigTokens,
  ],
})
export class PluginHostModule {}
