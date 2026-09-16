import { Module, type Provider } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service.js';
import { DhcpConfigReaderService } from '../dhcp/dhcp-config-reader.service.js';
import { DnsConfigReaderService } from '../dns/dns-config-reader.service.js';
import { ContextLogger } from '../logger/logger.service.js';

import { BootReadinessController } from './boot-readiness.controller.js';
import {
  BOOT_READINESS_CHECKS,
  buildLiveBootReadinessChecks,
  type BootReadinessCheckFactory,
} from './boot-readiness.js';

const bootReadinessChecksProvider: Provider = {
  provide: BOOT_READINESS_CHECKS,
  useFactory: (redis: RedisService, logger: ContextLogger): BootReadinessCheckFactory => {
    const dhcp = new DhcpConfigReaderService(redis, logger);
    const dns = new DnsConfigReaderService(redis, logger);
    return (jobId) => buildLiveBootReadinessChecks({ dhcp, dns, jobId });
  },
  inject: [RedisService, ContextLogger],
};

@Module({
  controllers: [BootReadinessController],
  providers: [bootReadinessChecksProvider],
})
export class DiagnosticsModule {}
