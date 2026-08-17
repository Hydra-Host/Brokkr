import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

export type TraceSender = (otlpTraces: Uint8Array) => Promise<void>;

// Must stay under the bridge's ReportTraces RESOURCE_EXHAUSTED cap (1 MiB).
const MAX_BATCH_BYTES = 1024 * 1024;

/** Diagnostics go to stderr, never the agent logger — a logger line would feed the log shipper while the trace pipeline itself is failing. */
export class RelaySpanExporter implements SpanExporter {
  constructor(private readonly sender: TraceSender) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let bytes: Uint8Array | undefined;
    try {
      bytes = ProtobufTraceSerializer.serializeRequest(spans);
    } catch (error) {
      process.stderr.write(`relay-exporter: OTLP serialization failed: ${errorMessage(error)}\n`);
    }
    if (bytes === undefined) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    if (bytes.byteLength > MAX_BATCH_BYTES) {
      process.stderr.write(
        `relay-exporter: dropping oversize trace batch (${bytes.byteLength} bytes > ${MAX_BATCH_BYTES} cap)\n`,
      );
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    this.sender(bytes).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) => {
        process.stderr.write(`relay-exporter: trace batch send failed: ${errorMessage(error)}\n`);
        resultCallback({ code: ExportResultCode.FAILED });
      },
    );
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
