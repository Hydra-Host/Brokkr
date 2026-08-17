import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { DeviceModelController } from './device-model.controller';
import { DeviceModelRepository } from './device-model.repository';
import { DeviceModelService } from './device-model.service';

@Module({
  imports: [PrismaModule],
  controllers: [DeviceModelController],
  providers: [DeviceModelRepository, DeviceModelService],
  exports: [DeviceModelRepository],
})
export class DeviceModelModule {}
