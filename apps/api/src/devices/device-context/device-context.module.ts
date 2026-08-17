import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { DeviceContextBuilder } from './device-context.builder';

@Module({
  imports: [PrismaModule],
  providers: [DeviceContextBuilder],
  exports: [DeviceContextBuilder],
})
export class DeviceContextModule {}
