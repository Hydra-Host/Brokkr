import { Module } from '@nestjs/common';
import { RedisModule } from 'src/common/redis';
import { PrismaModule } from 'src/prisma';
import { DhcpConfigPublisherService } from './dhcp-config-publisher.service';
import { DhcpConfigReconcilerService } from './dhcp-config-reconciler.service';
import { DhcpConfigRedisWriterService } from './dhcp-config-redis-writer.service';
import { DhcpDerivationService } from './dhcp-derivation.service';
import { DhcpLeaseReaderService } from './dhcp-lease-reader.service';

@Module({
  imports: [RedisModule, PrismaModule],
  providers: [
    DhcpConfigRedisWriterService,
    DhcpDerivationService,
    DhcpConfigReconcilerService,
    DhcpConfigPublisherService,
    DhcpLeaseReaderService,
  ],
  exports: [DhcpConfigRedisWriterService, DhcpDerivationService, DhcpConfigPublisherService, DhcpLeaseReaderService],
})
export class DhcpConfigModule {}
