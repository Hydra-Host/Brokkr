import { Module } from '@nestjs/common';
import { DeviceContextModule } from 'src/brokkr-bridge/device-context/device-context.module';
import { RedisModule } from 'src/common/redis';
import { PrismaModule } from 'src/prisma/prisma.module';
import { JobLogsController } from './job-logs.controller';
import { JobLogsService } from './job-logs.service';

@Module({
  imports: [PrismaModule, RedisModule, DeviceContextModule],
  controllers: [JobLogsController],
  providers: [JobLogsService],
})
export class JobLogsModule {}
