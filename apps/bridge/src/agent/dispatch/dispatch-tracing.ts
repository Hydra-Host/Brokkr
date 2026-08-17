import { SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';

export interface TraceContextCarrier {
  traceparent?: string;
  tracestate?: string;
}

export interface DispatchSpanHooks {
  setWorkId(workId: string): void;
  traceContext(): TraceContextCarrier;
}

export async function withDispatchSpan<T>(
  attrs: { deviceId: string; operation: string; jobId: string | null },
  fn: (hooks: DispatchSpanHooks) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('brokkr-bridge');
  return tracer.startActiveSpan(
    `agent.dispatch ${attrs.operation}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'brokkr.device_id': attrs.deviceId,
        'brokkr.operation': attrs.operation,
        ...(attrs.jobId !== null && attrs.jobId !== '' ? { 'brokkr.job_id': attrs.jobId } : {}),
      },
    },
    async (span) => {
      try {
        return await fn({
          setWorkId: (workId) => {
            span.setAttribute('brokkr.work_id', workId);
          },
          traceContext: () => {
            const carrier: TraceContextCarrier = {};
            propagation.inject(context.active(), carrier);
            return carrier;
          },
        });
      } catch (error) {
        if (error instanceof Error) span.recordException(error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
