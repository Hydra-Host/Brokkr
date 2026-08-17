import { Module } from '@nestjs/common';
import { RedisModule } from 'src/common/redis';
import { NetplanModule as DeviceNetplanModule } from 'src/devices/netplan/netplan.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { NetplanPublisherService } from './netplan-publisher.service';
import { NetplanRedisWriterService } from './netplan-redis-writer.service';

@Module({
  imports: [DeviceNetplanModule, PrismaModule, RedisModule],
  providers: [NetplanPublisherService, NetplanRedisWriterService],
  exports: [NetplanPublisherService, NetplanRedisWriterService],
})
export class NetplanModule {}
