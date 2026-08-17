import { Module } from '@nestjs/common';

import { MonitoringIcmpController } from './icmp.controller';
import { createIcmpService } from './icmp.service';
import { ICMP_SERVICE_FACTORY, type IcmpService, type IcmpServiceFactory } from './icmp.types';

const icmpServiceFactory: IcmpServiceFactory = {
  create(jobId: string): IcmpService {
    return createIcmpService(jobId);
  },
};

@Module({
  controllers: [MonitoringIcmpController],
  providers: [{ provide: ICMP_SERVICE_FACTORY, useValue: icmpServiceFactory }],
  exports: [ICMP_SERVICE_FACTORY],
})
export class MonitoringIcmpModule {}
