import { Module } from '@nestjs/common';
import { DeviceSecretCoreModule } from 'src/device-secret/device-secret-core.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { DeviceContextService } from '../device-context.service';

@Module({
  imports: [PrismaModule, DeviceSecretCoreModule],
  providers: [DeviceContextService],
  exports: [DeviceContextService],
})
export class DeviceContextModule {}
