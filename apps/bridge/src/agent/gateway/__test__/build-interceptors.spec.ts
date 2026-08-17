import { describe, expect, it, vi } from 'vitest';

import type { AgentServicerDeps } from '../agent.servicer.types';
import {
  DeviceAuthInterceptor,
  type AuthContextBinder,
  type AuthInterceptorLogger,
  type TokenVerifierPort,
} from '../auth.interceptor';
import { GatewayModule } from '../gateway.module';

function buildAuthInterceptorDeps(): {
  tokenService: TokenVerifierPort;
  binder: AuthContextBinder;
  logger: AuthInterceptorLogger;
} {
  return {
    tokenService: { verify: vi.fn().mockResolvedValue(null) },
    binder: {
      bind: vi.fn().mockImplementation(async <T>(_s, fn: () => Promise<T>) => fn()),
    },
    logger: { warning: vi.fn().mockResolvedValue(undefined) },
  };
}

function buildAgentServicerDeps(): AgentServicerDeps {
  return {} as unknown as AgentServicerDeps;
}

async function resolveInterceptor(): Promise<DeviceAuthInterceptor> {
  const dynamic = GatewayModule.forRoot({
    agentServicerDeps: buildAgentServicerDeps,
    authInterceptorDeps: buildAuthInterceptorDeps,
  });
  const provider = (dynamic.providers ?? []).find(
    (p): p is { provide: typeof DeviceAuthInterceptor; useFactory: () => DeviceAuthInterceptor } =>
      typeof p === 'object' && p !== null && 'provide' in p && p.provide === DeviceAuthInterceptor,
  );
  if (provider === undefined) throw new Error('DeviceAuthInterceptor provider missing');
  return provider.useFactory();
}

describe('gateway module interceptor wiring', () => {
  it('exported providers include DeviceAuthInterceptor', () => {
    const dynamic = GatewayModule.forRoot({
      agentServicerDeps: buildAgentServicerDeps,
      authInterceptorDeps: buildAuthInterceptorDeps,
    });
    const providerTokens = (dynamic.providers ?? []).map((p) =>
      typeof p === 'object' && p !== null && 'provide' in p ? p.provide : p,
    );
    expect(providerTokens).toContain(DeviceAuthInterceptor);
  });

  it('module providers is an Array', () => {
    const dynamic = GatewayModule.forRoot({
      agentServicerDeps: buildAgentServicerDeps,
      authInterceptorDeps: buildAuthInterceptorDeps,
    });
    expect(Array.isArray(dynamic.providers)).toBe(true);
  });

  it('DeviceAuthInterceptor factory yields an instance, not the class', async () => {
    const interceptor = await resolveInterceptor();
    expect(interceptor).toBeInstanceOf(DeviceAuthInterceptor);
  });
});
