import { Module } from '@nestjs/common';
import { BrokkrBridgeModule } from 'src/brokkr-bridge/brokkr-bridge.module';
import { DeviceSecretModule } from 'src/device-secret/device-secret.module';
import { LoggerModule } from 'src/logger/logger.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CommissioningController } from './commissioning.controller';
import { CommissioningService } from './commissioning.service';

@Module({
  imports: [PrismaModule, LoggerModule.forRoot(), BrokkrBridgeModule, DeviceSecretModule],
  controllers: [CommissioningController],
  providers: [CommissioningService],
  exports: [CommissioningService],
})
export class CommissioningModule {}
