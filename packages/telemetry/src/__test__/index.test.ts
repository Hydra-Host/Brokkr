import { afterEach, beforeEach, describe, expect, it } from 'vitest';

async function freshModule() {
  const { vi } = await import('vitest');
  vi.resetModules();
  return import('../index.js');
}

function useCleanOtelEnv() {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith('OTEL_')) continue;
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OTEL_')) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
      delete saved[key];
    }
  });
}

describe('initTelemetry (disabled paths)', () => {
  useCleanOtelEnv();

  it('stays disabled and does not throw with no configuration', async () => {
    const telemetry = await freshModule();
    telemetry.initTelemetry({ serviceName: 'test-service', preset: 'hub' });
    expect(telemetry.isTelemetryEnabled()).toBe(false);
    expect(telemetry.getTelemetryStatus().reason).toContain('no OTLP endpoint');
  });

  it('drops empty-string OTEL_* env (secretspec local-profile sentinel) before deciding', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
    const telemetry = await freshModule();
    telemetry.initTelemetry({ serviceName: 'test-service', preset: 'hub' });
    expect(telemetry.isTelemetryEnabled()).toBe(false);
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('respects the OTEL_SDK_DISABLED kill switch even with an endpoint configured', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const telemetry = await freshModule();
    telemetry.initTelemetry({ serviceName: 'test-service', preset: 'hub' });
    expect(telemetry.isTelemetryEnabled()).toBe(false);
    expect(telemetry.getTelemetryStatus().reason).toBe('OTEL_SDK_DISABLED=true');
  });

  it('enrichActiveSpan is a safe no-op without an SDK', async () => {
    const telemetry = await freshModule();
    expect(() => telemetry.enrichActiveSpan({ 'brokkr.request_id': 'r1', skipped: undefined })).not.toThrow();
  });

  it('shutdownTelemetry is a safe no-op when never started', async () => {
    const telemetry = await freshModule();
    await expect(telemetry.shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe('initTelemetry (enabled paths, mocked sdk)', () => {
  useCleanOtelEnv();

  afterEach(async () => {
    const { vi } = await import('vitest');
    vi.doUnmock('../load-sdk');
  });

  it('starts the sdk with the env service name winning over the option', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const startSdk = vi.fn(() => ({ shutdown: vi.fn(() => Promise.resolve()) }));
    vi.doMock('../load-sdk', () => ({ loadSdkModule: () => ({ startSdk }) }));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    process.env.OTEL_SERVICE_NAME = 'env-name';
    const telemetry = await import('../index.js');
    telemetry.initTelemetry({ serviceName: 'fallback-name', preset: 'hub' });
    expect(startSdk).toHaveBeenCalledWith({ serviceName: 'env-name', exporter: 'otlp', preset: 'hub' });
    expect(telemetry.isTelemetryEnabled()).toBe(true);
    expect(telemetry.getTelemetryStatus().serviceName).toBe('env-name');
  });

  it('is init-once: a second call does not start a second sdk', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const startSdk = vi.fn(() => ({ shutdown: vi.fn(() => Promise.resolve()) }));
    vi.doMock('../load-sdk', () => ({ loadSdkModule: () => ({ startSdk }) }));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const telemetry = await import('../index.js');
    telemetry.initTelemetry({ serviceName: 'one', preset: 'hub' });
    telemetry.initTelemetry({ serviceName: 'two', preset: 'hub' });
    expect(startSdk).toHaveBeenCalledTimes(1);
  });

  it('fails soft when the sdk throws at start', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('../load-sdk', () => ({
      loadSdkModule: () => ({
        startSdk: () => {
          throw new Error('boom');
        },
      }),
    }));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const telemetry = await import('../index.js');
    expect(() => telemetry.initTelemetry({ serviceName: 't', preset: 'hub' })).not.toThrow();
    expect(telemetry.isTelemetryEnabled()).toBe(false);
    expect(telemetry.getTelemetryStatus().reason).toContain('boom');
  });

  it('shutdownTelemetry resolves within the timeout when the flush hangs, and flips status off', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('../load-sdk', () => ({
      loadSdkModule: () => ({
        startSdk: () => ({ shutdown: () => new Promise<void>(() => {}) }),
      }),
    }));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const telemetry = await import('../index.js');
    telemetry.initTelemetry({ serviceName: 't', preset: 'hub' });
    expect(telemetry.isTelemetryEnabled()).toBe(true);
    const started = Date.now();
    await telemetry.shutdownTelemetry(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(telemetry.isTelemetryEnabled()).toBe(false);
    expect(telemetry.getTelemetryStatus().reason).toBe('shut down');
  });
});

describe('getBullMqTelemetry', () => {
  it('returns undefined while telemetry is disabled', async () => {
    const telemetry = await freshModule();
    expect(telemetry.getBullMqTelemetry('test')).toBeUndefined();
  });

  it('returns a BullMQOtel instance once telemetry started', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('../load-sdk', () => ({
      loadSdkModule: () => ({ startSdk: () => ({ shutdown: () => Promise.resolve() }) }),
    }));
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    try {
      const telemetry = await import('../index.js');
      telemetry.initTelemetry({ serviceName: 't', preset: 'hub' });
      const bullmqTelemetry = telemetry.getBullMqTelemetry('test');
      expect(bullmqTelemetry).toBeDefined();
      expect(bullmqTelemetry?.tracer).toBeDefined();
      expect(bullmqTelemetry?.contextManager).toBeDefined();
    } finally {
      vi.doUnmock('../load-sdk');
      if (saved === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
    }
  });
});

describe('enrichActiveSpan (recording spans)', () => {
  it('stamps defined attributes on the active span and the HTTP root span, skipping undefined', async () => {
    const telemetry = await freshModule();
    const { context, trace } = await import('@opentelemetry/api');
    const { AsyncLocalStorageContextManager } = await import('@opentelemetry/context-async-hooks');
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
      '@opentelemetry/sdk-trace-base'
    );
    const { setRPCMetadata, RPCType } = await import('@opentelemetry/core');

    const manager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(manager.enable());
    try {
      const exporter = new InMemorySpanExporter();
      const tracer = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      }).getTracer('test');

      const serverSpan = tracer.startSpan('GET /x');
      const innerSpan = tracer.startSpan('handler');
      let activeContext = trace.setSpan(context.active(), innerSpan);
      activeContext = setRPCMetadata(activeContext, { type: RPCType.HTTP, span: serverSpan, route: '/x' });
      context.with(activeContext, () => {
        telemetry.enrichActiveSpan({ 'brokkr.request_id': 'r1', skipped: undefined });
      });
      innerSpan.end();
      serverSpan.end();

      const finished = exporter.getFinishedSpans();
      const inner = finished.find((s) => s.name === 'handler');
      const server = finished.find((s) => s.name === 'GET /x');
      expect(inner?.attributes['brokkr.request_id']).toBe('r1');
      expect(server?.attributes['brokkr.request_id']).toBe('r1');
      expect(inner?.attributes).not.toHaveProperty('skipped');
      expect(server?.attributes).not.toHaveProperty('skipped');
    } finally {
      context.disable();
    }
  });

  it('leaves other spans untouched when no RPC metadata is present', async () => {
    const telemetry = await freshModule();
    const { context, trace } = await import('@opentelemetry/api');
    const { AsyncLocalStorageContextManager } = await import('@opentelemetry/context-async-hooks');
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
      '@opentelemetry/sdk-trace-base'
    );

    const manager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(manager.enable());
    try {
      const exporter = new InMemorySpanExporter();
      const tracer = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      }).getTracer('test');

      const span = tracer.startSpan('lone');
      context.with(trace.setSpan(context.active(), span), () => {
        telemetry.enrichActiveSpan({ key: 'value' });
      });
      span.end();

      const finished = exporter.getFinishedSpans();
      expect(finished.find((s) => s.name === 'lone')?.attributes['key']).toBe('value');
    } finally {
      context.disable();
    }
  });
});

