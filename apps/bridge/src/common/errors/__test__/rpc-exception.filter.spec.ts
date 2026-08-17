import type { ArgumentsHost } from '@nestjs/common';
import { firstValueFrom, Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentNotConnected,
  AgentVersionMismatch,
  DispatchCancelled,
  DispatchFailed,
  DispatchTimeout,
} from '../../../agent/dispatch/grpc.exceptions';
import { RPC_STATUS, RpcExceptionFilter } from '../rpc-exception.filter';

function asObservable(result: Observable<never> | void): Observable<never> {
  if (!(result instanceof Observable)) throw new Error('expected an Observable error from the rpc branch');
  return result;
}

function rpcHost(): ArgumentsHost {
  return {
    getType: () => 'rpc',
    switchToHttp: () => {
      throw new Error('not http');
    },
  } as unknown as ArgumentsHost;
}

function httpHost(): { host: ArgumentsHost; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('RpcExceptionFilter', () => {
  it('maps AgentNotConnected to an UNAVAILABLE rpc payload over an Observable error', async () => {
    const filter = new RpcExceptionFilter();
    const result = filter.catch(new AgentNotConnected('dev-1'), rpcHost());

    await expect(firstValueFrom(asObservable(result))).rejects.toMatchObject({
      code: RPC_STATUS.UNAVAILABLE,
      message: 'no local gRPC session for device dev-1',
      details: { device_id: 'dev-1' },
    });
  });

  it('maps DispatchTimeout to DEADLINE_EXCEEDED', async () => {
    const filter = new RpcExceptionFilter();
    const result = filter.catch(new DispatchTimeout('took too long'), rpcHost());
    await expect(firstValueFrom(asObservable(result))).rejects.toMatchObject({
      code: RPC_STATUS.DEADLINE_EXCEEDED,
      message: 'took too long',
    });
  });

  it('maps DispatchCancelled to CANCELLED', async () => {
    const filter = new RpcExceptionFilter();
    const result = filter.catch(new DispatchCancelled(), rpcHost());
    await expect(firstValueFrom(asObservable(result))).rejects.toMatchObject({ code: RPC_STATUS.CANCELLED });
  });

  it('maps DispatchFailed to an INTERNAL payload carrying the inner op fields', async () => {
    const filter = new RpcExceptionFilter();
    const result = filter.catch(new DispatchFailed('E_OP', 'op blew up', 'stack'), rpcHost());
    await expect(firstValueFrom(asObservable(result))).rejects.toMatchObject({
      code: RPC_STATUS.INTERNAL,
      details: { op_code: 'E_OP', op_message: 'op blew up', op_details: 'stack' },
    });
  });

  it('maps AgentVersionMismatch to FAILED_PRECONDITION', async () => {
    const filter = new RpcExceptionFilter();
    const result = filter.catch(new AgentVersionMismatch('dev-2', '1.0.0', '2.0.0'), rpcHost());
    await expect(firstValueFrom(asObservable(result))).rejects.toMatchObject({
      code: RPC_STATUS.FAILED_PRECONDITION,
      details: { device_id: 'dev-2', actual: '1.0.0', expected: '2.0.0' },
    });
  });

  it('renders an HTTP response (412 for FAILED_PRECONDITION) when the host is http', () => {
    const filter = new RpcExceptionFilter();
    const { host, status, json } = httpHost();

    const result = filter.catch(new AgentVersionMismatch('dev-3', '1.0.0', '2.0.0'), host);

    expect(result).toBeUndefined();
    expect(status).toHaveBeenCalledWith(412);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: RPC_STATUS.FAILED_PRECONDITION,
        details: expect.objectContaining({ device_id: 'dev-3' }),
      }),
    );
  });

  it('renders a 503 HTTP response for UNAVAILABLE-class errors', () => {
    const filter = new RpcExceptionFilter();
    const { host, status } = httpHost();

    filter.catch(new AgentNotConnected('dev-4'), host);

    expect(status).toHaveBeenCalledWith(503);
  });
});
