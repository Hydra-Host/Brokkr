import { Module } from '@nestjs/common';
import { BrokkrBridgeModule } from 'src/brokkr-bridge/brokkr-bridge.module';
import { DeviceTokensModule } from 'src/device-tokens/device-tokens.module';
import { LifecycleModule } from 'src/lifecycle/lifecycle.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PhoneHomeController } from './phone-home/phone-home.controller';
import { PhoneHomeGuard } from './phone-home/phone-home.guard';
import { PhoneHomeRepository } from './phone-home/phone-home.repository';
import { PhoneHomeService } from './phone-home/phone-home.service';

@Module({
  imports: [BrokkrBridgeModule, DeviceTokensModule, LifecycleModule, PrismaModule],
  controllers: [PhoneHomeController],
  providers: [PhoneHomeService, PhoneHomeRepository, PhoneHomeGuard],
})
export class BmcModule {}
