import { afterEach, describe, expect, it, vi } from 'vitest';

import { withEnv } from './env-guard.js';

withEnv('BROKKR_ZONE_ID', '11111111-2222-3333-4444-555555555555');

import { getBridgeVersion } from '../bridge-status/bridge.config.js';
import { buildDeviceCredentialResolverFactory } from '../composition/device-cred-resolver-factory.js';
import { buildStartupArgs } from '../composition/startup-args.js';
import { NIL_JOB_ID } from '../constants.js';
import { logInfo } from '../logger/logger.service.js';
import {
  OrchestratorGateUnsetError,
  isOrchestratorEnabled,
  orchestratorGateDecision,
  resolveListenHost,
  resolveListenPort,
  startProductionServer,
} from '../main.js';

function buildStartupArgsWithStubBmcCache(env: NodeJS.ProcessEnv) {
  const args = buildStartupArgs({ ...env, BRIDGE_ORCHESTRATOR_ENABLED: 'false' });
  return {
    ...args,
    deviceCredentialResolver: {
      builder: buildDeviceCredentialResolverFactory({
        env,
        cacheFactory: () => ({
          scan: async () => [],
          get: async () => null,
        }),
      }),
    },
  };
}

vi.mock(import('../logger/logger.service'), async (importOriginal) => ({
  ...(await importOriginal()),
  logInfo: vi.fn(async () => undefined),
  logError: vi.fn(async () => undefined),
  logWarning: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveListenPort', () => {
  it('returns DEFAULT_PORT (8080) when PORT is unset', () => {
    expect(resolveListenPort({})).toBe(8080);
  });

  it('throws when PORT is empty string', () => {
    expect(() => resolveListenPort({ PORT: '' })).toThrow(/Invalid PORT/);
  });

  it('parses a valid integer string', () => {
    expect(resolveListenPort({ PORT: '3000' })).toBe(3000);
  });

  it('parses a signed integer string', () => {
    expect(resolveListenPort({ PORT: '+9000' })).toBe(9000);
    expect(resolveListenPort({ PORT: '-1' })).toBe(-1);
  });

  it('parses a value with surrounding whitespace', () => {
    expect(resolveListenPort({ PORT: '  3000  ' })).toBe(3000);
  });

  it('parses 0 as 0 (bind error is the loud downstream signal)', () => {
    expect(resolveListenPort({ PORT: '0' })).toBe(0);
  });

  it('throws on non-numeric PORT', () => {
    expect(() => resolveListenPort({ PORT: 'abc' })).toThrow(/Invalid PORT/);
  });

  it('throws on numeric-with-suffix PORT', () => {
    expect(() => resolveListenPort({ PORT: '42abc' })).toThrow(/Invalid PORT/);
  });

  it('throws on fractional PORT', () => {
    expect(() => resolveListenPort({ PORT: '3.5' })).toThrow(/Invalid PORT/);
  });

  it('throws on hex-style PORT (base 10 only)', () => {
    expect(() => resolveListenPort({ PORT: '0x80' })).toThrow(/Invalid PORT/);
  });

  it('accepts PEP 515 underscore-digit-separators', () => {
    expect(resolveListenPort({ PORT: '42_000' })).toBe(42000);
    expect(resolveListenPort({ PORT: '1_000_000' })).toBe(1000000);
    expect(resolveListenPort({ PORT: '+1_000' })).toBe(1000);
    expect(resolveListenPort({ PORT: '-1_000' })).toBe(-1000);
  });

  it('rejects malformed PEP 515 underscores (leading/trailing/adjacent)', () => {
    expect(() => resolveListenPort({ PORT: '_42' })).toThrow(/Invalid PORT/);
    expect(() => resolveListenPort({ PORT: '42_' })).toThrow(/Invalid PORT/);
    expect(() => resolveListenPort({ PORT: '4__2' })).toThrow(/Invalid PORT/);
  });
});

describe('resolveListenHost', () => {
  it('returns DEFAULT_HOST (loopback) when HOST is unset', () => {
    expect(resolveListenHost({})).toBe('127.0.0.1');
  });

  it('returns DEFAULT_HOST (loopback) when HOST is empty', () => {
    expect(resolveListenHost({ HOST: '' })).toBe('127.0.0.1');
  });

  it('returns the configured HOST when set', () => {
    expect(resolveListenHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

describe('orchestratorGateDecision (tri-state)', () => {
  it('returns "unset" when the env var is undefined', () => {
    expect(orchestratorGateDecision({})).toBe('unset');
  });

  it('returns "unset" for ambiguous values (empty string, "1", garbage)', () => {
    expect(orchestratorGateDecision({ BRIDGE_ORCHESTRATOR_ENABLED: '' })).toBe('unset');
    expect(orchestratorGateDecision({ BRIDGE_ORCHESTRATOR_ENABLED: '1' })).toBe('unset');
    expect(orchestratorGateDecision({ BRIDGE_ORCHESTRATOR_ENABLED: 'yes' })).toBe('unset');
  });

  it('returns "enabled" for "true" (case-insensitive, whitespace-tolerant)', () => {
    expect(orchestratorGateDecision({ BRIDGE_ORCHESTRATOR_ENABLED: 'true' })).toBe('enabled');
    expect(orchestratorGateDecision({ BRIDGE_ORCHESTRATOR_ENABLED: 'TRUE' })).toBe('enabled');
    expect(orchestratorGateDecision({ BRIDGE_ORCHESTRATOR_ENABLED: '  True  ' })).toBe('enabled');
  });

  it('returns "degraded" for "false" (case-insensitive, whitespace-tolerant)', () => {
    expect(orchestratorGateDecision({ BRIDGE_ORCHESTRATOR_ENABLED: 'false' })).toBe('degraded');
    expect(orchestratorGateDecision({ BRIDGE_ORCHESTRATOR_ENABLED: 'FALSE' })).toBe('degraded');
    expect(orchestratorGateDecision({ BRIDGE_ORCHESTRATOR_ENABLED: '  False  ' })).toBe('degraded');
  });
});

describe('isOrchestratorEnabled', () => {
  it('returns false when unset', () => {
    expect(isOrchestratorEnabled({})).toBe(false);
  });

  it('returns false for explicit-false and ambiguous values', () => {
    expect(isOrchestratorEnabled({ BRIDGE_ORCHESTRATOR_ENABLED: 'false' })).toBe(false);
    expect(isOrchestratorEnabled({ BRIDGE_ORCHESTRATOR_ENABLED: '' })).toBe(false);
    expect(isOrchestratorEnabled({ BRIDGE_ORCHESTRATOR_ENABLED: '1' })).toBe(false);
  });

  it('returns true only for "true" (case-insensitive)', () => {
    expect(isOrchestratorEnabled({ BRIDGE_ORCHESTRATOR_ENABLED: 'true' })).toBe(true);
    expect(isOrchestratorEnabled({ BRIDGE_ORCHESTRATOR_ENABLED: 'TRUE' })).toBe(true);
    expect(isOrchestratorEnabled({ BRIDGE_ORCHESTRATOR_ENABLED: 'True' })).toBe(true);
  });
});

describe('startProductionServer', () => {
  it('runs the startup orchestrator + binds the listener when BRIDGE_ORCHESTRATOR_ENABLED=true', async () => {
    let resolveTrigger: (() => void) | null = null;
    const shutdownTrigger = new Promise<void>((res) => {
      resolveTrigger = res;
    });
    const listen = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const fakeApp = { listen, close } as unknown as Parameters<typeof startProductionServer>[1] extends infer X
      ? X extends { createApp?: infer C }
        ? C extends () => Promise<infer R>
          ? R
          : never
        : never
      : never;
    const createApp = vi.fn(async () => fakeApp as never);
    const startupArgsFactory = vi.fn(buildStartupArgsWithStubBmcCache);

    const serverPromise = startProductionServer(shutdownTrigger, {
      env: {
        PORT: '7070',
        HOST: '127.0.0.1',
        BRIDGE_ORCHESTRATOR_ENABLED: 'true',
      },
      createApp,
      runStartup: async () => ({ stopAll: vi.fn(async () => undefined) }) as never,
      startupArgsFactory,
    });
    await vi.waitFor(() => expect(listen).toHaveBeenCalledWith(7070, '127.0.0.1'));
    expect(startupArgsFactory).toHaveBeenCalledTimes(1);
    expect(createApp).toHaveBeenCalledTimes(1);

    resolveTrigger?.();
    await serverPromise;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('throws OrchestratorGateUnsetError when BRIDGE_ORCHESTRATOR_ENABLED is unset', async () => {
    const shutdownTrigger = new Promise<void>(() => undefined);
    await expect(
      startProductionServer(shutdownTrigger, {
        env: {},
        createApp: vi.fn(async () => {
          throw new Error('createApp should not be called');
        }),
      }),
    ).rejects.toBeInstanceOf(OrchestratorGateUnsetError);
  });

  it('throws OrchestratorGateUnsetError for ambiguous BRIDGE_ORCHESTRATOR_ENABLED values', async () => {
    const shutdownTrigger = new Promise<void>(() => undefined);
    await expect(
      startProductionServer(shutdownTrigger, {
        env: { BRIDGE_ORCHESTRATOR_ENABLED: '1' },
        createApp: vi.fn(async () => {
          throw new Error('createApp should not be called');
        }),
      }),
    ).rejects.toBeInstanceOf(OrchestratorGateUnsetError);
  });

  it('proceeds with listener bringup when orchestrator gate is explicitly =false (degraded)', async () => {
    let resolveTrigger: (() => void) | null = null;
    const shutdownTrigger = new Promise<void>((res) => {
      resolveTrigger = res;
    });
    const listen = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const fakeApp = { listen, close } as unknown as Parameters<typeof startProductionServer>[1] extends infer X
      ? X extends { createApp?: infer C }
        ? C extends () => Promise<infer R>
          ? R
          : never
        : never
      : never;
    const createApp = vi.fn(async () => fakeApp as never);

    const serverPromise = startProductionServer(shutdownTrigger, {
      env: {
        PORT: '4242',
        HOST: '127.0.0.1',
        BRIDGE_ORCHESTRATOR_ENABLED: 'false',
      },
      createApp,
    });

    await new Promise((r) => setImmediate(r));
    expect(createApp).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(4242, '127.0.0.1');

    resolveTrigger?.();
    await serverPromise;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not call app.enableShutdownHooks (signal handlers owned by startServer)', async () => {
    let resolveTrigger: (() => void) | null = null;
    const shutdownTrigger = new Promise<void>((res) => {
      resolveTrigger = res;
    });
    const enableShutdownHooks = vi.fn();
    const fakeApp = {
      listen: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      enableShutdownHooks,
    };
    const createApp = vi.fn(async () => fakeApp as never);

    const serverPromise = startProductionServer(shutdownTrigger, {
      env: { PORT: '5050', BRIDGE_ORCHESTRATOR_ENABLED: 'false' },
      createApp,
    });
    await new Promise((r) => setImmediate(r));
    resolveTrigger?.();
    await serverPromise;

    expect(enableShutdownHooks).not.toHaveBeenCalled();
  });

  it('still calls app.close on shutdown even if it throws (logs error and returns)', async () => {
    let resolveTrigger: (() => void) | null = null;
    const shutdownTrigger = new Promise<void>((res) => {
      resolveTrigger = res;
    });
    const close = vi.fn(async () => {
      throw new Error('close exploded');
    });
    const fakeApp = {
      listen: vi.fn(async () => undefined),
      close,
    };
    const createApp = vi.fn(async () => fakeApp as never);

    const serverPromise = startProductionServer(shutdownTrigger, {
      env: { PORT: '6060', BRIDGE_ORCHESTRATOR_ENABLED: 'false' },
      createApp,
    });
    await new Promise((r) => setImmediate(r));
    resolveTrigger?.();

    await expect(serverPromise).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('calls orchestrator.stopAll BEFORE app.close on graceful shutdown (teardown ordering)', async () => {
    let resolveTrigger: (() => void) | null = null;
    const shutdownTrigger = new Promise<void>((res) => {
      resolveTrigger = res;
    });
    const callOrder: string[] = [];
    const stopAll = vi.fn(async () => {
      callOrder.push('orchestrator.stopAll');
    });
    const close = vi.fn(async () => {
      callOrder.push('app.close');
    });
    const detachAll = vi.fn(async () => {
      callOrder.push('vrrp.detachAll');
    });
    const get = vi.fn(() => ({ detachAll }));
    const fakeApp = {
      listen: vi.fn(async () => undefined),
      close,
      get,
    };
    const createApp = vi.fn(async () => fakeApp as never);
    const fakeOrchestrator = { stopAll };
    const startupArgsFactory = vi.fn(buildStartupArgsWithStubBmcCache);

    const serverPromise = startProductionServer(shutdownTrigger, {
      env: {
        PORT: '7171',
        BRIDGE_ORCHESTRATOR_ENABLED: 'true',
      },
      createApp,
      runStartup: async () => fakeOrchestrator as never,
      startupArgsFactory,
    });
    await new Promise((r) => setImmediate(r));
    resolveTrigger?.();
    await serverPromise;

    expect(detachAll).toHaveBeenCalledTimes(1);
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['vrrp.detachAll', 'orchestrator.stopAll', 'app.close']);
  });

  it('still shuts down when the early VRRP detachAll throws (fail-soft)', async () => {
    let resolveTrigger: (() => void) | null = null;
    const shutdownTrigger = new Promise<void>((res) => {
      resolveTrigger = res;
    });
    const callOrder: string[] = [];
    const detachAll = vi.fn(async () => {
      throw new Error('detach exploded');
    });
    const close = vi.fn(async () => {
      callOrder.push('app.close');
    });
    const fakeApp = {
      listen: vi.fn(async () => undefined),
      close,
      get: vi.fn(() => ({ detachAll })),
    };
    const createApp = vi.fn(async () => fakeApp as never);

    const serverPromise = startProductionServer(shutdownTrigger, {
      env: { PORT: '7373', BRIDGE_ORCHESTRATOR_ENABLED: 'false' },
      createApp,
    });
    await new Promise((r) => setImmediate(r));
    resolveTrigger?.();

    await expect(serverPromise).resolves.toBeUndefined();
    expect(detachAll).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['app.close']);
  });

  it('still calls app.close when orchestrator.stopAll throws (Nest destroy hooks must still drain)', async () => {
    let resolveTrigger: (() => void) | null = null;
    const shutdownTrigger = new Promise<void>((res) => {
      resolveTrigger = res;
    });
    const callOrder: string[] = [];
    const stopAll = vi.fn(async () => {
      callOrder.push('orchestrator.stopAll');
      throw new Error('stopAll exploded');
    });
    const close = vi.fn(async () => {
      callOrder.push('app.close');
    });
    const fakeApp = {
      listen: vi.fn(async () => undefined),
      close,
    };
    const createApp = vi.fn(async () => fakeApp as never);
    const fakeOrchestrator = { stopAll };

    const serverPromise = startProductionServer(shutdownTrigger, {
      env: {
        PORT: '7272',
        BRIDGE_ORCHESTRATOR_ENABLED: 'true',
      },
      createApp,
      runStartup: async () => fakeOrchestrator as never,
      startupArgsFactory: buildStartupArgsWithStubBmcCache,
    });
    await new Promise((r) => setImmediate(r));
    resolveTrigger?.();

    await expect(serverPromise).resolves.toBeUndefined();
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['orchestrator.stopAll', 'app.close']);
  });

  it('logs the bridge version once at startup', async () => {
    let resolveTrigger: (() => void) | null = null;
    const shutdownTrigger = new Promise<void>((res) => {
      resolveTrigger = res;
    });
    const fakeApp = {
      listen: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const createApp = vi.fn(async () => fakeApp as never);

    const serverPromise = startProductionServer(shutdownTrigger, {
      env: { PORT: '7474', BRIDGE_ORCHESTRATOR_ENABLED: 'false' },
      createApp,
    });
    await new Promise((r) => setImmediate(r));
    resolveTrigger?.();
    await serverPromise;

    const versionLines = vi.mocked(logInfo).mock.calls.filter(([message]) => message.startsWith('bridge version '));
    expect(versionLines).toEqual([
      [`bridge version ${getBridgeVersion()}`, { jobId: NIL_JOB_ID, appClassName: 'main' }],
    ]);
  });
});
