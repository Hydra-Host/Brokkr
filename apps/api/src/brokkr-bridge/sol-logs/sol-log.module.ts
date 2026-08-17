import { Module } from '@nestjs/common';
import { RedisModule } from 'src/common/redis';
import { SolLogService } from './sol-log.service';

@Module({
  imports: [RedisModule],
  providers: [SolLogService],
  exports: [SolLogService],
})
export class SolLogModule {}
