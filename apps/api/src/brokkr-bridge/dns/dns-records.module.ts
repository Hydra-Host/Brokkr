import { Module } from '@nestjs/common';
import { RedisModule } from 'src/common/redis';
import { PrismaModule } from 'src/prisma';
import { DnsRecordDerivationService } from './dns-record-derivation.service';
import { DnsRecordsPublisherService } from './dns-records-publisher.service';
import { DnsRecordsReconcilerService } from './dns-records-reconciler.service';
import { DnsRecordsRedisWriterService } from './dns-records-redis-writer.service';

@Module({
  imports: [RedisModule, PrismaModule],
  providers: [
    DnsRecordsRedisWriterService,
    DnsRecordsReconcilerService,
    DnsRecordsPublisherService,
    DnsRecordDerivationService,
  ],
  exports: [DnsRecordsPublisherService],
})
export class DnsRecordsModule {}
