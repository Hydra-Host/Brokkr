import { PLUGIN_IPAM_PROVISIONING } from '@hydrahost/plugin-sdk';
import { Global, Module } from '@nestjs/common';
import { HostPluginIpamProvisioning } from './host-plugin-ipam-provisioning';
import { IpamModule } from './ipam.module';

@Global()
@Module({
  imports: [IpamModule],
  providers: [
    HostPluginIpamProvisioning,
    { provide: PLUGIN_IPAM_PROVISIONING, useExisting: HostPluginIpamProvisioning },
  ],
  exports: [PLUGIN_IPAM_PROVISIONING],
})
export class PluginIpamProvisioningModule {}
