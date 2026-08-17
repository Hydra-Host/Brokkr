import { Module } from '@nestjs/common';

import { JobIdModule } from '../../common/job-id.module';
import { ContextLogger } from '../../logger/logger.service';

import { createGlobalFetchPrometheusFetcher } from './prometheus-fetch.adapter';
import { createSnappyJsCompressor } from './prometheus-snappy.adapter';
import { PrometheusController } from './prometheus.controller';
import { PROMETHEUS_SERVICE_FACTORY, type PrometheusServiceFactory } from './prometheus.factory';
import {
  PROMETHEUS_DNS_LOOKUP,
  PROMETHEUS_FETCH,
  PROMETHEUS_SNAPPY,
  createPrometheusMonitoringService,
  type DnsLookup,
  type PrometheusFetcher,
  type SnappyCompressor,
} from './prometheus.service';

@Module({
  imports: [JobIdModule],
  controllers: [PrometheusController],
  providers: [
    {
      provide: PROMETHEUS_FETCH,
      useFactory: (): PrometheusFetcher => createGlobalFetchPrometheusFetcher(),
    },
    {
      provide: PROMETHEUS_SNAPPY,
      useFactory: (): SnappyCompressor => createSnappyJsCompressor(),
    },
    {
      provide: PROMETHEUS_SERVICE_FACTORY,
      useFactory: (
        fetcher: PrometheusFetcher,
        snappy: SnappyCompressor,
        logger: ContextLogger,
        dnsLookupOverride?: DnsLookup,
      ): PrometheusServiceFactory => ({
        create: (jobId: string) => createPrometheusMonitoringService(jobId, logger, fetcher, snappy, dnsLookupOverride),
      }),
      inject: [PROMETHEUS_FETCH, PROMETHEUS_SNAPPY, ContextLogger, { token: PROMETHEUS_DNS_LOOKUP, optional: true }],
    },
  ],
  exports: [PROMETHEUS_SERVICE_FACTORY, PROMETHEUS_FETCH, PROMETHEUS_SNAPPY],
})
export class MonitoringPrometheusModule {}
