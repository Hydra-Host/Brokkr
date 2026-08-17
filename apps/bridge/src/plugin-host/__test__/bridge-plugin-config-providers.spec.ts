import { definePlugin, getPluginConfigToken } from '@hydrahost/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildBridgePluginConfigProviders } from '../bridge-plugin-config-providers.js';

const demoPlugin = definePlugin({
  id: 'demo',
  version: '0.0.1',
  configSchema: z.object({ greeting: z.string().default('hi'), retries: z.number().int().min(0).default(1) }),
});

describe('buildBridgePluginConfigProviders', () => {
  it('binds parsed settings with defaults to the plugin config token', () => {
    const providers = buildBridgePluginConfigProviders([{ plugin: demoPlugin, enabled: true, settings: {} }]);

    expect(providers).toHaveLength(1);
    const provider = providers[0];
    expect(typeof provider === 'object' && 'provide' in provider ? provider.provide : null).toBe(
      getPluginConfigToken('demo'),
    );
    expect(typeof provider === 'object' && 'useValue' in provider ? provider.useValue : null).toEqual({
      greeting: 'hi',
      retries: 1,
    });
  });

  it('names the plugin and each issue when validation fails', () => {
    expect(() =>
      buildBridgePluginConfigProviders([{ plugin: demoPlugin, enabled: true, settings: { retries: -1 } }]),
    ).toThrow(/Bridge plugin "demo" config validation failed:[\s\S]*retries/);
  });

  it('skips disabled plugins and plugins without a schema', () => {
    const schemaless = definePlugin({ id: 'schemaless', version: '0.0.1' });

    const providers = buildBridgePluginConfigProviders([
      { plugin: demoPlugin, enabled: false, settings: {} },
      { plugin: schemaless, enabled: true },
    ]);

    expect(providers).toEqual([]);
  });
});
