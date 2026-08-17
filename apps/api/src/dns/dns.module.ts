import { Module } from '@nestjs/common';
import { DnsRecordsModule } from 'src/brokkr-bridge/dns/dns-records.module';
import { ContextModule } from 'src/common/context/context.module';
import { PrismaModule } from 'src/prisma';
import { DnsController } from './dns.controller';
import { DnsService } from './dns.service';

@Module({
  imports: [PrismaModule, ContextModule, DnsRecordsModule],
  controllers: [DnsController],
  providers: [DnsService],
})
export class DnsModule {}
