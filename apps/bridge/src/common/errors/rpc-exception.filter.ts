import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import {
  AgentNotConnected,
  AgentNotResponsive,
  AgentVersionMismatch,
  DispatchCancelled,
  DispatchFailed,
  DispatchTimeout,
} from '../../agent/dispatch/grpc.exceptions';

export const RPC_STATUS = {
  CANCELLED: 'CANCELLED',
  UNAVAILABLE: 'UNAVAILABLE',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  FAILED_PRECONDITION: 'FAILED_PRECONDITION',
  INTERNAL: 'INTERNAL',
} as const;

export type RpcStatus = (typeof RPC_STATUS)[keyof typeof RPC_STATUS];

export interface RpcErrorPayload {
  code: RpcStatus;
  message: string;
  details?: Record<string, unknown>;
}

type DispatcherError =
  | AgentNotConnected
  | AgentNotResponsive
  | DispatchTimeout
  | DispatchCancelled
  | DispatchFailed
  | AgentVersionMismatch;

function toRpcPayload(exception: DispatcherError): RpcErrorPayload {
  if (exception instanceof AgentNotConnected) {
    return {
      code: RPC_STATUS.UNAVAILABLE,
      message: exception.message,
      details: { device_id: exception.device_id },
    };
  }
  if (exception instanceof AgentNotResponsive) {
    return {
      code: RPC_STATUS.UNAVAILABLE,
      message: exception.message,
      details: { device_id: exception.device_id, queue_depth: exception.queue_depth },
    };
  }
  if (exception instanceof DispatchTimeout) {
    return { code: RPC_STATUS.DEADLINE_EXCEEDED, message: exception.message };
  }
  if (exception instanceof DispatchCancelled) {
    return { code: RPC_STATUS.CANCELLED, message: exception.message };
  }
  if (exception instanceof DispatchFailed) {
    return {
      code: RPC_STATUS.INTERNAL,
      message: exception.message,
      details: {
        op_code: exception.code,
        op_message: exception.inner_message,
        op_details: exception.details,
      },
    };
  }
  return {
    code: RPC_STATUS.FAILED_PRECONDITION,
    message: exception.message,
    details: {
      device_id: exception.device_id,
      actual: exception.actual,
      expected: exception.expected,
    },
  };
}

@Catch(AgentNotConnected, AgentNotResponsive, DispatchTimeout, DispatchCancelled, DispatchFailed, AgentVersionMismatch)
export class RpcExceptionFilter implements ExceptionFilter<DispatcherError> {
  private readonly logger = new Logger(RpcExceptionFilter.name);

  catch(exception: DispatcherError, host: ArgumentsHost): Observable<never> | void {
    const payload = toRpcPayload(exception);
    this.logger.warn(`${exception.name}: ${payload.code} ${payload.message}`);

    const hostType = host.getType<'rpc' | 'http' | 'ws'>();
    if (hostType === 'rpc') {
      return throwError(() => payload);
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const httpStatus = payload.code === RPC_STATUS.FAILED_PRECONDITION ? 412 : 503;
    response.status(httpStatus).json({
      error: payload.code,
      message: payload.message,
      ...(payload.details ? { details: payload.details } : {}),
    });
  }
}
