import { Module } from '@nestjs/common';
import { ContextModule } from 'src/common/context/context.module';
import { PrismaModule } from 'src/prisma';
import { DeviceContextModule } from '../device-context/device-context.module';
import { NetplanController } from './netplan.controller';
import { NetplanService } from './netplan.service';

// Bridge callers inject NetplanService directly, bypassing the controller's org gate — they validate device ownership elsewhere.
@Module({
  imports: [DeviceContextModule, ContextModule, PrismaModule],
  controllers: [NetplanController],
  providers: [NetplanService],
  exports: [NetplanService],
})
export class NetplanModule {}
