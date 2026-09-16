import { Module } from '@nestjs/common';
import { RedisModule } from 'src/common/redis';
import { JobLogWriterService } from './job-log-writer.service';

@Module({
  imports: [RedisModule],
  providers: [JobLogWriterService],
  exports: [JobLogWriterService],
})
export class JobLogWriterModule {}
