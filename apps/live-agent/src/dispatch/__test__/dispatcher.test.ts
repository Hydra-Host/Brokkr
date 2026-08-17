import { create } from '@bufbuild/protobuf';
import { SpanKind, SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { CollectionResult, WorkProgress, WorkRequest, WorkResponse } from '@repo/bridge-agent-protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonToBytes, protoToZodWorkRequest } from '../../connection/protocol-adapter';
import { WorkRequestSchema as ProtoWorkRequestSchema } from '../../gen/brokkr/agent/v1/work_pb';
import { setLogSink, type BufferedEntry } from '../../logger';
import { dispatch } from '../dispatcher';
import type { HandlerContext } from '../registry';
import { registerPluginOperation } from '../registry';

type AnyOutMsg = WorkResponse | WorkProgress | CollectionResult;

function makeReq(operation: string, work_id = 'w-test'): WorkRequest {
  return { type: 'work.request', work_id, operation, input: {} };
}

describe('dispatcher resultDelivered settlement', () => {
  it('resolves resultDelivered when send succeeds', async () => {
    let capturedCtx: HandlerContext | null = null;
    const op = `test.success-${Math.random()}`;
    registerPluginOperation(op, z.any(), z.any(), (_input, ctx) => {
      capturedCtx = ctx;
      return { ok: true };
    });

    const send = async (_msg: AnyOutMsg): Promise<void> => undefined;
    await dispatch(makeReq(op), send);

    expect(capturedCtx).not.toBeNull();
    await expect(capturedCtx!.resultDelivered).resolves.toBeUndefined();
  });

  it('rejects resultDelivered when the final WorkResponse send rejects', async () => {
    let capturedCtx: HandlerContext | null = null;
    const op = `test.delivery-fail-${Math.random()}`;
    registerPluginOperation(op, z.any(), z.any(), (_input, ctx) => {
      capturedCtx = ctx;
      return { ok: true };
    });

    const send = async (msg: AnyOutMsg): Promise<void> => {
      if (msg.type === 'work.response') {
        throw new Error('bridge unreachable');
      }
    };
    await dispatch(makeReq(op), send);

    expect(capturedCtx).not.toBeNull();
    await expect(capturedCtx!.resultDelivered).rejects.toThrow('bridge unreachable');
  });

  it('rejects resultDelivered when the handler throws and the failure-message send also rejects', async () => {
    let capturedCtx: HandlerContext | null = null;
    const op = `test.handler-throw-${Math.random()}`;
    registerPluginOperation(op, z.any(), z.any(), (_input, ctx) => {
      capturedCtx = ctx;
      throw new Error('handler boom');
    });

    const send = async (_msg: AnyOutMsg): Promise<void> => {
      throw new Error('bridge unreachable');
    };
    await dispatch(makeReq(op), send);

    expect(capturedCtx).not.toBeNull();
    await expect(capturedCtx!.resultDelivered).rejects.toThrow('bridge unreachable');
  });

  it('replies INVALID_INPUT on the proto/gRPC path when input fails the per-operation schema', async () => {
    const op = `test.schema-reject-${Math.random()}`;
    let handlerCalled = false;
    registerPluginOperation(op, z.object({ disks: z.array(z.string()).nonempty() }), z.any(), () => {
      handlerCalled = true;
      return { ok: true };
    });

    const proto = create(ProtoWorkRequestSchema, {
      workId: 'w-schema-reject',
      operation: op,
      input: jsonToBytes({ disks: 'sda' }),
    });
    const parsed = protoToZodWorkRequest(proto);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');

    const sent: WorkResponse[] = [];
    const send = async (msg: AnyOutMsg): Promise<void> => {
      if (msg.type === 'work.response') sent.push(msg);
    };
    await dispatch(parsed.request, send);

    expect(handlerCalled).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toBe('failure');
    expect(sent[0]!.error?.code).toBe('INVALID_INPUT');
    expect(sent[0]!.work_id).toBe('w-schema-reject');
  });

  it('does not surface an unhandled rejection when nothing awaits resultDelivered', async () => {
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const op = `test.no-awaiter-${Math.random()}`;
      registerPluginOperation(op, z.any(), z.any(), () => ({ ok: true }));
      const send = async (msg: AnyOutMsg): Promise<void> => {
        if (msg.type === 'work.response') throw new Error('bridge unreachable');
      };
      await dispatch(makeReq(op), send);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('reports CANCELLED when the parent signal aborts the handler', async () => {
    const op = `test.cancelled-${Math.random()}`;
    registerPluginOperation(
      op,
      z.any(),
      z.any(),
      (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const sent: WorkResponse[] = [];
    const events: string[] = [];
    const parent = new AbortController();
    const execution = dispatch(
      makeReq(op),
      (msg) => {
        if (msg.type === 'work.response') {
          events.push('sent');
          sent.push(msg);
        }
      },
      {
        parentSignal: parent.signal,
        onCancellationSettled: () => events.push('settled'),
      },
    );

    parent.abort();
    await execution;

    expect(sent).toHaveLength(1);
    expect(sent[0]!.error?.code).toBe('CANCELLED');
    expect(events).toEqual(['settled', 'sent']);
  });
});

describe('dispatcher tracing', () => {
  const exporter = new InMemorySpanExporter();
  const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

  beforeAll(() => {
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterAll(() => {
    trace.disable();
    otelContext.disable();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it('wraps handler execution in a SERVER span parented from the WorkRequest traceparent', async () => {
    const op = `test.traced-${Math.random()}`;
    registerPluginOperation(op, z.any(), z.any(), () => ({ ok: true }));

    await dispatch({ ...makeReq(op, 'w-traced'), traceparent: TRACEPARENT }, async () => undefined);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe(`agent.execute ${op}`);
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
    expect(span.attributes['brokkr.operation']).toBe(op);
    expect(span.attributes['brokkr.work_id']).toBe('w-traced');
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('starts a fresh trace when no traceparent arrives', async () => {
    const op = `test.traced-root-${Math.random()}`;
    registerPluginOperation(op, z.any(), z.any(), () => ({ ok: true }));

    await dispatch(makeReq(op, 'w-root'), async () => undefined);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.parentSpanContext).toBeUndefined();
  });

  it('records ERROR status and the operation error code when the handler throws', async () => {
    const op = `test.traced-fail-${Math.random()}`;
    registerPluginOperation(op, z.any(), z.any(), () => {
      throw new Error('handler boom');
    });

    await dispatch({ ...makeReq(op, 'w-fail'), traceparent: TRACEPARENT }, async () => undefined);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['brokkr.error_code']).toBe('OPERATION_FAILED');
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('records TIMEOUT when the handler outlives its deadline', async () => {
    const op = `test.traced-timeout-${Math.random()}`;
    registerPluginOperation(op, z.any(), z.any(), () => new Promise(() => undefined));

    await dispatch({ ...makeReq(op, 'w-timeout'), timeout_ms: 10 }, async () => undefined);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.attributes['brokkr.error_code']).toBe('TIMEOUT');
  });

  it('stamps trace ids on the dispatcher outcome logs, not just handler-side logs', async () => {
    const op = `test.traced-log-${Math.random()}`;
    registerPluginOperation(op, z.any(), z.any(), () => ({ ok: true }));
    const captured: BufferedEntry[] = [];
    setLogSink((e) => captured.push(e));
    try {
      await dispatch({ ...makeReq(op, 'w-log'), traceparent: TRACEPARENT }, async () => undefined);
    } finally {
      setLogSink(null);
    }

    const outcome = captured.find((e) => e.message.startsWith('work complete'));
    const span = exporter.getFinishedSpans()[0]!;
    expect(outcome?.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(outcome?.span_id).toBe(span.spanContext().spanId);
  });
});
