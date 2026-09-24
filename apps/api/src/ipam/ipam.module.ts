import { Module } from '@nestjs/common';
import { DhcpConfigModule } from 'src/brokkr-bridge/dhcp/dhcp-config.module';
import { DnsConfigModule } from 'src/brokkr-bridge/dns/dns-config.module';
import { NetplanModule } from 'src/brokkr-bridge/netplan/netplan.module';
import { VrrpReconcilerService } from 'src/brokkr-bridge/vrrp/vrrp-reconciler.service';
import { VrrpModule } from 'src/brokkr-bridge/vrrp/vrrp.module';
import { PrismaModule } from 'src/prisma';
import { IpamChangelogController } from './changelog/changelog.controller';
import { IpamChangelogRepository } from './changelog/changelog.repository';
import { IpamChangelogService } from './changelog/changelog.service';
import { GatewayController } from './gateway/gateway.controller';
import { GatewayRepository } from './gateway/gateway.repository';
import { GatewayService } from './gateway/gateway.service';
import { IpAddressController } from './ip-address/ip-address.controller';
import { IpAddressRepository } from './ip-address/ip-address.repository';
import { IpAddressService } from './ip-address/ip-address.service';
import { IpRangeController } from './ip-range/ip-range.controller';
import { IpRangeRepository } from './ip-range/ip-range.repository';
import { IpRangeService } from './ip-range/ip-range.service';
import { IpamRoleController } from './ipam-role/ipam-role.controller';
import { IpamRoleRepository } from './ipam-role/ipam-role.repository';
import { IpamRoleService } from './ipam-role/ipam-role.service';
import { PrefixBootReadinessService } from './prefix/prefix-boot-readiness.service';
import { PrefixController } from './prefix/prefix.controller';
import { PrefixRepository } from './prefix/prefix.repository';
import { PrefixService } from './prefix/prefix.service';
import { VlanGroupController } from './vlan-group/vlan-group.controller';
import { VlanGroupRepository } from './vlan-group/vlan-group.repository';
import { VlanGroupService } from './vlan-group/vlan-group.service';
import { VlanController } from './vlan/vlan.controller';
import { VlanRepository } from './vlan/vlan.repository';
import { VlanService } from './vlan/vlan.service';
import { VrfController } from './vrf/vrf.controller';
import { VrfRepository } from './vrf/vrf.repository';
import { VrfService } from './vrf/vrf.service';

@Module({
  imports: [PrismaModule, VrrpModule, DhcpConfigModule, DnsConfigModule, NetplanModule],
  controllers: [
    VrfController,
    PrefixController,
    IpAddressController,
    VlanController,
    VlanGroupController,
    IpRangeController,
    IpamChangelogController,
    IpamRoleController,
    GatewayController,
  ],
  providers: [
    VrfService,
    VrfRepository,
    PrefixService,
    PrefixRepository,
    PrefixBootReadinessService,
    IpAddressService,
    IpAddressRepository,
    VlanService,
    VlanRepository,
    VlanGroupService,
    VlanGroupRepository,
    IpRangeService,
    IpRangeRepository,
    IpamChangelogService,
    IpamChangelogRepository,
    IpamRoleService,
    IpamRoleRepository,
    GatewayService,
    GatewayRepository,
    VrrpReconcilerService,
  ],
  exports: [
    VlanGroupRepository,
    IpamRoleRepository,
    GatewayRepository,
    PrefixService,
    PrefixRepository,
    PrefixBootReadinessService,
    IpAddressService,
    IpRangeService,
  ],
})
export class IpamModule {}
