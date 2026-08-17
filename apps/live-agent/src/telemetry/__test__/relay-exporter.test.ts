import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';

import { RelaySpanExporter } from '../relay-exporter';

function buildSpans(attribute?: { key: string; value: string }): ReadableSpan[] {
  const inMemory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(inMemory)] });
  const span = provider.getTracer('test').startSpan('probe');
  if (attribute) span.setAttribute(attribute.key, attribute.value);
  span.end();
  return inMemory.getFinishedSpans();
}

function exportAsync(exporter: RelaySpanExporter, spans: ReadableSpan[]): Promise<ExportResult> {
  return new Promise((resolve) => {
    exporter.export(spans, resolve);
  });
}

describe('RelaySpanExporter', () => {
  it('serializes spans to OTLP bytes and reports SUCCESS when the sender resolves', async () => {
    const sender = vi.fn(async (_bytes: Uint8Array) => undefined);
    const result = await exportAsync(new RelaySpanExporter(sender), buildSpans());
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0]![0].byteLength).toBeGreaterThan(0);
  });

  it('reports FAILED when the sender rejects', async () => {
    const sender = vi.fn(async () => {
      throw new Error('no bridge reachable');
    });
    const result = await exportAsync(new RelaySpanExporter(sender), buildSpans());
    expect(result.code).toBe(ExportResultCode.FAILED);
  });

  it('drops oversize batches without calling the sender', async () => {
    const sender = vi.fn(async (_bytes: Uint8Array) => undefined);
    const spans = buildSpans({ key: 'blob', value: 'x'.repeat(1_572_864) });
    const result = await exportAsync(new RelaySpanExporter(sender), spans);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(sender).not.toHaveBeenCalled();
  });
});
