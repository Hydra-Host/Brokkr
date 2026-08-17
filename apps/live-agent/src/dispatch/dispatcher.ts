import { SpanKind, SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api';
import type {
  CollectionResult,
  OperationError,
  WorkProgress,
  WorkRequest,
  WorkResponse,
} from '@repo/bridge-agent-protocol';
import { getErrorMessage } from '../errors';
import { makeLogger } from '../logger';
import { extractDispatchContext } from '../telemetry/init';
import { dispatchContext } from './context';
import { getHandler } from './registry';
const logger = makeLogger('dispatcher');

export type SendFn = (msg: WorkResponse | WorkProgress | CollectionResult) => void | Promise<void>;

export interface DispatchOptions {
  parentSignal?: AbortSignal;
  onCancellationSettled?: () => void;
  fetchArtifact?: (sha256: string, artifact: 'bundle' | 'unit' | 'config') => AsyncIterable<Uint8Array>;
}

export async function dispatch(req: WorkRequest, send: SendFn, options: DispatchOptions = {}): Promise<void> {
  const { work_id, operation, input, job_id, timeout_ms } = req;
  const startedAt = Date.now();

  const reg = getHandler(operation);
  if (!reg) {
    await Promise.resolve(send(failure(work_id, 'UNKNOWN_OPERATION', `no handler registered for '${operation}'`)));
    return;
  }

  const parsedInput = reg.input.safeParse(input);
  if (!parsedInput.success) {
    await Promise.resolve(
      send(failure(work_id, 'INVALID_INPUT', `input validation failed for '${operation}'`, parsedInput.error.format())),
    );
    return;
  }

  const controller = new AbortController();

  const cleanupController = new AbortController();
  if (options.parentSignal) {
    if (options.parentSignal.aborted) {
      controller.abort();
    } else {
      options.parentSignal.addEventListener('abort', () => controller.abort(), {
        signal: cleanupController.signal,
        once: true,
      });
    }
  }

  let resolveResultDelivered!: () => void;
  let rejectResultDelivered!: (err: unknown) => void;
  const resultDelivered = new Promise<void>((resolve, reject) => {
    resolveResultDelivered = resolve;
    rejectResultDelivered = reject;
  });
  resultDelivered.catch(() => {});

  const sendAndSettleResult = async (msg: WorkResponse): Promise<void> => {
    try {
      await Promise.resolve(send(msg));
      resolveResultDelivered();
    } catch (err) {
      rejectResultDelivered(err);
    }
  };

  const safeSend = (msg: WorkProgress | CollectionResult): void => {
    Promise.resolve()
      .then(() => send(msg))
      .catch((err: unknown) => logger.warn('progress send failed', { work_id, err: getErrorMessage(err) }));
  };

  const emit = async (msg: WorkProgress | CollectionResult): Promise<void> => {
    await Promise.resolve(send(msg));
  };

  const ctx = {
    work_id,
    job_id,
    signal: controller.signal,
    resultDelivered,
    reportProgress: (progress: number, message?: string) => {
      safeSend({ type: 'work.progress' as const, work_id, progress, message });
    },
    emit,
    ...(options.fetchArtifact !== undefined ? { fetchArtifact: options.fetchArtifact } : {}),
  };

  const parentCtx = extractDispatchContext(req.traceparent, req.tracestate);
  const span = trace.getTracer('brokkr-agent').startSpan(
    `agent.execute ${operation}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'brokkr.operation': operation,
        'brokkr.work_id': work_id,
        ...(job_id ? { 'brokkr.job_id': job_id } : {}),
      },
    },
    parentCtx,
  );

  // Must clear in finally; uncleared timeout crashes under --unhandled-rejections=throw.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  await otelContext.with(trace.setSpan(parentCtx, span), async () => {
    try {
      const runPromise = Promise.resolve(
        dispatchContext.run({ signal: controller.signal, job_id, work_id, operation }, () =>
          reg.handler(parsedInput.data, ctx),
        ),
      );
      // Late-rejection sink: if timeout wins the race, the handler's post-abort throw has no awaiter.
      runPromise.catch(() => {});
      const racers: Array<Promise<unknown>> = [runPromise];
      if (timeout_ms) {
        racers.push(
          new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
              controller.abort();
              reject(new TimeoutError(operation, timeout_ms));
            }, timeout_ms);
            timeoutHandle.unref();
          }),
        );
      }
      const result = racers.length > 1 ? await Promise.race(racers) : await runPromise;

      const parsedOutput = reg.output.safeParse(result);
      if (!parsedOutput.success) {
        logger.error('handler returned invalid output', {
          operation,
          work_id,
          issues: parsedOutput.error.format(),
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'handler output failed schema validation' });
        span.setAttribute('brokkr.error_code', 'INTERNAL_ERROR');
        await sendAndSettleResult(
          failure(
            work_id,
            'INTERNAL_ERROR',
            `handler for '${operation}' returned output that failed schema validation`,
          ),
        );
        return;
      }

      logger.info('work complete', {
        operation,
        work_id,
        status: 'success',
        duration_ms: Date.now() - startedAt,
      });
      await sendAndSettleResult({
        type: 'work.response' as const,
        work_id,
        status: 'success' as const,
        output: parsedOutput.data,
      });
    } catch (error) {
      controller.abort();
      const cancelled = options.parentSignal?.aborted === true;
      if (cancelled) options.onCancellationSettled?.();
      const { code, message, details } = cancelled
        ? { code: 'CANCELLED', message: 'operation cancelled', details: undefined }
        : toOperationError(error);
      logger.error('operation failed', {
        operation,
        work_id,
        code,
        message,
        duration_ms: Date.now() - startedAt,
      });
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.setAttribute('brokkr.error_code', code);
      await sendAndSettleResult(failure(work_id, code, message, details));
    } finally {
      span.end();
      if (timeoutHandle) clearTimeout(timeoutHandle);
      cleanupController.abort();
    }
  });
}

function failure(work_id: string, code: string, message: string, details?: unknown): WorkResponse {
  const error: OperationError = { code, message };
  if (details !== undefined) error.details = details;
  return { type: 'work.response', work_id, status: 'failure', error };
}

class TimeoutError extends Error {
  constructor(
    public operation: string,
    public timeout_ms: number,
  ) {
    super(`operation '${operation}' timed out after ${timeout_ms}ms`);
    this.name = 'TimeoutError';
  }
}

// Prevent raw subprocess stderr from flooding bridge logs or leaking paths.
const MAX_MESSAGE_LENGTH = 2048;

function truncateMessage(message: string): string {
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_MESSAGE_LENGTH)}… [truncated, ${message.length} bytes]`;
}

function toOperationError(err: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (err instanceof TimeoutError) {
    return { code: 'TIMEOUT', message: truncateMessage(err.message) };
  }
  if (err instanceof Error) {
    const details = extractErrorDetails(err);
    const base: { code: string; message: string; details?: unknown } = {
      code: 'OPERATION_FAILED',
      message: truncateMessage(err.message),
    };
    if (details !== undefined) base.details = details;
    return base;
  }
  return { code: 'OPERATION_FAILED', message: truncateMessage(String(err)) };
}

function extractErrorDetails(err: Error): unknown {
  const details: Record<string, unknown> = {};
  if ('cause' in err && err.cause !== undefined) {
    details['cause'] = err.cause instanceof Error ? truncateMessage(err.cause.message) : err.cause;
  }
  if ('stderr' in err && typeof err.stderr === 'string' && err.stderr.length > 0) {
    details['stderr'] = truncateMessage(err.stderr);
  }
  if ('exit_code' in err && typeof err.exit_code === 'number') {
    details['exit_code'] = err.exit_code;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}
