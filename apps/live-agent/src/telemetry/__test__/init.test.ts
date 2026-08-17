import { context, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractDispatchContext, initAgentTelemetry, shutdownAgentTelemetry } from '../init';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

afterEach(async () => {
  await shutdownAgentTelemetry();
  trace.disable();
  context.disable();
});

describe('extractDispatchContext', () => {
  it('returns a context carrying the remote span context', () => {
    const ctx = extractDispatchContext(TRACEPARENT, 'vendor=value');
    const sc = trace.getSpanContext(ctx);
    expect(sc?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(sc?.spanId).toBe('b7ad6b7169203331');
    expect(sc?.isRemote).toBe(true);
    expect(sc?.traceState?.get('vendor')).toBe('value');
  });

  it('returns an empty context without a traceparent or with a malformed one', () => {
    expect(trace.getSpanContext(extractDispatchContext(undefined))).toBeUndefined();
    expect(trace.getSpanContext(extractDispatchContext('garbage'))).toBeUndefined();
  });
});

describe('initAgentTelemetry', () => {
  it('does not install a tracer provider when disabled', () => {
    initAgentTelemetry({ enabled: false, deviceId: 'dev-1', zoneId: 'z-1', sender: async () => undefined });
    const span = trace.getTracer('brokkr-agent').startSpan('probe');
    expect(span.isRecording()).toBe(false);
    span.end();
  });

  it('ships ended spans to the sender as OTLP bytes on shutdown flush', async () => {
    const sender = vi.fn(async (_bytes: Uint8Array) => undefined);
    initAgentTelemetry({ enabled: true, deviceId: 'dev-1', zoneId: 'z-1', sender });

    const span = trace.getTracer('brokkr-agent').startSpan('unit-probe');
    span.end();
    await shutdownAgentTelemetry();

    expect(sender).toHaveBeenCalledOnce();
    const bytes = sender.mock.calls[0]![0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('is fail-soft: a throwing sender never propagates', async () => {
    const sender = vi.fn(async () => {
      throw new Error('all bridges down');
    });
    initAgentTelemetry({ enabled: true, deviceId: 'dev-1', zoneId: 'z-1', sender });

    trace.getTracer('brokkr-agent').startSpan('doomed').end();
    await expect(shutdownAgentTelemetry()).resolves.toBeUndefined();
  });
});
