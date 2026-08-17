// Heavy half of the package — index.ts requires this lazily after enablement, so a disabled boot never loads the SDK.
import { FastifyOtelInstrumentation } from '@fastify/otel';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { OTLPLogExporter as OtlpHttpJsonLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OtlpProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter as OtlpHttpJsonMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OtlpProtoMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter as OtlpHttpJsonTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OtlpProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import type { LogRecordExporter, LogRecordProcessor, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import type { TelemetryExporterKind } from './enablement';
import {
  markLogs,
  markMetrics,
  recordExportFailure,
  recordExportSuccess,
  recordLogExportFailure,
  recordLogExportSuccess,
  recordMetricExportFailure,
  recordMetricExportSuccess,
} from './status';

export type TelemetryPreset = 'hub' | 'bridge';

export interface StartSdkOptions {
  serviceName: string;
  exporter: TelemetryExporterKind;
  preset: TelemetryPreset;
}

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

export class CountingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        recordExportSuccess(spans.length);
      } else {
        recordExportFailure(result.error?.message ?? 'unknown export error');
      }
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

function resolveOtlpProtocol(
  perSignalKey:
    | 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL'
    | 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL'
    | 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
) {
  return process.env[perSignalKey]?.trim() || process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim() || 'http/protobuf';
}

function unsupportedProtocolError(protocol: string): Error {
  return new Error(
    `OTLP protocol "${protocol}" is not supported (grpc would pull in @grpc/grpc-js); use http/protobuf or http/json`,
  );
}

export function buildTraceExporter(kind: TelemetryExporterKind): SpanExporter {
  if (kind === 'console') {
    return new ConsoleSpanExporter();
  }
  const protocol = resolveOtlpProtocol('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL');
  switch (protocol) {
    case 'http/protobuf':
      return new OtlpProtoTraceExporter();
    case 'http/json':
      return new OtlpHttpJsonTraceExporter();
    default:
      throw unsupportedProtocolError(protocol);
  }
}

/** A Sentry-only deployment (per-signal TRACES endpoint, no base) must not default metrics on — Sentry rejects OTLP metrics and the exporter would fall back to localhost. */
export function resolveMetricsExporter(env: Record<string, string | undefined>): 'otlp' | 'none' {
  return resolveSignalExporter(env, 'OTEL_METRICS_EXPORTER', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT');
}

function resolveSignalExporter(
  env: Record<string, string | undefined>,
  exporterKey: string,
  perSignalEndpointKey: string,
): 'otlp' | 'none' {
  const configured = env[exporterKey]?.trim();
  if (configured === 'otlp') return 'otlp';
  if (configured) return 'none';
  const endpoint = env[perSignalEndpointKey]?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return endpoint ? 'otlp' : 'none';
}

export function resolveLogsExporter(env: Record<string, string | undefined>): 'otlp' | 'none' {
  return resolveSignalExporter(env, 'OTEL_LOGS_EXPORTER', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
}

export class CountingMetricExporter implements PushMetricExporter {
  constructor(private readonly inner: PushMetricExporter) {
    if (inner.selectAggregationTemporality) {
      this.selectAggregationTemporality = inner.selectAggregationTemporality.bind(inner);
    }
    if (inner.selectAggregation) {
      this.selectAggregation = inner.selectAggregation.bind(inner);
    }
  }

  selectAggregationTemporality?: PushMetricExporter['selectAggregationTemporality'];
  selectAggregation?: PushMetricExporter['selectAggregation'];

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.inner.export(metrics, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        recordMetricExportSuccess();
      } else {
        recordMetricExportFailure(result.error?.message ?? 'unknown metric export error');
      }
      resultCallback(result);
    });
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function buildMetricReader(): PeriodicExportingMetricReader {
  const protocol = resolveOtlpProtocol('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL');
  let exporter: PushMetricExporter;
  switch (protocol) {
    case 'http/protobuf':
      exporter = new OtlpProtoMetricExporter();
      break;
    case 'http/json':
      exporter = new OtlpHttpJsonMetricExporter();
      break;
    default:
      throw unsupportedProtocolError(protocol);
  }
  const interval = parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? '', 10);
  return new PeriodicExportingMetricReader({
    exporter: new CountingMetricExporter(exporter),
    exportIntervalMillis: interval > 0 ? interval : 60000,
  });
}

export class CountingLogExporter implements LogRecordExporter {
  constructor(private readonly inner: LogRecordExporter) {}

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(records, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        recordLogExportSuccess();
      } else {
        recordLogExportFailure(result.error?.message ?? 'unknown log export error');
      }
      resultCallback(result);
    });
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function buildLogRecordProcessor(): LogRecordProcessor {
  const protocol = resolveOtlpProtocol('OTEL_EXPORTER_OTLP_LOGS_PROTOCOL');
  let exporter: LogRecordExporter;
  switch (protocol) {
    case 'http/protobuf':
      exporter = new OtlpProtoLogExporter();
      break;
    case 'http/json':
      exporter = new OtlpHttpJsonLogExporter();
      break;
    default:
      throw unsupportedProtocolError(protocol);
  }
  return new BatchLogRecordProcessor({ exporter: new CountingLogExporter(exporter) });
}

