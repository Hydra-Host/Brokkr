import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter as OtlpHttpJsonTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OtlpProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTraceExporter,
  CountingLogExporter,
  CountingMetricExporter,
  CountingSpanExporter,
  resolveLogsExporter,
  resolveMetricsExporter,
} from '../sdk';
import { getTelemetryStatus } from '../status';

class FakeExporter implements SpanExporter {
  exported: number[] = [];
  flushed = 0;
  constructor(
    private readonly result: ExportResult,
    private readonly withForceFlush = false,
  ) {
    if (withForceFlush) {
      this.forceFlush = () => {
        this.flushed += 1;
        return Promise.resolve();
      };
    }
  }
  forceFlush?: () => Promise<void>;
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.exported.push(spans.length);
    resultCallback(this.result);
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function exportOneSpan(exporter: CountingSpanExporter): void {
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.getTracer('test').startSpan('span').end();
}

describe('CountingSpanExporter', () => {
  it('counts successful exports and exported spans in the status', () => {
    const before = getTelemetryStatus();
    const inner = new FakeExporter({ code: ExportResultCode.SUCCESS });
    const counting = new CountingSpanExporter(inner);
    exportOneSpan(counting);
    exportOneSpan(counting);
    const after = getTelemetryStatus();
    expect(inner.exported).toEqual([1, 1]);
    expect(after.exportsSucceeded - before.exportsSucceeded).toBe(2);
    expect(after.spansExported - before.spansExported).toBe(2);
    expect(after.exportsFailed - before.exportsFailed).toBe(0);
  });

  it('records failures with the exporter error message', () => {
    const before = getTelemetryStatus();
    const counting = new CountingSpanExporter(
      new FakeExporter({ code: ExportResultCode.FAILED, error: new Error('collector unreachable') }),
    );
    exportOneSpan(counting);
    const after = getTelemetryStatus();
    expect(after.exportsFailed - before.exportsFailed).toBe(1);
    expect(after.lastErrorMessage).toBe('collector unreachable');
    expect(after.spansExported - before.spansExported).toBe(0);
  });

  it('delegates shutdown and falls back when the inner exporter lacks forceFlush', async () => {
    const counting = new CountingSpanExporter(new FakeExporter({ code: ExportResultCode.SUCCESS }));
    await expect(counting.shutdown()).resolves.toBeUndefined();
    await expect(counting.forceFlush()).resolves.toBeUndefined();
  });

  it('delegates forceFlush to the inner exporter when present', async () => {
    const inner = new FakeExporter({ code: ExportResultCode.SUCCESS }, true);
    const counting = new CountingSpanExporter(inner);
    await counting.forceFlush();
    expect(inner.flushed).toBe(1);
  });
});

class FakeMetricExporter implements PushMetricExporter {
  exports = 0;
  flushed = 0;
  shutdowns = 0;
  selectAggregationTemporality?: PushMetricExporter['selectAggregationTemporality'];
  selectAggregation?: PushMetricExporter['selectAggregation'];
  constructor(private readonly result: ExportResult) {}
  export(_metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.exports += 1;
    resultCallback(this.result);
  }
  forceFlush(): Promise<void> {
    this.flushed += 1;
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    this.shutdowns += 1;
    return Promise.resolve();
  }
}

async function collectResourceMetrics(): Promise<ResourceMetrics> {
  const reader = new PeriodicExportingMetricReader({
    exporter: new FakeMetricExporter({ code: ExportResultCode.SUCCESS }),
    exportIntervalMillis: 3_600_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  provider.getMeter('test').createCounter('hits').add(1);
  const { resourceMetrics } = await reader.collect();
  await provider.shutdown();
  return resourceMetrics;
}

describe('CountingMetricExporter', () => {
  it('counts successful metric exports in the status', async () => {
    const before = getTelemetryStatus();
    const inner = new FakeMetricExporter({ code: ExportResultCode.SUCCESS });
    const counting = new CountingMetricExporter(inner);
    const metricsData = await collectResourceMetrics();
    await new Promise<void>((resolveExport) => counting.export(metricsData, () => resolveExport()));
    const after = getTelemetryStatus();
    expect(inner.exports).toBe(1);
    expect(after.metricExportsSucceeded - before.metricExportsSucceeded).toBe(1);
    expect(after.metricExportsFailed - before.metricExportsFailed).toBe(0);
  });

  it('records metric export failures with the exporter error message', async () => {
    const before = getTelemetryStatus();
    const counting = new CountingMetricExporter(
      new FakeMetricExporter({ code: ExportResultCode.FAILED, error: new Error('metrics endpoint unreachable') }),
    );
    const metricsData = await collectResourceMetrics();
    const result = await new Promise<ExportResult>((resolveExport) => counting.export(metricsData, resolveExport));
    expect(result.code).toBe(ExportResultCode.FAILED);
    const after = getTelemetryStatus();
    expect(after.metricExportsFailed - before.metricExportsFailed).toBe(1);
    expect(after.lastMetricErrorMessage).toBe('metrics endpoint unreachable');
  });

  it('delegates aggregation selection only when the inner exporter implements it', () => {
    const bare = new CountingMetricExporter(new FakeMetricExporter({ code: ExportResultCode.SUCCESS }));
    expect(bare.selectAggregationTemporality).toBeUndefined();
    expect(bare.selectAggregation).toBeUndefined();

    const delta = new FakeMetricExporter({ code: ExportResultCode.SUCCESS });
    delta.selectAggregationTemporality = () => AggregationTemporality.DELTA;
    delta.selectAggregation = () => ({ type: AggregationType.DEFAULT });
    const counting = new CountingMetricExporter(delta);
    expect(counting.selectAggregationTemporality?.(InstrumentType.COUNTER)).toBe(AggregationTemporality.DELTA);
    expect(counting.selectAggregation?.(InstrumentType.COUNTER)).toEqual({ type: AggregationType.DEFAULT });
  });

  it('delegates forceFlush and shutdown to the inner exporter', async () => {
    const inner = new FakeMetricExporter({ code: ExportResultCode.SUCCESS });
    const counting = new CountingMetricExporter(inner);
    await counting.forceFlush();
    await counting.shutdown();
    expect(inner.flushed).toBe(1);
    expect(inner.shutdowns).toBe(1);
  });
});

describe('buildTraceExporter', () => {
  const KEYS = ['OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns the console exporter for the console kind', () => {
    expect(buildTraceExporter('console')).toBeInstanceOf(ConsoleSpanExporter);
  });

  it('defaults to http/protobuf', () => {
    expect(buildTraceExporter('otlp')).toBeInstanceOf(OtlpProtoTraceExporter);
  });

  it('honors OTEL_EXPORTER_OTLP_PROTOCOL=http/json', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
    expect(buildTraceExporter('otlp')).toBeInstanceOf(OtlpHttpJsonTraceExporter);
  });

  it('prefers the per-signal traces protocol over the base protocol', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'http/protobuf';
    expect(buildTraceExporter('otlp')).toBeInstanceOf(OtlpProtoTraceExporter);
  });

  it('rejects unsupported protocols with a clear error', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    expect(() => buildTraceExporter('otlp')).toThrow(/not supported/);
  });
});

