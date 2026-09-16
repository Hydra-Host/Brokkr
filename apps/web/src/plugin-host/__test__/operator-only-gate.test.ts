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
        frontend: async () => ({
          rootRoute: { component: () => null, label: 'Operator Thing' },
          slots: { 'sidebar-nav': [{ label: 'Operator Thing', to: '/plugins/operator-thing' }] },
        }),
      },
    },
    {
      plugin: {
        id: 'everyone-thing',
        version: '0.0.0',
        frontend: async () => ({
          rootRoute: { component: () => null, label: 'Everyone Thing' },
          slots: { 'public-navbar': [{ label: 'Everyone Thing', to: '/ext/everyone/listings' }] },
          publicRoutes: [
            {
              path: '/ext/everyone/listings',
              layout: 'navbar',
              label: 'Everyone Listings',
              component: () => null,
            },
          ],
        }),
      },
    },
    {
      plugin: {
        id: 'public-only',
        version: '0.0.0',
        frontend: async () => ({
          slots: { 'public-navbar': [{ label: 'Public Only', to: '/ext/everyone/listings' }] },
          publicRoutes: [
            {
              path: '/ext/everyone/listings',
              layout: 'navbar',
              label: 'Public Only',
              component: () => null,
            },
          ],
        }),
      },
    },
  ],
}));

const { loadPluginRegistry } = await import('../registry');
const noCorePath = () => false;

describe('loadPluginRegistry operatorOnly gate', () => {
  beforeEach(() => {
    state.isInstanceOperator = false;
    state.enabled = ['operator-thing', 'everyone-thing'];
  });

  it('omits an operatorOnly plugin route for a non-operator org', async () => {
    const registry = await loadPluginRegistry(noCorePath);
    expect(registry.routes.has('operator-thing')).toBe(false);
    expect(registry.routes.has('everyone-thing')).toBe(false);
    expect(registry.publicRoutes.map((entry) => entry.pluginId)).toEqual(['everyone-thing']);
  });

  it('mounts an operatorOnly plugin route for an instance operator', async () => {
    state.isInstanceOperator = true;
    const registry = await loadPluginRegistry(noCorePath);
    expect(registry.routes.has('operator-thing')).toBe(true);
    expect(registry.routes.has('everyone-thing')).toBe(false);
  });

  it('omits a plugin the backend does not report as enabled, even for an operator', async () => {
    state.isInstanceOperator = true;
    state.enabled = ['everyone-thing'];
    const registry = await loadPluginRegistry(noCorePath);
    expect(registry.routes.has('operator-thing')).toBe(false);
  });

  it('does not register an authenticated root route for a public-only plugin', async () => {
    state.enabled = ['public-only'];
    const registry = await loadPluginRegistry(noCorePath);
    expect(registry.routes.has('public-only')).toBe(false);
    expect(registry.publicRoutes.map((entry) => entry.pluginId)).toEqual(['public-only']);
  });

  it('does not register rootRoute when the plugin also declares publicRoutes', async () => {
    const registry = await loadPluginRegistry(noCorePath);
    expect(registry.routes.has('everyone-thing')).toBe(false);
    expect(registry.publicRoutes.map((entry) => entry.pluginId)).toEqual(['everyone-thing']);
  });

  it('removes colliding plugins while preserving unaffected plugins', async () => {
    state.isInstanceOperator = true;
    state.enabled = ['operator-thing', 'everyone-thing', 'public-only'];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const registry = await loadPluginRegistry(noCorePath);

    expect(registry.routes.has('operator-thing')).toBe(true);
    expect(registry.publicRoutes).toEqual([]);
    expect(registry.slots.get('sidebar-nav')?.map(({ pluginId }) => pluginId)).toEqual(['operator-thing']);
    expect(registry.slots.has('public-navbar')).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Public route collision at "/ext/everyone/listings" between plugins "everyone-thing", "public-only"',
      ),
    );
    consoleError.mockRestore();
  });
});
