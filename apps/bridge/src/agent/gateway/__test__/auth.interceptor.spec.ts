import { describe, expect, it, vi, type Mock } from 'vitest';

import type { AuthSubject, DeviceSubject, DiscoverySubject } from '../../../auth/agent-token.service';
import {
  DeviceAuthInterceptor,
  GrpcStatusCode,
  type AuthContextBinder,
  type AuthInterceptorLogger,
  type InterceptableCall,
  type TokenVerifierPort,
} from '../auth.interceptor';

const METHOD = '/brokkr.agent.v1.AgentService/OpenSession';

function fakeTokenService(mapping: Record<string, AuthSubject>): TokenVerifierPort {
  return {
    verify: vi.fn(async (token: string) => mapping[token] ?? null),
  };
}

function bindingBinder(): { binder: AuthContextBinder; captured: { subject: AuthSubject | null } } {
  const captured: { subject: AuthSubject | null } = { subject: null };
  const binder: AuthContextBinder = {
    bind: async <T>(subject: AuthSubject, fn: () => Promise<T>): Promise<T> => {
      captured.subject = subject;
      return fn();
    },
  };
  return { binder, captured };
}

function silentLogger(): AuthInterceptorLogger {
  return { warning: vi.fn().mockResolvedValue(undefined) };
}

function makeCall(metadata: Array<[string, unknown]>): {
  call: InterceptableCall;
  abort: Mock<(...args: any[]) => any>;
} {
  const abort = vi.fn().mockImplementation((code: GrpcStatusCode, message: string) => {
    return Promise.reject(Object.assign(new Error(message), { code }));
  });
  const call: InterceptableCall = {
    method: METHOD,
    metadata,
    abort: abort as unknown as InterceptableCall['abort'],
  };
  return { call, abort };
}

describe('DeviceAuthInterceptor', () => {
  it('binds device subject and forwards on valid token', async () => {
    const subject: DeviceSubject = { kind: 'device', deviceId: '1610', issuedAt: 1 };
    const { binder, captured } = bindingBinder();
    const interceptor = new DeviceAuthInterceptor(fakeTokenService({ TKN: subject }), binder, silentLogger());
    const { call } = makeCall([['authorization', 'Bearer TKN']]);
    const next = vi.fn().mockResolvedValue('ok');

    const result = await interceptor.intercept(call, next);

    expect(result).toBe('ok');
    expect(captured.subject).toBe(subject);
    expect(next).toHaveBeenCalledOnce();
  });

  it('binds discovery subject and forwards on valid token', async () => {
    const subject: DiscoverySubject = {
      kind: 'discovery',
      discoveryId: 'aa:bb',
      issuedAt: 1,
      expiresAt: 2,
    };
    const { binder, captured } = bindingBinder();
    const interceptor = new DeviceAuthInterceptor(fakeTokenService({ TKN: subject }), binder, silentLogger());
    const { call } = makeCall([['authorization', 'Bearer TKN']]);
    const next = vi.fn().mockResolvedValue('ok');

    const result = await interceptor.intercept(call, next);

    expect(result).toBe('ok');
    expect(captured.subject).toBe(subject);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects UNAUTHENTICATED when authorization header missing', async () => {
    const interceptor = new DeviceAuthInterceptor(fakeTokenService({}), bindingBinder().binder, silentLogger());
    const { call, abort } = makeCall([]);
    const next = vi.fn();

    await expect(interceptor.intercept(call, next)).rejects.toMatchObject({
      code: GrpcStatusCode.UNAUTHENTICATED,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.UNAUTHENTICATED);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects UNAUTHENTICATED on bearer token the service does not recognise', async () => {
    const interceptor = new DeviceAuthInterceptor(fakeTokenService({}), bindingBinder().binder, silentLogger());
    const { call, abort } = makeCall([['authorization', 'Bearer nope']]);
    const next = vi.fn();

    await expect(interceptor.intercept(call, next)).rejects.toMatchObject({
      code: GrpcStatusCode.UNAUTHENTICATED,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.UNAUTHENTICATED);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive BEARER scheme', async () => {
    const subject: DeviceSubject = { kind: 'device', deviceId: '42', issuedAt: 1 };
    const { binder, captured } = bindingBinder();
    const interceptor = new DeviceAuthInterceptor(fakeTokenService({ TKN: subject }), binder, silentLogger());
    const { call } = makeCall([['authorization', 'BEARER TKN']]);
    const next = vi.fn().mockResolvedValue('ok');

    const result = await interceptor.intercept(call, next);

    expect(result).toBe('ok');
    expect(captured.subject).toBe(subject);
  });

  it('rejects UNAUTHENTICATED for non-Bearer auth scheme', async () => {
    const interceptor = new DeviceAuthInterceptor(fakeTokenService({}), bindingBinder().binder, silentLogger());
    const { call, abort } = makeCall([['authorization', 'Basic someCredentials']]);
    const next = vi.fn();

    await expect(interceptor.intercept(call, next)).rejects.toMatchObject({
      code: GrpcStatusCode.UNAUTHENTICATED,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0][0]).toBe(GrpcStatusCode.UNAUTHENTICATED);
    expect(next).not.toHaveBeenCalled();
  });
});
