import { MiddlewareConsumer, Module, type DynamicModule, type Type } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { PrismaModule } from './prisma';
import { PrismaClient } from './prisma/prisma.client';

import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthModule } from './auth/auth.module';
import { BmcModule } from './bmc/bmc.module';
import { BrokkrBridgeModule } from './brokkr-bridge/brokkr-bridge.module';
import { CommonModule } from './common/common.module';
import { ContextModule } from './common/context/context.module';
import { DeploymentsModule } from './deployments/deployments.module';
import { DeviceTestRunsModule } from './device-test-runs/device-test-runs.module';
import { EventLogModule } from './event-log/event-log.module';
import { InventoryModule } from './inventory/inventory.module';
import { IpamModule } from './ipam/ipam.module';
import { LoggerModule } from './logger/logger.module';
import { WebhookModule } from './webhook/webhook.module';

import { PluginRuntimeModule } from '@hydrahost/plugin-runtime';
import { PLUGIN_GATE_BUS, PLUGIN_RATE_LIMITER, PLUGIN_REDIS_CLIENT } from '@hydrahost/plugin-sdk';
import pluginsConfig, { editionOverrides } from '@hydrahost/plugins-config';
import { BullModule } from '@nestjs/bullmq';
import { ActiveRecordModule } from '@repo/active-record';
import { getBullMqTelemetry } from '@repo/telemetry';
import type Redis from 'ioredis';
import { join } from 'path';
import { AppController } from './app.controller';
import { BgpModule } from './bgp/bgp.module';
import { CircuitsModule } from './circuits/circuits.module';
import { CloudInitTemplatesModule } from './cloud-init-templates/cloud-init-templates.module';
import { CommissioningModule } from './commissioning/commissioning.module';
import { ActiveRecordContextProvider } from './common/context/active-record-context.provider';
import { ContextMiddleware } from './common/context/context.middleware';
import { LoggingMiddleware } from './common/logging-middleware';
import { REDIS_CLIENT, RedisModule } from './common/redis';
import { createRedisConnectionConfig } from './common/redis/redis.config';
import { DcimBridgesModule } from './dcim-bridges/dcim-bridges.module';
import { CduModule } from './dcim/cdu/cdu.module';
import { DcimModule } from './dcim/dcim.module';
import { PduModule } from './dcim/pdu/pdu.module';
import { RouterModule } from './dcim/router/router.module';
import { SwitchModule } from './dcim/switch/switch.module';
import { DeviceModelModule } from './device-models/device-model.module';
import { DeviceSecretModule } from './device-secret/device-secret.module';
import { DeviceTokensModule } from './device-tokens/device-tokens.module';
import { DeviceStatusEffectsModule } from './devices/device-status-effects/device-status-effects.module';
import { DevicesModule } from './devices/devices.module';
import { DnsModule } from './dns/dns.module';
import { EditionModule } from './edition/edition.module';
import { EmailModule } from './email/email.module';
import { PluginEmailModule } from './email/plugin-email.module';
import { EventsModule } from './events/events.module';
import { HeartbeatMonitorModule } from './heartbeat-monitor/heartbeat-monitor.module';
import { PluginIpamProvisioningModule } from './ipam/plugin-ipam-provisioning.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { PluginLifecycleControlModule } from './lifecycle/plugin-lifecycle-control.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PermissionsModule } from './permissions/permissions.module';
import {
  HostPluginGateBusModule,
  PLUGIN_GATE_BUS_SCOPED_FACTORY,
  type ScopedGateBusFactory,
} from './plugin-host/host-plugin-gate-bus.module';
import { createPluginRateLimiter } from './plugin-host/host-plugin-rate-limiter';
import { createNamespacedRedisClient } from './plugin-host/host-plugin-redis-client';
import { PluginHostModule } from './plugin-host/plugin-host.module';
import { PluginsMetaController } from './plugin-host/plugins-meta.controller';
import { ProvisionModule } from './provision/provision.module';
import { RegionsModule } from './regions/regions.module';
import { ReservationsModule } from './reservations/reservations.module';
import { SshKeysModule } from './sshkeys/sshkeys.module';
import { TagModule } from './tags/tag.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { UsersModule } from './users/users.module';
import { ZoneCryptoModule } from './zone-crypto/zone-crypto.module';
import { ZonesModule } from './zones/zones.module';

