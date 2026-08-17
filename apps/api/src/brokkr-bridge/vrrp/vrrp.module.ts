import { Module } from '@nestjs/common';
import { RedisModule } from 'src/common/redis';
import { VrrpRedisWriterService } from './vrrp-redis-writer.service';

@Module({
  imports: [RedisModule],
  providers: [VrrpRedisWriterService],
  exports: [VrrpRedisWriterService],
})
export class VrrpModule {}
