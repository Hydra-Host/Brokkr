import { getPluginConfigToken, type PluginManifest } from '@hydrahost/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildPluginConfigProviders } from '../config-providers';

function makeManifest<TSchema extends z.ZodTypeAny>(id: string, configSchema?: TSchema): PluginManifest<TSchema> {
  return { id, version: '0.0.0', configSchema } as PluginManifest<TSchema>;
}

const pylonSchema = z.object({
  apiToken: z.string().min(1),
  accountId: z.string().min(1),
});

describe('buildPluginConfigProviders', () => {
  it('throws at config-provider build time naming the plugin and each Zod issue', () => {
    const manifest = makeManifest('acme-pylon', pylonSchema);
    const entries = [{ plugin: manifest, enabled: true, settings: { apiToken: '', accountId: '' } }];

    let caught: unknown;
    try {
      buildPluginConfigProviders(entries);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('acme-pylon');
    expect(message).toContain('apiToken');
    expect(message).toContain('accountId');
  });

  it('resolves an unconfigured optional plugin to enabled:false and contributes no config provider', () => {
    const manifest = makeManifest('acme-pylon', pylonSchema);
    const entries = [{ plugin: manifest, enabled: false, settings: { apiToken: '', accountId: '' } }];

    const providers = buildPluginConfigProviders(entries);

    expect(providers).toEqual([]);
  });

  it('binds the config token for a configured optional plugin', () => {
    const manifest = makeManifest('acme-pylon', pylonSchema);
    const settings = { apiToken: 'tok', accountId: 'acct' };
    const entries = [{ plugin: manifest, enabled: true, settings }];

    const providers = buildPluginConfigProviders(entries);

    expect(providers).toHaveLength(1);
    const provider = providers[0] as { provide: symbol; useValue: unknown };
    expect(provider.provide).toBe(getPluginConfigToken('acme-pylon'));
    expect(provider.useValue).toEqual(settings);
  });

  it('skips an enabled plugin that declares no configSchema', () => {
    const manifest = makeManifest('acme-noschema');
    const entries = [{ plugin: manifest, enabled: true }];

    expect(buildPluginConfigProviders(entries)).toEqual([]);
  });
});
