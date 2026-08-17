import { context as otelContext, trace, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatchContext } from '../dispatch/context';
import { type BufferedEntry, logger, makeLogger, setLogSink } from '../logger';

describe('logger work_id auto-stamping from dispatchContext', () => {
  let captured: BufferedEntry[];
  beforeEach(() => {
    captured = [];
    setLogSink((e) => captured.push(e));
  });
  afterEach(() => {
    setLogSink(null);
  });

  it('inherits work_id and job_id from the active dispatch context', () => {
    dispatchContext.run({ signal: new AbortController().signal, work_id: 'w-123', job_id: 'j-456' }, () => {
      logger.info('inside dispatch');
    });
    const entry = captured.find((e) => e.message === 'inside dispatch');
    expect(entry?.work_id).toBe('w-123');
    expect(entry?.job_id).toBe('j-456');
  });

  it('leaves work_id empty when no dispatch context is active', () => {
    logger.info('outside dispatch');
    const entry = captured.find((e) => e.message === 'outside dispatch');
    expect(entry?.work_id).toBe('');
    expect(entry?.job_id).toBe('');
  });

  it('explicit work_id field on the log call overrides the context value', () => {
    dispatchContext.run({ signal: new AbortController().signal, work_id: 'w-from-ctx' }, () => {
      logger.info('explicit wins', { work_id: 'w-explicit' });
    });
    const entry = captured.find((e) => e.message.startsWith('explicit wins'));
    expect(entry?.work_id).toBe('w-explicit');
  });

  it('child makeLogger() also inherits work_id from dispatch context', () => {
    const childLogger = makeLogger('curtin');
    dispatchContext.run({ signal: new AbortController().signal, work_id: 'w-from-child' }, () => {
      childLogger.info('partitioning sda');
    });
    const entry = captured.find((e) => e.message.startsWith('partitioning sda'));
    expect(entry?.app_class_name).toBe('curtin');
    expect(entry?.work_id).toBe('w-from-child');
  });
});

describe('logger trace-id stamping from the active span', () => {
  let captured: BufferedEntry[];
  beforeEach(() => {
    captured = [];
    setLogSink((e) => captured.push(e));
  });
  afterEach(() => {
    setLogSink(null);
    trace.disable();
    otelContext.disable();
  });

  it('stamps trace_id/span_id when a valid span context is active', () => {
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    otelContext.with(trace.setSpanContext(otelContext.active(), spanContext), () => {
      logger.info('correlated line');
    });
    const entry = captured.find((e) => e.message === 'correlated line');
    expect(entry?.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(entry?.span_id).toBe('b7ad6b7169203331');
  });

  it('omits trace ids with no active span', () => {
    logger.info('uncorrelated line');
    const entry = captured.find((e) => e.message === 'uncorrelated line');
    expect(entry?.trace_id).toBeUndefined();
    expect(entry?.span_id).toBeUndefined();
  });
});
