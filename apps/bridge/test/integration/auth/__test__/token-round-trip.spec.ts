
import { describe, expect, it } from 'vitest';

import {
  DeviceAuthInterceptor,
  GrpcStatusCode,
  type AuthContextBinder,
  type AuthInterceptorLogger,
  type InterceptableCall,
} from '../../../../src/agent/gateway/auth.interceptor';
import { AgentTokenService, type AgentTokenCache, type AuthSubject } from '../../../../src/auth/agent-token.service';
import { bindSubject, currentSubject } from '../../../../src/auth/auth-context.service';
import { ContextLogger } from '../../../../src/logger/logger.service';

class FakeCache implements AgentTokenCache {
  private readonly store = new Map<string, string>();
  private readonly locks = new Map<string, string>();

  async set(key: string, value: string): Promise<boolean> {
    this.store.set(key, value);
    return true;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async secretSet(key: string, value: string): Promise<boolean> {
    return this.set(key, value);
  }

  async secretGet(key: string): Promise<string | null> {
    return this.get(key);
  }

  async acquireLock(lockKey: string): Promise<string | null> {
    if (this.locks.has(lockKey)) return null;
    const token = `lock-${lockKey}`;
    this.locks.set(lockKey, token);
    return token;
  }

  async releaseLock(lockKey: string, token: string): Promise<boolean> {
    if (this.locks.get(lockKey) === token) {
      this.locks.delete(lockKey);
      return true;
    }
    return false;
  }
}

const realBinder: AuthContextBinder = {
  bind<T>(subject: AuthSubject, fn: () => Promise<T>): Promise<T> {
    return bindSubject(subject, fn);
  },
};

const silentLogger: AuthInterceptorLogger = {
  warning() {
  },
};

class AbortError extends Error {
  constructor(
    public readonly code: GrpcStatusCode,
    message: string,
  ) {
    super(message);
    this.name = 'AbortError';
  }
}

function makeCall(token: string | null, method: string): InterceptableCall {
  const metadata: Array<readonly [string, unknown]> =
    token === null ? [] : [['authorization', `Bearer ${token}`] as const];
  return {
    method,
    metadata,
    abort(code, message): Promise<never> {
      return Promise.reject(new AbortError(code, message));
    },
  };
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function makeService(): AgentTokenService {
  return new AgentTokenService(new FakeCache(), new ContextLogger());
}

describe('integration/auth: token round trip', () => {
  it('mint_device -> verify returns the matching DeviceSubject', async () => {
    const service = makeService();
    const token = await service.mintDevice('1610');
    const subject = await service.verify(token);

    expect(subject).not.toBeNull();
    expect(subject?.kind).toBe('device');
    if (subject?.kind === 'device') {
      expect(subject.deviceId).toBe('1610');
      expect(subject.issuedAt).toBeLessThanOrEqual(nowS());
    }
  });

  it('mint_discovery -> verify returns a DiscoverySubject with a future expires_at', async () => {
    const service = makeService();
    const token = await service.mintDiscovery('aa:bb:cc:dd:ee:ff');
    const subject = await service.verify(token);

    expect(subject).not.toBeNull();
    expect(subject?.kind).toBe('discovery');
    if (subject?.kind === 'discovery') {
      expect(subject.discoveryId).toBe('aa:bb:cc:dd:ee:ff');
      expect(subject.expiresAt).toBeGreaterThan(nowS());
    }
  });

  it('interceptor binds device subject end-to-end', async () => {
    const service = makeService();
    const token = await service.mintDevice('1610');

    const interceptor = new DeviceAuthInterceptor(service, realBinder, silentLogger);
    const call = makeCall(token, '/brokkr.agent.v1.AgentService/OpenSession');

    let captured: AuthSubject | null = null;
    const handlerResult = await interceptor.intercept(call, async () => {
      captured = currentSubject();
      return 'ok' as const;
    });

    expect(handlerResult).toBe('ok');
    expect(captured).not.toBeNull();
    expect((captured as AuthSubject | null)?.kind).toBe('device');
    if (captured !== null && (captured as AuthSubject).kind === 'device') {
      expect((captured as { deviceId: string }).deviceId).toBe('1610');
    }
  });

  it('interceptor rejects an unminted token with UNAUTHENTICATED', async () => {
    const service = makeService();
    const unminted = 'f'.repeat(64);

    const interceptor = new DeviceAuthInterceptor(service, realBinder, silentLogger);
    const call = makeCall(unminted, '/brokkr.agent.v1.AgentService/OpenSession');

    let handlerCalled = false;
    await expect(
      interceptor.intercept(call, async () => {
        handlerCalled = true;
        return 'unreached' as const;
      }),
    ).rejects.toBeInstanceOf(AbortError);

    expect(handlerCalled).toBe(false);

    try {
      await interceptor.intercept(call, async () => 'unreached' as const);
    } catch (error) {
      expect(error).toBeInstanceOf(AbortError);
      expect((error as AbortError).code).toBe(GrpcStatusCode.UNAUTHENTICATED);
    }
  });
});
