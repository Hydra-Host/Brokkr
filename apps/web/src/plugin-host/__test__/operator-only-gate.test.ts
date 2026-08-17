import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ isInstanceOperator: false, enabled: ['operator-thing', 'everyone-thing'] }));

vi.mock('@repo/api-client', () => ({
  createApiClient: () => ({
    getEnabledPlugins: async () => ({ status: 200, body: { pluginIds: state.enabled } }),
    getPluginHostContext: async () => ({ status: 200, body: { isInstanceOperator: state.isInstanceOperator } }),
  }),
}));

vi.mock('@hydrahost/plugins-config/frontend', () => ({
  default: [
    {
      plugin: {
        id: 'operator-thing',
        version: '0.0.0',
        operatorOnly: true,
        frontend: async () => ({ rootRoute: { component: () => null, label: 'Operator Thing' } }),
      },
    },
    {
      plugin: {
        id: 'everyone-thing',
        version: '0.0.0',
        frontend: async () => ({ rootRoute: { component: () => null, label: 'Everyone Thing' } }),
      },
    },
  ],
}));

const { loadPluginRegistry } = await import('../registry');

describe('loadPluginRegistry operatorOnly gate', () => {
  beforeEach(() => {
    state.isInstanceOperator = false;
    state.enabled = ['operator-thing', 'everyone-thing'];
  });

  it('omits an operatorOnly plugin route for a non-operator org', async () => {
    const registry = await loadPluginRegistry();
    expect(registry.routes.has('operator-thing')).toBe(false);
    expect(registry.routes.has('everyone-thing')).toBe(true);
  });

  it('mounts an operatorOnly plugin route for an instance operator', async () => {
    state.isInstanceOperator = true;
    const registry = await loadPluginRegistry();
    expect(registry.routes.has('operator-thing')).toBe(true);
    expect(registry.routes.has('everyone-thing')).toBe(true);
  });

  it('omits a plugin the backend does not report as enabled, even for an operator', async () => {
    state.isInstanceOperator = true;
    state.enabled = ['everyone-thing'];
    const registry = await loadPluginRegistry();
    expect(registry.routes.has('operator-thing')).toBe(false);
  });
});
