import { buildPluginConfigProviders } from '@hydrahost/plugin-runtime';
import { describe, expect, it } from 'vitest';

import { nomadManifest } from '../../plugin';

describe('nomad plugin config provider wiring', () => {
  it('does not validate settings when enabled is false', () => {
    const providers = buildPluginConfigProviders([
      {
        plugin: nomadManifest,
        enabled: false,
        settings: { address: '', token: '' },
      },
    ]);

    expect(providers).toEqual([]);
  });

  it('names the failing fields whether the ZodError is wrapped or raw', () => {
    let caught: unknown;
    try {
      buildPluginConfigProviders([
        {
          plugin: nomadManifest,
          enabled: true,
          settings: { address: '', token: '' },
        },
      ]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toMatch(/address/i);
    expect(message).toMatch(/token|at least 1 character/i);
  });

  it('binds parsed settings when enabled with a valid config', () => {
    const providers = buildPluginConfigProviders([
      {
        plugin: nomadManifest,
        enabled: true,
        settings: {
          address: 'http://127.0.0.1:4646',
          token: 'test-acl-token',
        },
      },
    ]);

    expect(providers).toHaveLength(1);
    const provider = providers[0] as { useValue: unknown };
    expect(provider.useValue).toEqual({
      address: 'http://127.0.0.1:4646',
      token: 'test-acl-token',
      namespace: 'default',
      timeoutMs: 30_000,
      tlsSkipVerify: false,
      adminOrganizationId: '',
    });
  });
});
