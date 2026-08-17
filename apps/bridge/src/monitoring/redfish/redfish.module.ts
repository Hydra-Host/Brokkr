import { Module } from '@nestjs/common';

import { MonitoringRedfishController } from './redfish.controller.js';

@Module({
  controllers: [MonitoringRedfishController],
})
export class MonitoringRedfishModule {}
