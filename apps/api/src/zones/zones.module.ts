import { Module } from '@nestjs/common';
import { DhcpConfigModule } from 'src/brokkr-bridge/dhcp/dhcp-config.module';
import { DnsConfigModule } from 'src/brokkr-bridge/dns/dns-config.module';
import { DnsRecordsModule } from 'src/brokkr-bridge/dns/dns-records.module';
import { ContextModule } from 'src/common/context/context.module';
import { IpamModule } from 'src/ipam/ipam.module';
import { LoggerModule } from 'src/logger/logger.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { RegionsModule } from 'src/regions/regions.module';
import { DnsConfigController } from './dns-config.controller';
import { DnsConfigService } from './dns-config.service';
import { ServiceTuningController } from './service-tuning.controller';
import { ServiceTuningService } from './service-tuning.service';
import { ZoneRedisAclService } from './zone-redis-acl.service';
import { ZonesController } from './zones.controller';
import { ZonesService } from './zones.service';

@Module({
  imports: [
    PrismaModule,
    ContextModule,
    LoggerModule.forRoot(),
    RegionsModule,
    IpamModule,
    DhcpConfigModule,
    DnsConfigModule,
    DnsRecordsModule,
  ],
  controllers: [ZonesController, DnsConfigController, ServiceTuningController],
  providers: [ZonesService, ZoneRedisAclService, DnsConfigService, ServiceTuningService],
  exports: [ZonesService, ZoneRedisAclService],
})
export class ZonesModule {}
