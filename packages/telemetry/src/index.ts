// Light-import contract: imported at the top of each app's main.ts before the instrumented modules — a disabled boot must not load the OTel SDK.
import { context, metrics, trace, TraceFlags } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { BullMQOtel } from 'bullmq-otel';
import { resolveEnablement } from './enablement';
import { loadSdkModule } from './load-sdk';
import type { TelemetryHandle, TelemetryPreset } from './sdk';
import { isLogsEnabled, isTelemetryEnabled, markDisabled, markStarted } from './status';

export { resolveOtlpTracesTarget } from './otlp-target';
export type { OtlpTracesTarget } from './otlp-target';
export type { TelemetryPreset } from './sdk';
export { getTelemetryStatus, isTelemetryEnabled } from './status';
export type { TelemetryStatus } from './status';

export interface TelemetryOptions {
  serviceName: string;
  preset: TelemetryPreset;
}

export function getTelemetryMeter(name: string) {
  return metrics.getMeter(name);
}

/** addCallback's param type, derived from the meter API so consumers avoid a direct `@opentelemetry/api` dependency. */
export type ObservableGaugeCallback = Parameters<
  ReturnType<ReturnType<typeof getTelemetryMeter>['createObservableGauge']>['addCallback']
>[0];

/** Every Queue/Worker construction must pass this — a missed site silently severs the hub→bridge trace chain. */
export function getBullMqTelemetry(name: string): BullMQOtel | undefined {
  return isTelemetryEnabled() ? new BullMQOtel({ tracerName: name, meterName: name }) : undefined;
}

export type TelemetryLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error';

const LOG_SEVERITY: Record<TelemetryLogLevel, { number: SeverityNumber; text: string }> = {
  verbose: { number: SeverityNumber.TRACE, text: 'TRACE' },
  debug: { number: SeverityNumber.DEBUG, text: 'DEBUG' },
  info: { number: SeverityNumber.INFO, text: 'INFO' },
  warn: { number: SeverityNumber.WARN, text: 'WARN' },
  error: { number: SeverityNumber.ERROR, text: 'ERROR' },
};

/** `spanContext` must be the record's native trace context, not attributes — the Loki→Tempo derived-field link keys on the LogRecord's trace_id. */
export function emitTelemetryLog(
  loggerName: string,
  level: TelemetryLogLevel,
  message: string,
  attributes?: Record<string, string | number | boolean | undefined>,
  spanContext?: { traceId: string; spanId: string },
): void {
  if (!isLogsEnabled()) return;
  const severity = LOG_SEVERITY[level];
  const attrs: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value !== undefined) attrs[key] = value;
  }
  logs.getLogger(loggerName).emit({
    body: message,
    severityNumber: severity.number,
    severityText: severity.text,
    attributes: attrs,
    ...(spanContext !== undefined
      ? {
          context: trace.setSpanContext(context.active(), {
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          }),
        }
      : {}),
  });
}

let handle: TelemetryHandle | undefined;
let initialized = false;
let coreModule: typeof import('@opentelemetry/core') | undefined;

function loadCoreModule(): typeof import('@opentelemetry/core') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@opentelemetry/core');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// secretspec's local profile resolves unset secrets to "" — the OTLP exporters and sdk-node read OTEL_* env themselves and must never see empty strings.
function dropEmptyOtelEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('OTEL_')) continue;
    if (process.env[key]?.trim() === '') delete process.env[key];
  }
}

/** MUST run before the modules it instruments are required — a side-effect import at the top of main.ts, after dotenv. */
export function initTelemetry(options: TelemetryOptions): void {
  if (initialized) {
    console.warn('[telemetry] initTelemetry called more than once; ignoring');
    return;
  }
  initialized = true;

  dropEmptyOtelEnv();
  const decision = resolveEnablement(process.env);
  if (!decision.enabled || decision.exporter === undefined) {
    markDisabled(decision.reason);
    return;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || options.serviceName;
  try {
    handle = loadSdkModule().startSdk({ serviceName, exporter: decision.exporter, preset: options.preset });
    markStarted(serviceName, decision.exporter, decision.reason);
    console.info(`[telemetry] OpenTelemetry tracing started (service=${serviceName}, exporter=${decision.exporter})`);
  } catch (error) {
    markDisabled(`SDK failed to start: ${errorMessage(error)}`);
    console.error(
      `[telemetry] failed to start OpenTelemetry SDK, continuing without telemetry: ${errorMessage(error)}`,
    );
  }
}

export async function shutdownTelemetry(timeoutMs = 3000): Promise<void> {
  const current = handle;
  handle = undefined;
  if (!current) return;
  // Catch on the flush itself (not the race): a flush failing after the timeout won must not become an unhandled rejection.
  const flush = current.shutdown().catch((error: unknown) => {
    console.warn(`[telemetry] shutdown flush failed: ${errorMessage(error)}`);
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs).unref();
  });
  try {
    await Promise.race([flush, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    markDisabled('shut down');
  }
}

export function enrichActiveSpan(attributes: Record<string, string | number | boolean | undefined>): void {
  const span = trace.getActiveSpan();
  if (!span || !span.isRecording()) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(key, value);
  }
  coreModule ??= loadCoreModule();
  const rpcMetadata = coreModule.getRPCMetadata(context.active());
  if (rpcMetadata?.type === coreModule.RPCType.HTTP && rpcMetadata.span !== span && rpcMetadata.span.isRecording()) {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) rpcMetadata.span.setAttribute(key, value);
    }
  }
}
