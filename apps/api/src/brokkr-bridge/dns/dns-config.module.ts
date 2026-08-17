import { Module } from '@nestjs/common';
import { RedisModule } from 'src/common/redis';
import { PrismaModule } from 'src/prisma';
import { DnsConfigPublisherService } from './dns-config-publisher.service';
import { DnsConfigReconcilerService } from './dns-config-reconciler.service';
import { DnsConfigRedisWriterService } from './dns-config-redis-writer.service';
import { DnsDerivationService } from './dns-derivation.service';

@Module({
  imports: [RedisModule, PrismaModule],
  providers: [DnsConfigRedisWriterService, DnsDerivationService, DnsConfigReconcilerService, DnsConfigPublisherService],
  exports: [DnsConfigRedisWriterService, DnsDerivationService, DnsConfigPublisherService],
})
export class DnsConfigModule {}
