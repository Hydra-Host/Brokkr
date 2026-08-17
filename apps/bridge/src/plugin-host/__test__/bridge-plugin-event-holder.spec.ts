import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  emitBridgePluginEvent,
  getBridgePluginEventBus,
  resetBridgePluginEventBusForTests,
  setBridgePluginEventBus,
} from '../bridge-plugin-event-holder.js';
import { activePluginRoster } from '../active-plugins-holder.js';

describe('bridge plugin event holder', () => {
  afterEach(() => {
    resetBridgePluginEventBusForTests();
  });

  it('is a no-op while no bus is bound', () => {
    expect(getBridgePluginEventBus()).toBeNull();
    expect(() => emitBridgePluginEvent('bridge.saga.completed', { sagaName: 'provision', planId: 'p1' })).not.toThrow();
  });

  it('forwards emissions to the bound bus', () => {
    const bus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    setBridgePluginEventBus(bus);

    emitBridgePluginEvent('bridge.leadership.changed', { instanceId: 'bridge-1', isLeader: false });

    expect(bus.emit).toHaveBeenCalledWith('bridge.leadership.changed', { instanceId: 'bridge-1', isLeader: false });
  });
});

describe('activePluginRoster', () => {
  const withModule = { id: 'with-module', version: '1.0.0', bridgeModule: () => Promise.resolve({}) };
  const withoutModule = { id: 'without-module', version: '2.0.0' };

  it('includes only enabled plugins that ship a bridge module', () => {
    const roster = activePluginRoster([
      { plugin: withModule, enabled: true },
      { plugin: withoutModule, enabled: true },
      { plugin: { ...withModule, id: 'disabled' }, enabled: false },
    ]);

    expect(roster).toEqual([{ id: 'with-module', version: '1.0.0' }]);
  });
});
