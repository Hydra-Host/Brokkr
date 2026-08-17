import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices.module';
import { DeviceStatusEffectsConsumer } from './device-status-effects.consumer';
import { DEVICE_STATUS_EFFECTS_QUEUE } from './device-status-effects.types';

@Module({
  imports: [BullModule.registerQueue({ name: DEVICE_STATUS_EFFECTS_QUEUE }), DevicesModule],
  providers: [DeviceStatusEffectsConsumer],
})
export class DeviceStatusEffectsModule {}
