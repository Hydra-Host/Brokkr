import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { DeviceTestRunsService } from './device-test-runs.service';

@Module({
  imports: [PrismaModule],
  providers: [DeviceTestRunsService],
  exports: [DeviceTestRunsService],
})
export class DeviceTestRunsModule {}
