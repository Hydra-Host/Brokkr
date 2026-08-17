import { describe, expect, it, vi, type Mock } from 'vitest';

import { AgentServicer } from '../agent.servicer';
import {
  DeviceAuthInterceptor,
  GrpcStatusCode,
  type AuthContextBinder,
  type AuthInterceptorLogger,
  type InterceptableCall,
  type TokenVerifierPort,
} from '../auth.interceptor';

const EXPECTED_METHODS: ReadonlySet<string> = new Set([
  'OpenSession',
  'ReportResult',
  'ReportProgress',
  'ReportPartialResult',
  'ReportLogs',
  'ReportTraces',
  'FetchBundle',
  'RenewToken',
  'PhoneHome',
]);

const AGENT_SERVICE = 'brokkr.agent.v1.AgentService';

function methodPath(rpc: string): string {
  return `/${AGENT_SERVICE}/${rpc}`;
}

function buildInterceptor(): {
  interceptor: DeviceAuthInterceptor;
  tokenService: TokenVerifierPort;
  binder: AuthContextBinder;
  logger: AuthInterceptorLogger;
} {
  const tokenService: TokenVerifierPort = {
    verify: vi.fn().mockResolvedValue(null),
  };
  const binder: AuthContextBinder = {
    bind: vi.fn().mockImplementation(async <T>(_s, fn: () => Promise<T>) => fn()),
  };
  const logger: AuthInterceptorLogger = {
    warning: vi.fn().mockResolvedValue(undefined),
  };
  const interceptor = new DeviceAuthInterceptor(tokenService, binder, logger);
  return { interceptor, tokenService, binder, logger };
}

function buildCall(method: string): {
  call: InterceptableCall;
  abort: Mock<(...args: any[]) => any>;
} {
  const abort = vi.fn().mockImplementation((code: GrpcStatusCode, message: string) => {
    return Promise.reject(Object.assign(new Error(message), { code }));
  });
  const call: InterceptableCall = {
    method,
    metadata: [],
    abort: abort as unknown as InterceptableCall['abort'],
  };
  return { call, abort };
}

describe('grpc interceptor coverage', () => {
  it('expected method list matches AgentServicer prototype', () => {
    const proto = AgentServicer.prototype;
    const servicerMethods = new Set(
      Object.getOwnPropertyNames(proto).filter((name) => {
        if (name === 'constructor') return false;
        if (name.startsWith('_')) return false;
        if (name === 'resolveBridgeId') return false;
        const value = (proto as unknown as Record<string, unknown>)[name];
        return typeof value === 'function';
      }),
    );
    expect(servicerMethods).toEqual(EXPECTED_METHODS);
  });

  it.each([...EXPECTED_METHODS].sort())('%s rejects without bearer token', async (methodName) => {
    const { interceptor, binder, logger } = buildInterceptor();
    const { call, abort } = buildCall(methodPath(methodName));
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(interceptor.intercept(call, next)).rejects.toMatchObject({
      message: 'invalid or missing agent token',
      code: GrpcStatusCode.UNAUTHENTICATED,
    });

    expect(abort).toHaveBeenCalledWith(GrpcStatusCode.UNAUTHENTICATED, 'invalid or missing agent token');
    expect(next).not.toHaveBeenCalled();
    expect(binder.bind).not.toHaveBeenCalled();
    expect(logger.warning).toHaveBeenCalledWith(`auth rejected method=${methodPath(methodName)} reason=missing`);
  });
});
