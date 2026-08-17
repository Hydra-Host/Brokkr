
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { ContextLogger } from '../../../logger/logger.service';
import { PROMETHEUS_SERVICE_FACTORY, type PrometheusServiceFactory } from '../prometheus.factory';
import { MonitoringPrometheusModule } from '../prometheus.module';
import {
  PROMETHEUS_FETCH,
  PROMETHEUS_SNAPPY,
  type PrometheusFetcher,
  type SnappyCompressor,
} from '../prometheus.service';

@Global()
@Module({
  providers: [{ provide: ContextLogger, useValue: new ContextLogger() }],
  exports: [ContextLogger],
})
class LoggerStubModule {}

describe('MonitoringPrometheusModule', () => {
  it('binds PROMETHEUS_FETCH to a real fetcher with get + post methods', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerStubModule, MonitoringPrometheusModule],
    }).compile();
    try {
      const fetcher = moduleRef.get<PrometheusFetcher>(PROMETHEUS_FETCH);
      expect(fetcher).toBeDefined();
      expect(typeof fetcher.get).toBe('function');
      expect(typeof fetcher.post).toBe('function');
    } finally {
      await moduleRef.close();
    }
  });

  it('binds PROMETHEUS_SNAPPY to a compressor that returns a Uint8Array', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerStubModule, MonitoringPrometheusModule],
    }).compile();
    try {
      const snappy = moduleRef.get<SnappyCompressor>(PROMETHEUS_SNAPPY);
      expect(snappy).toBeDefined();
      expect(typeof snappy.compress).toBe('function');
      const compressed = snappy.compress(new Uint8Array([1, 2, 3, 4]));
      expect(compressed).toBeInstanceOf(Uint8Array);
      expect(compressed.length).toBeGreaterThan(0);
    } finally {
      await moduleRef.close();
    }
  });

  it('exposes a PROMETHEUS_SERVICE_FACTORY that constructs services with fetcher + snappy bound', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerStubModule, MonitoringPrometheusModule],
    }).compile();
    try {
      const factory = moduleRef.get<PrometheusServiceFactory>(PROMETHEUS_SERVICE_FACTORY);
      const service = factory.create('job-xyz');
      expect(service.jobId).toBe('job-xyz');
      const other = factory.create('job-abc');
      expect(other.jobId).toBe('job-abc');
      expect(service).not.toBe(other);
    } finally {
      await moduleRef.close();
    }
  });
});
