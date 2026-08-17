import { describe, expect, it, vi } from 'vitest';

import { HostBridgePluginEventBus } from '../bridge-plugin-event-bus.js';

function makeBus() {
  const logger = { warn: vi.fn() };
  return { bus: new HostBridgePluginEventBus(logger), logger };
}

describe('HostBridgePluginEventBus', () => {
  it('delivers an emitted payload to every subscriber', () => {
    const { bus } = makeBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.on('bridge.saga.completed', first);
    bus.on('bridge.saga.completed', second);

    bus.emit('bridge.saga.completed', { sagaName: 'provision', planId: 'plan-1' });

    expect(first).toHaveBeenCalledWith({ sagaName: 'provision', planId: 'plan-1' });
    expect(second).toHaveBeenCalledWith({ sagaName: 'provision', planId: 'plan-1' });
  });

  it('isolates a throwing handler and attributes the failure to its plugin', () => {
    const { bus, logger } = makeBus();
    const surviving = vi.fn();
    bus.on(
      'bridge.leadership.changed',
      () => {
        throw new Error('boom');
      },
      { pluginId: 'bad-plugin' },
    );
    bus.on('bridge.leadership.changed', surviving);

    bus.emit('bridge.leadership.changed', { instanceId: 'bridge-1', isLeader: true });

    expect(surviving).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bad-plugin'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bridge.leadership.changed'));
  });

  it('warns on a rejected async handler without affecting others', async () => {
    const { bus, logger } = makeBus();
    bus.on('bridge.saga.failed', async () => Promise.reject(new Error('async boom')), { pluginId: 'async-plugin' });

    bus.emit('bridge.saga.failed', { sagaName: 'provision', planId: 'plan-2', error: null });
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('async-plugin'));
  });

  it('stops delivering after unsubscribe and off', () => {
    const { bus } = makeBus();
    const viaUnsubscribe = vi.fn();
    const viaOff = vi.fn();
    const unsubscribe = bus.on('bridge.saga.completed', viaUnsubscribe);
    bus.on('bridge.saga.completed', viaOff);

    unsubscribe();
    bus.off('bridge.saga.completed', viaOff);
    bus.emit('bridge.saga.completed', { sagaName: 'provision', planId: 'plan-3' });

    expect(viaUnsubscribe).not.toHaveBeenCalled();
    expect(viaOff).not.toHaveBeenCalled();
  });
});