const enabledPluginEntries = pluginsConfig.filter((entry) => entry.enabled);
const enabledPluginManifests = enabledPluginEntries.map((entry) => entry.plugin);

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot({ wildcard: true, maxListeners: 20 }),
    ScheduleModule.forRoot(),
    EditionModule.register(editionOverrides),
    ...(process.env.NODE_ENV === 'production'
      ? [
          ServeStaticModule.forRoot({
            rootPath: join(__dirname, '../..', 'web', 'dist'),
            exclude: ['/api/{*path}'],
            serveStaticOptions: {
              fallthrough: true,
            },
          }),
        ]
      : []),
    ActiveRecordModule.forRoot(PrismaClient, {
      contextProvider: { useExisting: ActiveRecordContextProvider },
    }),
    PluginHostModule,
    PluginRuntimeModule.forRoot({ manifests: enabledPluginManifests }),
    ContextModule,
    LoggerModule.forRoot(),
    RedisModule,
    AuthModule,
    BgpModule,
    BmcModule,
    BrokkrBridgeModule,
    CircuitsModule,
    CloudInitTemplatesModule,
    CommonModule,
    DcimModule,
    DnsModule,
    PduModule,
    CduModule,
    SwitchModule,
    RouterModule,
    DcimBridgesModule,
    DeploymentsModule,
    DeviceModelModule,
    DeviceTokensModule,
    DeviceStatusEffectsModule,
    DeviceTestRunsModule,
    DevicesModule,
    EmailModule,
    EventsModule,
    HeartbeatMonitorModule,
    InventoryModule,
    IpamModule,
    PluginIpamProvisioningModule,
    PermissionsModule,
    OrganizationsModule,
    PrismaModule,
    LifecycleModule,
    PluginLifecycleControlModule,
    PluginEmailModule,
    ProvisionModule,
    RegionsModule,
    ReservationsModule,
    SshKeysModule,
    TagModule,
    TelemetryModule,
    CommissioningModule,
    UsersModule,
    EventLogModule,
    WebhookModule,
    DeviceSecretModule,
    ZoneCryptoModule,
    ZonesModule,
    BullModule.forRoot({
      connection: (() => {
        const redisConnectionConfig = createRedisConnectionConfig({
          redisUrl: process.env.REDIS_URL,
          redisCaCert: process.env.REDIS_CA_CERT,
          nodeTlsRejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
        });

        if (!redisConnectionConfig) {
          throw new Error('REDIS_URL must be defined to configure BullModule');
        }

        return {
          url: redisConnectionConfig.url,
          ...(redisConnectionConfig.tls ? { tls: redisConnectionConfig.tls } : {}),
        };
      })(),
      telemetry: getBullMqTelemetry('brokkr-hub'),
    }),
  ],
  controllers: [AppController, PluginsMetaController],
  providers: [],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ContextMiddleware, LoggingMiddleware).forRoutes('*');
  }

  static async withPluginBackends(): Promise<DynamicModule> {
    const resolved: DynamicModule[] = [];
    for (const entry of enabledPluginEntries) {
      const thunk = entry.plugin.backendModule;
      if (!thunk) continue;
      const mod = await thunk();
      const moduleClass = ('default' in mod ? mod.default : mod) as Type<unknown>;
      // Bind PLUGIN_GATE_BUS to the trusted manifest id, never plugin-asserted — a plugin must not veto another's gates.
      resolved.push(AppModule.scopedPluginModule(moduleClass, entry.plugin.id));
    }
    return {
      module: AppModule,
      imports: resolved,
    };
  }

  private static scopedPluginModule(moduleClass: Type<unknown>, pluginId: string): DynamicModule {
    return {
      module: moduleClass,
      imports: [AppModule.scopedGateBusModule(pluginId), AppModule.scopedRedisModule(pluginId)],
    };
  }

  private static scopedRedisModule(pluginId: string): DynamicModule {
    const ScopedRedisModule = class {};
    Object.defineProperty(ScopedRedisModule, 'name', { value: `ScopedRedisModule(${pluginId})` });
    return {
      module: ScopedRedisModule,
      providers: [
        {
          provide: PLUGIN_REDIS_CLIENT,
          useFactory: (redis: Redis) => createNamespacedRedisClient(redis, pluginId),
          inject: [REDIS_CLIENT],
        },
        {
          provide: PLUGIN_RATE_LIMITER,
          useFactory: (redis: Redis) => createPluginRateLimiter(redis, pluginId),
          inject: [REDIS_CLIENT],
        },
      ],
      exports: [PLUGIN_RATE_LIMITER, PLUGIN_REDIS_CLIENT],
    };
  }

  private static scopedGateBusModule(pluginId: string): DynamicModule {
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
}