describe('startSdk (mocked NodeSDK)', () => {
  const KEYS = [
    'OTEL_METRICS_EXPORTER',
    'OTEL_LOGS_EXPORTER',
    'OTEL_TRACES_SAMPLER',
    'OTEL_TRACES_SAMPLER_ARG',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_PROTOCOL',
    'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
    'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
    'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    'OTEL_METRIC_EXPORT_INTERVAL',
  ];

  it('pins env defaults (respecting pre-set values), starts the sdk, and delegates shutdown', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const start = vi.fn();
    const shutdown = vi.fn(() => Promise.resolve());
    const nodeSdkCtor = vi.fn(function mockNodeSdk() {
      return { start, shutdown };
    });
    vi.doMock('@opentelemetry/sdk-node', () => ({ NodeSDK: nodeSdkCtor }));
    const saved: Record<string, string | undefined> = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OTEL_TRACES_SAMPLER = 'always_off';
    try {
      const sdkModule = await import('../sdk.js');
      const handle = sdkModule.startSdk({ serviceName: 'svc', exporter: 'console', preset: 'hub' });
      expect(process.env.OTEL_METRICS_EXPORTER).toBe('none');
      expect(process.env.OTEL_LOGS_EXPORTER).toBe('none');
      expect(process.env.OTEL_TRACES_SAMPLER).toBe('always_off');
      expect(process.env.OTEL_TRACES_SAMPLER_ARG).toBe('1.0');
      expect(nodeSdkCtor).toHaveBeenCalledWith(expect.objectContaining({ serviceName: 'svc' }));
      expect(start).toHaveBeenCalledOnce();
      await handle.shutdown();
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('@opentelemetry/sdk-node');
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('constructs a metric reader when the otlp endpoint enables metrics', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const start = vi.fn();
    const shutdown = vi.fn(() => Promise.resolve());
    const nodeSdkCtor = vi.fn(function mockNodeSdk() {
      return { start, shutdown };
    });
    vi.doMock('@opentelemetry/sdk-node', () => ({ NodeSDK: nodeSdkCtor }));
    const saved: Record<string, string | undefined> = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    try {
      const sdkModule = await import('../sdk.js');
      sdkModule.startSdk({ serviceName: 'svc', exporter: 'otlp', preset: 'hub' });
      expect(nodeSdkCtor).toHaveBeenCalledWith(expect.objectContaining({ metricReaders: [expect.anything()] }));
      expect(process.env.OTEL_METRICS_EXPORTER).toBe('none');
      const statusModule = await import('../status.js');
      expect(statusModule.getTelemetryStatus().metricsEnabled).toBe(true);
    } finally {
      vi.doUnmock('@opentelemetry/sdk-node');
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('constructs a log record processor when the otlp endpoint enables logs', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const start = vi.fn();
    const shutdown = vi.fn(() => Promise.resolve());
    const nodeSdkCtor = vi.fn(function mockNodeSdk() {
      return { start, shutdown };
    });
    vi.doMock('@opentelemetry/sdk-node', () => ({ NodeSDK: nodeSdkCtor }));
    const saved: Record<string, string | undefined> = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    try {
      const sdkModule = await import('../sdk.js');
      sdkModule.startSdk({ serviceName: 'svc', exporter: 'otlp', preset: 'hub' });
      expect(nodeSdkCtor).toHaveBeenCalledWith(expect.objectContaining({ logRecordProcessors: [expect.anything()] }));
      expect(process.env.OTEL_LOGS_EXPORTER).toBe('none');
      const statusModule = await import('../status.js');
      expect(statusModule.getTelemetryStatus().logsEnabled).toBe(true);
    } finally {
      vi.doUnmock('@opentelemetry/sdk-node');
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('continues without logs when the log processor cannot be built', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const start = vi.fn();
    const shutdown = vi.fn(() => Promise.resolve());
    const nodeSdkCtor = vi.fn(function mockNodeSdk() {
      return { start, shutdown };
    });
    vi.doMock('@opentelemetry/sdk-node', () => ({ NodeSDK: nodeSdkCtor }));
    const saved: Record<string, string | undefined> = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'grpc';
    try {
      const sdkModule = await import('../sdk.js');
      sdkModule.startSdk({ serviceName: 'svc', exporter: 'otlp', preset: 'hub' });
      expect(start).toHaveBeenCalledOnce();
      expect(nodeSdkCtor).toHaveBeenCalledWith(expect.not.objectContaining({ logRecordProcessors: expect.anything() }));
      const statusModule = await import('../status.js');
      expect(statusModule.getTelemetryStatus().logsEnabled).toBe(false);
      expect(statusModule.getTelemetryStatus().metricsEnabled).toBe(true);
    } finally {
      vi.doUnmock('@opentelemetry/sdk-node');
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('degrades to traces-only when the metric reader cannot be built', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const start = vi.fn();
    const shutdown = vi.fn(() => Promise.resolve());
    const nodeSdkCtor = vi.fn(function mockNodeSdk() {
      return { start, shutdown };
    });
    vi.doMock('@opentelemetry/sdk-node', () => ({ NodeSDK: nodeSdkCtor }));
    const saved: Record<string, string | undefined> = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'grpc';
    try {
      const sdkModule = await import('../sdk.js');
      sdkModule.startSdk({ serviceName: 'svc', exporter: 'otlp', preset: 'hub' });
      expect(start).toHaveBeenCalledOnce();
      expect(nodeSdkCtor).toHaveBeenCalledWith(expect.not.objectContaining({ metricReaders: expect.anything() }));
      const statusModule = await import('../status.js');
      expect(statusModule.getTelemetryStatus().metricsEnabled).toBe(false);
    } finally {
      vi.doUnmock('@opentelemetry/sdk-node');
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

class FakeLogExporter implements LogRecordExporter {
  exports = 0;
  flushed = 0;
  shutdowns = 0;
  constructor(private readonly result: ExportResult) {}
  export(_records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.exports += 1;
    resultCallback(this.result);
  }
  forceFlush(): Promise<void> {
    this.flushed += 1;
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    this.shutdowns += 1;
    return Promise.resolve();
  }
}

async function exportOneLogRecord(exporter: CountingLogExporter): Promise<void> {
  const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
  provider.getLogger('test').emit({ body: 'record', severityNumber: 9 });
  await provider.forceFlush();
  await provider.shutdown();
}

describe('CountingLogExporter', () => {
  it('counts successful log exports in the status', async () => {
    const before = getTelemetryStatus();
    const inner = new FakeLogExporter({ code: ExportResultCode.SUCCESS });
    await exportOneLogRecord(new CountingLogExporter(inner));
    const after = getTelemetryStatus();
    expect(inner.exports).toBe(1);
    expect(after.logExportsSucceeded - before.logExportsSucceeded).toBe(1);
    expect(after.logExportsFailed - before.logExportsFailed).toBe(0);
  });

  it('records log export failures with the exporter error message', async () => {
    const before = getTelemetryStatus();
    const counting = new CountingLogExporter(
      new FakeLogExporter({ code: ExportResultCode.FAILED, error: new Error('logs endpoint unreachable') }),
    );
    await exportOneLogRecord(counting);
    const after = getTelemetryStatus();
    expect(after.logExportsFailed - before.logExportsFailed).toBe(1);
    expect(after.lastLogErrorMessage).toBe('logs endpoint unreachable');
  });

  it('delegates forceFlush and shutdown to the inner exporter', async () => {
    const inner = new FakeLogExporter({ code: ExportResultCode.SUCCESS });
    const counting = new CountingLogExporter(inner);
    await counting.forceFlush();
    await counting.shutdown();
    expect(inner.flushed).toBe(1);
    expect(inner.shutdowns).toBe(1);
  });
});

describe('resolveMetricsExporter', () => {
  it('defaults on when the base endpoint exists', () => {
    expect(resolveMetricsExporter({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })).toBe('otlp');
  });

  it('defaults on when a per-signal metrics endpoint exists', () => {
    expect(resolveMetricsExporter({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://m:4318' })).toBe('otlp');
  });

  it('stays off for a Sentry-only deployment (per-signal traces endpoint, no base)', () => {
    expect(
      resolveMetricsExporter({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://o1.ingest.sentry.io/x/v1/traces' }),
    ).toBe('none');
  });

  it('honors an explicit operator choice over the endpoint heuristic', () => {
    expect(
      resolveMetricsExporter({ OTEL_METRICS_EXPORTER: 'none', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318' }),
    ).toBe('none');
    expect(resolveMetricsExporter({ OTEL_METRICS_EXPORTER: 'otlp' })).toBe('otlp');
  });

  it('treats unsupported exporter names as off', () => {
    expect(
      resolveMetricsExporter({ OTEL_METRICS_EXPORTER: 'prometheus', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x' }),
    ).toBe('none');
  });
});

describe('resolveLogsExporter', () => {
  it('defaults on when the base endpoint exists', () => {
    expect(resolveLogsExporter({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })).toBe('otlp');
  });

  it('defaults on when a per-signal logs endpoint exists (the Sentry opt-in path)', () => {
    expect(resolveLogsExporter({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://o1.ingest.sentry.io/x/v1/logs' })).toBe(
      'otlp',
    );
  });

  it('stays off when only a traces endpoint exists (per-signal traces, no base)', () => {
    expect(resolveLogsExporter({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://o1.ingest.sentry.io/x/v1/traces' })).toBe(
      'none',
    );
  });

  it('honors an explicit operator choice over the endpoint heuristic', () => {
    expect(resolveLogsExporter({ OTEL_LOGS_EXPORTER: 'none', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318' })).toBe(
      'none',
    );
    expect(resolveLogsExporter({ OTEL_LOGS_EXPORTER: 'otlp' })).toBe('otlp');
  });

  it('treats unsupported exporter names as off', () => {
    expect(resolveLogsExporter({ OTEL_LOGS_EXPORTER: 'console', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x' })).toBe(
      'none',
    );
  });
});
