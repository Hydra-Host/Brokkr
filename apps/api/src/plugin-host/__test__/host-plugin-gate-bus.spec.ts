import {
  GateRegistrationDeniedError,
  LifecycleGateDeferral,
  LifecycleGateRejection,
  type PluginGateBus,
} from '@hydrahost/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ContextService } from '../../common/context/context.service';
import { GateUnavailableError, HostPluginGateBus } from '../host-plugin-gate-bus';

declare module '@hydrahost/plugin-sdk' {
  interface BrokkrGateMap {
    'test.gate': { value: number };
  }
}

function busAuthorizedFor(...gates: Array<'test.gate'>): {
  bus: HostPluginGateBus;
  pluginId: string;
  scoped: PluginGateBus;
} {
  const bus = new HostPluginGateBus();
  const pluginId = 'test-plugin';
  bus.authorize(pluginId, gates);
  return { bus, pluginId, scoped: bus.scopedFor(pluginId) };
}

describe('HostPluginGateBus', () => {
  it('resolves when no gate is registered', async () => {
    const bus = new HostPluginGateBus();
    await expect(bus.runGate('test.gate', { value: 1 })).resolves.toBeUndefined();
  });

  it('refuses registration for a gate the plugin is not authorized for', () => {
    const bus = new HostPluginGateBus();
    bus.authorize('test-plugin', []);
    expect(() => bus.scopedFor('test-plugin').register('test.gate', vi.fn())).toThrow(GateRegistrationDeniedError);
  });

  it('refuses registration for an unknown (never-authorized) plugin', () => {
    const bus = new HostPluginGateBus();
    expect(() => bus.scopedFor('ghost').register('test.gate', vi.fn())).toThrow(GateRegistrationDeniedError);
  });

  it('binds the registering identity to the scoped bus, not a caller-supplied id', () => {
    const bus = new HostPluginGateBus();
    bus.authorize('victim', ['test.gate']);
    bus.authorize('attacker', []);
    expect(() => bus.scopedFor('attacker').register('test.gate', vi.fn())).toThrow(GateRegistrationDeniedError);
    expect(() => bus.scopedFor('victim').register('test.gate', vi.fn())).not.toThrow();
  });

  it('runs registered handlers in ascending priority order and passes the payload', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    const order: string[] = [];
    const seen: number[] = [];

    scoped.register(
      'test.gate',
      (p) => {
        order.push('mid');
        seen.push(p.value);
      },
      { priority: 5 },
    );
    scoped.register(
      'test.gate',
      (p) => {
        order.push('first');
        seen.push(p.value);
      },
      { priority: 1 },
    );
    scoped.register(
      'test.gate',
      (p) => {
        order.push('last');
        seen.push(p.value);
      },
      { priority: 10 },
    );

    await bus.runGate('test.gate', { value: 42 });

    expect(order).toEqual(['first', 'mid', 'last']);
    expect(seen).toEqual([42, 42, 42]);
  });

  it('propagates a LifecycleGateRejection and short-circuits remaining handlers', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    const later = vi.fn();

    scoped.register(
      'test.gate',
      () => {
        throw new LifecycleGateRejection('card declined');
      },
      { priority: 1 },
    );
    scoped.register('test.gate', later, { priority: 2 });

    await expect(bus.runGate('test.gate', { value: 1 })).rejects.toBeInstanceOf(LifecycleGateRejection);
    expect(later).not.toHaveBeenCalled();
  });

  it('propagates a LifecycleGateDeferral and NEVER trips the breaker (deliberate park, not a crash)', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    const handler = vi.fn(() => {
      throw new LifecycleGateDeferral('pending approval');
    });
    scoped.register('test.gate', handler);

    for (let i = 0; i < 10; i++) {
      await expect(bus.runGate('test.gate', { value: i })).rejects.toBeInstanceOf(LifecycleGateDeferral);
    }
    expect(handler).toHaveBeenCalledTimes(10);
  });

  it('propagates an async handler rejection', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    scoped.register('test.gate', async () => {
      throw new Error('boom');
    });
    await expect(bus.runGate('test.gate', { value: 1 })).rejects.toThrow('boom');
  });

  it('stops running a handler after it is unregistered', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    const handler = vi.fn();
    const unregister = scoped.register('test.gate', handler);

    await bus.runGate('test.gate', { value: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    unregister();
    await bus.runGate('test.gate', { value: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('still runs a sibling handler that the first handler unregisters mid-run', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    const second = vi.fn();
    const unregisterSecond = scoped.register('test.gate', second, { priority: 2 });

    scoped.register(
      'test.gate',
      () => {
        unregisterSecond();
      },
      { priority: 1 },
    );

    await bus.runGate('test.gate', { value: 1 });
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ value: 1 });

    await bus.runGate('test.gate', { value: 2 });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('logs a veto with the plugin identity and gate name', async () => {
    const { bus, scoped, pluginId } = busAuthorizedFor('test.gate');
    const warn = vi.spyOn((bus as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    scoped.register('test.gate', () => {
      throw new LifecycleGateRejection('nope');
    });

    await expect(bus.runGate('test.gate', { value: 1 })).rejects.toBeInstanceOf(LifecycleGateRejection);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`plugin "${pluginId}"`));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('test.gate'));
  });

  it('tags the veto log with the active requestId for attribution', async () => {
    const bus = new HostPluginGateBus({ requestId: 'req-789' } as ContextService);
    bus.authorize('acme.billing', ['test.gate']);
    const warn = vi.spyOn((bus as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    bus.scopedFor('acme.billing').register('test.gate', () => {
      throw new LifecycleGateRejection('card declined');
    });

    await expect(bus.runGate('test.gate', { value: 1 })).rejects.toBeInstanceOf(LifecycleGateRejection);

    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('test.gate');
    expect(message).toContain('vetoed');
    expect(message).toContain('plugin "acme.billing"');
    expect(message).toContain('requestId=req-789');
    expect(message).toContain('card declined');
  });

  it('falls back to requestId=none outside a request scope', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    const warn = vi.spyOn((bus as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    scoped.register('test.gate', () => {
      throw new LifecycleGateRejection('nope');
    });

    await expect(bus.runGate('test.gate', { value: 1 })).rejects.toBeInstanceOf(LifecycleGateRejection);

    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('requestId=none');
  });

  it('bypasses a vetoing handler when override is set', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    const handler = vi.fn(() => {
      throw new LifecycleGateRejection('nope');
    });
    scoped.register('test.gate', handler);

    await expect(bus.runGate('test.gate', { value: 1 }, { override: true })).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('audit-logs an override with operator identity and payload context', async () => {
    const bus = new HostPluginGateBus();
    const warn = vi.spyOn((bus as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');

    await bus.runGate(
      'provision.authorize',
      {
        jobId: 'job-1',
        deviceId: 'dev-2',
        deploymentId: 'dep-3',
        organizationId: 'org-4',
        customerUserId: 'user-5',
        internalProvision: false,
        manualBilling: false,
        fromInvite: false,
        knownAccount: false,
        supplierOrganizationId: 'supplier-org-1',
      },
      { override: true, overrideBy: 'operator-9' },
    );

    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('provision.authorize');
    expect(message).toContain('operator-9');
    expect(message).toContain('jobId=job-1');
    expect(message).toContain('deviceId=dev-2');
    expect(message).toContain('deploymentId=dep-3');
    expect(message).toContain('organizationId=org-4');
  });

  it('NEVER trips the breaker on repeated policy vetoes (fail closed, no auto-approve)', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    const handler = vi.fn(() => {
      throw new LifecycleGateRejection('card declined');
    });
    scoped.register('test.gate', handler);

    for (let i = 0; i < 10; i++) {
      await expect(bus.runGate('test.gate', { value: i })).rejects.toBeInstanceOf(LifecycleGateRejection);
    }
    expect(handler).toHaveBeenCalledTimes(10);
  });

  it('circuit-breaks a handler that CRASHES (unexpected error) repeatedly', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    const handler = vi.fn(() => {
      throw new Error('kaboom');
    });
    scoped.register('test.gate', handler);

    for (let i = 0; i < 5; i++) {
      await expect(bus.runGate('test.gate', { value: i })).rejects.toThrow('kaboom');
    }
    expect(handler).toHaveBeenCalledTimes(5);

    await expect(bus.runGate('test.gate', { value: 99 })).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it('fails a fail-closed gate CLOSED (aborts) when its breaker is open', async () => {
    const { bus, scoped } = busAuthorizedFor('test.gate');
    bus.markFailClosed('test.gate');
    const handler = vi.fn(() => {
      throw new Error('authz backend down');
    });
    scoped.register('test.gate', handler);

    for (let i = 0; i < 5; i++) {
      await expect(bus.runGate('test.gate', { value: i })).rejects.toThrow('authz backend down');
    }
    expect(handler).toHaveBeenCalledTimes(5);

    await expect(bus.runGate('test.gate', { value: 99 })).rejects.toBeInstanceOf(GateUnavailableError);
    expect(handler).toHaveBeenCalledTimes(5);
  });
});
