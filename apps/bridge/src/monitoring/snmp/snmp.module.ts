import { Module } from '@nestjs/common';

import { MonitoringSnmpController } from './snmp.controller';

@Module({
  controllers: [MonitoringSnmpController],
})
export class MonitoringSnmpModule {}
