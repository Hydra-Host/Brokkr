import {
  PLUGIN_DEVICE_OPS_REQUESTS,
  PLUGIN_LIFECYCLE,
  PLUGIN_LIFECYCLE_REQUESTS,
  PLUGIN_NETPLAN_RENDERER,
} from '@hydrahost/plugin-sdk';
import { Global, Module } from '@nestjs/common';

import { HostPluginNetplanRenderer } from 'src/devices/netplan/host-plugin-netplan-renderer';
import { NetplanModule } from 'src/devices/netplan/netplan.module';
import { HostPluginDeviceOpsRequests } from './host-plugin-device-ops-requests';
import { HostPluginLifecycleControl } from './host-plugin-lifecycle-control';
import { HostPluginLifecycleRequests } from './host-plugin-lifecycle-requests';
import { LifecycleModule } from './lifecycle.module';

@Global()
@Module({
  imports: [LifecycleModule, NetplanModule],
  providers: [
    HostPluginLifecycleControl,
    HostPluginLifecycleRequests,
    HostPluginDeviceOpsRequests,
    HostPluginNetplanRenderer,
    { provide: PLUGIN_LIFECYCLE, useExisting: HostPluginLifecycleControl },
    { provide: PLUGIN_LIFECYCLE_REQUESTS, useExisting: HostPluginLifecycleRequests },
    { provide: PLUGIN_DEVICE_OPS_REQUESTS, useExisting: HostPluginDeviceOpsRequests },
    { provide: PLUGIN_NETPLAN_RENDERER, useExisting: HostPluginNetplanRenderer },
  ],
  exports: [PLUGIN_LIFECYCLE, PLUGIN_LIFECYCLE_REQUESTS, PLUGIN_DEVICE_OPS_REQUESTS, PLUGIN_NETPLAN_RENDERER],
})
export class PluginLifecycleControlModule {}
