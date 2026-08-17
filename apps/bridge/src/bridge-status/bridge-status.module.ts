import { Module } from '@nestjs/common';

import { SnmpModule } from '../snmp/snmp.module.js';

import { BridgeStatusController } from './bridge-status.controller.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [SnmpModule],
  controllers: [BridgeStatusController, HealthController],
})
export class BridgeStatusModule {}