describe('emitTelemetryLog', () => {
  useCleanOtelEnv();

  it('is a no-op while logs are not enabled', async () => {
    const telemetry = await freshModule();
    const { logs } = await import('@opentelemetry/api-logs');
    const { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } = await import(
      '@opentelemetry/sdk-logs'
    );
    const exporter = new InMemoryLogRecordExporter();
    logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] }));
    try {
      telemetry.emitTelemetryLog('test-logger', 'info', 'dropped before the sdk starts');
      expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    } finally {
      logs.disable();
    }
  });

  it('maps the five levels onto the otel severity scale and skips undefined attributes', async () => {
    const telemetry = await freshModule();
    const status = await import('../status.js');
    const { logs } = await import('@opentelemetry/api-logs');
    const { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } = await import(
      '@opentelemetry/sdk-logs'
    );
    const exporter = new InMemoryLogRecordExporter();
    logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] }));
    status.markLogs(true);
    try {
      telemetry.emitTelemetryLog('test-logger', 'verbose', 'v');
      telemetry.emitTelemetryLog('test-logger', 'debug', 'd');
      telemetry.emitTelemetryLog('test-logger', 'info', 'i', { context: 'Ctx', skipped: undefined });
      telemetry.emitTelemetryLog('test-logger', 'warn', 'w');
      telemetry.emitTelemetryLog('test-logger', 'error', 'e');
      const records = exporter.getFinishedLogRecords();
      expect(records.map((r) => [r.body, r.severityText, r.severityNumber])).toEqual([
        ['v', 'TRACE', 1],
        ['d', 'DEBUG', 5],
        ['i', 'INFO', 9],
        ['w', 'WARN', 13],
        ['e', 'ERROR', 17],
      ]);
      const info = records[2];
      expect(info?.attributes['context']).toBe('Ctx');
      expect(info?.attributes).not.toHaveProperty('skipped');
    } finally {
      status.markLogs(false);
      logs.disable();
    }
  });

  it('stamps an explicit remote span context onto the record when provided', async () => {
    const telemetry = await freshModule();
    const status = await import('../status.js');
    const { logs } = await import('@opentelemetry/api-logs');
    const { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } = await import(
      '@opentelemetry/sdk-logs'
    );
    const exporter = new InMemoryLogRecordExporter();
    logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] }));
    status.markLogs(true);
    try {
      telemetry.emitTelemetryLog(
        'test-logger',
        'info',
        'relayed agent line',
        {},
        { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' },
      );
      const records = exporter.getFinishedLogRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.spanContext?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(records[0]?.spanContext?.spanId).toBe('b7ad6b7169203331');
    } finally {
      status.markLogs(false);
      logs.disable();
    }
  });
});