function ignoreProbeRequests(probePath: string) {
  return (request: { url?: string }) => {
    const path = (request.url ?? '').split('?')[0];
    return path === probePath;
  };
}

function buildInstrumentations(preset: TelemetryPreset) {
  switch (preset) {
    case 'hub':
      return [
        new HttpInstrumentation({ ignoreIncomingRequestHook: ignoreProbeRequests('/healthcheck') }),
        new ExpressInstrumentation(),
        new NestInstrumentation(),
        new IORedisInstrumentation(),
        new PgInstrumentation(),
        new UndiciInstrumentation(),
        new PrismaInstrumentation(),
        new RuntimeNodeInstrumentation(),
      ];
    case 'bridge':
      return [
        new HttpInstrumentation({ ignoreIncomingRequestHook: ignoreProbeRequests('/api/health') }),
        // instrumentation-fastify is dead upstream; @fastify/otel requires instrumentation-http alongside it for upstream trace propagation.
        new FastifyOtelInstrumentation({ registerOnInitialization: true }),
        new NestInstrumentation(),
        new IORedisInstrumentation(),
        new GrpcInstrumentation(),
        new UndiciInstrumentation(),
        new RuntimeNodeInstrumentation(),
      ];
  }
}

export function startSdk(options: StartSdkOptions): TelemetryHandle {
  const metricsExporter = options.exporter === 'otlp' ? resolveMetricsExporter(process.env) : 'none';
  const logsExporter = options.exporter === 'otlp' ? resolveLogsExporter(process.env) : 'none';
  process.env.OTEL_METRICS_EXPORTER = 'none';
  process.env.OTEL_LOGS_EXPORTER = 'none';
  process.env.OTEL_TRACES_SAMPLER ??= 'parentbased_traceidratio';
  process.env.OTEL_TRACES_SAMPLER_ARG ??= '1.0';

  // Metrics are additive: a metrics-only misconfiguration must degrade to traces-only, never fail startSdk.
  let metricReaders: PeriodicExportingMetricReader[] | undefined;
  if (metricsExporter === 'otlp') {
    try {
      metricReaders = [buildMetricReader()];
    } catch (error) {
      console.error(
        `[telemetry] metrics disabled (metric reader failed to build), continuing traces-only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  markMetrics(metricReaders !== undefined);
  let logRecordProcessors: LogRecordProcessor[] | undefined;
  if (logsExporter === 'otlp') {
    try {
      logRecordProcessors = [buildLogRecordProcessor()];
    } catch (error) {
      console.error(
        `[telemetry] logs disabled (log processor failed to build), continuing without logs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  markLogs(logRecordProcessors !== undefined);
  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    traceExporter: new CountingSpanExporter(buildTraceExporter(options.exporter)),
    ...(metricReaders ? { metricReaders } : {}),
    ...(logRecordProcessors ? { logRecordProcessors } : {}),
    instrumentations: buildInstrumentations(options.preset),
  });
  sdk.start();
  // No process signal listeners: shutdown is caller-owned (hub: Nest shutdown hook; bridge: explicit signal handlers where flush must never delay VRRP VIP release).
  return { shutdown: () => sdk.shutdown() };
}
