import { Module } from '@nestjs/common';
import { DeviceContextModule } from 'src/brokkr-bridge/device-context/device-context.module';
import { SolLogModule } from 'src/brokkr-bridge/sol-logs/sol-log.module';
import { RedisModule } from 'src/common/redis';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { PrismaModule } from 'src/prisma/prisma.module';
import { JobLogsController } from './job-logs.controller';
import { JobLogsService } from './job-logs.service';
import { DEVICE_PIN, type DevicePin, JobSolLogsService } from './job-sol-logs.service';

@Module({
  imports: [PrismaModule, RedisModule, DeviceContextModule, SolLogModule],
  controllers: [JobLogsController],
  providers: [
    JobLogsService,
    JobSolLogsService,
    { provide: DEVICE_PIN, useValue: BaremetalRecord satisfies DevicePin },
  ],
})
export class JobLogsModule {}
