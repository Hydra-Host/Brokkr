import { loadOptionalPluginEntries } from '@hydrahost/plugins-config';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ABSENT = (specifier: string): never => {
  const err = new Error(`Cannot find module '${specifier}'`) as NodeJS.ErrnoException;
  err.code = 'MODULE_NOT_FOUND';
  throw err;
};

const MANIFEST_EXPORTS: Record<string, string> = {
  '@hydrahost/plugin-helpdesk-pylon': 'helpdeskPylonManifest',
  '@hydrahost/plugin-analytics': 'analyticsManifest',
  '@hydrahost/plugin-operator-lifecycle': 'operatorLifecycleManifest',
  '@hydrahost/plugin-operator-bridge-requests': 'operatorBridgeRequestsManifest',
  '@hydrahost/plugin-lender-device-associations': 'lenderDeviceAssociationsManifest',
  '@hydrahost/plugin-bid-ask': 'bidAskManifest',
  '@hydrahost/plugin-email-mailgun': 'emailMailgunManifest',
  '@hydrahost/plugin-operator-hub': 'operatorHubManifest',
  '@hydrahost/plugin-commerce': 'commerceManifest',
  '@hydrahost/plugin-google-maps-geocoding': 'googleMapsGeocodingManifest',
  '@hydrahost/plugin-radar-geocoding': 'radarGeocodingManifest',
  '@hydrahost/plugin-hubspot-leads': 'hubspotLeadsManifest',
  '@hydrahost/plugin-salesforce-leads': 'salesforceLeadsManifest',
};

const idOf = (specifier: string): string => specifier.replace('@hydrahost/plugin-', '');

const resolving =
  (specifiers: string[]) =>
  (specifier: string): unknown => {
    if (!specifiers.includes(specifier)) return ABSENT(specifier);
    return { [MANIFEST_EXPORTS[specifier]]: { id: idOf(specifier) } };
  };

const GEOCODING_ENV = { GOOGLE_MAPS_API_KEY: 'gmaps-key', RADAR_SECRET_KEY: 'radar-key' };
const COMMERCE_ENV = { COMMERCE_API_BASE_URL: 'http://localhost:3003', COMMERCE_API_KEY: 'sk_test' };
const LEADS_ENV = {
  HUBSPOT_ACCESS_TOKEN: 'token',
  HUBSPOT_PORTAL_ID: 'portal',
  HUBSPOT_CONTACT_OWNER_ID: 'owner',
  HUBSPOT_FORM_ID_DEMAND_REQUEST: 'form',
  HUBSPOT_DEMAND_REQUEST_OBJECT_TYPE_ID: 'object',
  SALESFORCE_MY_DOMAIN_URL: 'https://example.my.salesforce.com',
  SALESFORCE_CLIENT_ID: 'client',
  SALESFORCE_CLIENT_SECRET: 'secret',
};

type OptionalPluginEntry = ReturnType<typeof loadOptionalPluginEntries>[number];

const entriesWith = async (
  env: Record<string, string>,
  specifiers: string[],
): Promise<{ entries: OptionalPluginEntry[]; warnings: string[] }> => {
  const saved = process.env;
  process.env = { ...saved, ...env };
  vi.resetModules();
  const warnings: string[] = [];
  const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  try {
    const mod = await import('@hydrahost/plugins-config');
    warnings.length = 0;
    return { entries: mod.loadOptionalPluginEntries(resolving(specifiers)), warnings };
  } finally {
    spy.mockRestore();
    process.env = saved;
  }
};

const enabledWith = async (env: Record<string, string>, specifiers: string[]): Promise<Map<string, boolean>> =>
  new Map((await entriesWith(env, specifiers)).entries.map((e) => [e.plugin.id, e.enabled]));

const settingsWith = async (env: Record<string, string>, specifiers: string[]): Promise<Record<string, unknown>> =>
  Object.fromEntries((await entriesWith(env, specifiers)).entries.map((e) => [e.plugin.id, e.settings]));

const warningsWith = async (env: Record<string, string>, specifiers: string[]): Promise<string[]> =>
  (await entriesWith(env, specifiers)).warnings;

describe('loadOptionalPluginEntries', () => {
  it('returns no entries when every optional package is absent (public BOSS tree)', () => {
    expect(loadOptionalPluginEntries(ABSENT)).toEqual([]);
  });

  it('wires one entry per resolvable package, using its manifest export', () => {
    const entries = loadOptionalPluginEntries(resolving(Object.keys(MANIFEST_EXPORTS)));
    expect(entries.map((e) => e.plugin)).toEqual(Object.keys(MANIFEST_EXPORTS).map((s) => ({ id: idOf(s) })));
    for (const entry of entries) expect(typeof entry.enabled).toBe('boolean');
  });

  it('keeps the registry order stable when only a subset resolves', () => {
    const entries = loadOptionalPluginEntries(
      resolving(['@hydrahost/plugin-operator-hub', '@hydrahost/plugin-analytics', '@hydrahost/plugin-hubspot-leads']),
    );
    expect(entries.map((e) => e.plugin.id)).toEqual(['analytics', 'operator-hub', 'hubspot-leads']);
  });

  describe('operator-hub edition gating', () => {
    const resolvingManaged =
      (specifiers: string[]) =>
      (specifier: string): unknown => {
        if (specifier === '@hydrahost/managed-edition') {
          return {
            editionOverrides: [],
            managedEditionManifest: { id: 'managed-edition' },
          };
        }
        return resolving(specifiers)(specifier);
      };

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('omits operator-hub when managed-edition is installed and registers the managed gate plugin', () => {
      const entries = loadOptionalPluginEntries(
        resolvingManaged(['@hydrahost/plugin-operator-hub', '@hydrahost/plugin-analytics']),
      );
      expect(entries.map((e) => e.plugin.id)).toEqual(['analytics', 'managed-edition']);
    });

    it('keeps operator-hub when HH_FORCE_BOSS even if managed-edition is installed', () => {
      vi.stubEnv('HH_FORCE_BOSS', 'true');
      const entries = loadOptionalPluginEntries(resolvingManaged(['@hydrahost/plugin-operator-hub']));
      expect(entries.map((e) => e.plugin.id)).toEqual(['operator-hub']);
    });

    it('keeps operator-hub on the public BOSS tree (managed-edition absent)', () => {
      const entries = loadOptionalPluginEntries(resolving(['@hydrahost/plugin-operator-hub']));
      expect(entries.map((e) => e.plugin.id)).toEqual(['operator-hub']);
    });

    it('keeps operator-hub and warns when managed-edition throws a non-absent error', () => {
      const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const requireFn = (specifier: string): unknown => {
        if (specifier === '@hydrahost/managed-edition') throw new Error('corrupt');
        return resolving(['@hydrahost/plugin-operator-hub'])(specifier);
      };
      try {
        const entries = loadOptionalPluginEntries(requireFn);
        expect(entries.map((e) => e.plugin.id)).toEqual(['operator-hub']);
        expect(spy.mock.calls.some((call) => String(call[0]).includes('operator-hub will be registered'))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('skips a package that resolves but lacks its manifest export (no throw)', () => {
    const present = (specifier: string): unknown =>
      specifier === '@hydrahost/plugin-helpdesk-pylon' ? {} : ABSENT(specifier);
    expect(loadOptionalPluginEntries(present)).toEqual([]);
  });

  describe('slot-sharing precedence', () => {
    it('disables radar-geocoding when google-maps-geocoding is present and configured', async () => {
      const enabled = await enabledWith(GEOCODING_ENV, [
        '@hydrahost/plugin-google-maps-geocoding',
        '@hydrahost/plugin-radar-geocoding',
      ]);
      expect(enabled.get('google-maps-geocoding')).toBe(true);
      expect(enabled.get('radar-geocoding')).toBe(false);
    });

    it('leaves radar-geocoding enabled when google-maps-geocoding is configured but absent', async () => {
      const enabled = await enabledWith(GEOCODING_ENV, ['@hydrahost/plugin-radar-geocoding']);
      expect(enabled.get('radar-geocoding')).toBe(true);
    });

    it('disables salesforce-leads when hubspot-leads is present and configured', async () => {
      const enabled = await enabledWith(LEADS_ENV, [
        '@hydrahost/plugin-hubspot-leads',
        '@hydrahost/plugin-salesforce-leads',
      ]);
      expect(enabled.get('hubspot-leads')).toBe(true);
      expect(enabled.get('salesforce-leads')).toBe(false);
    });

    it('leaves salesforce-leads enabled when hubspot-leads is configured but absent', async () => {
      const enabled = await enabledWith(LEADS_ENV, ['@hydrahost/plugin-salesforce-leads']);
      expect(enabled.get('salesforce-leads')).toBe(true);
    });
  });

  describe('commerce enablement', () => {
    it('enables commerce when both the origin and the API key are set', async () => {
      const enabled = await enabledWith(
        { COMMERCE_API_BASE_URL: 'http://localhost:3003', COMMERCE_API_KEY: 'sk_test' },
        ['@hydrahost/plugin-commerce'],
      );
      expect(enabled.get('commerce')).toBe(true);
    });

    it('disables commerce when the API key is missing', async () => {
      const enabled = await enabledWith({ COMMERCE_API_BASE_URL: 'http://localhost:3003', COMMERCE_API_KEY: '' }, [
        '@hydrahost/plugin-commerce',
      ]);
      expect(enabled.get('commerce')).toBe(false);
    });

    it('disables commerce when the origin is missing', async () => {
      const enabled = await enabledWith({ COMMERCE_API_BASE_URL: '', COMMERCE_API_KEY: 'sk_test' }, [
        '@hydrahost/plugin-commerce',
      ]);
      expect(enabled.get('commerce')).toBe(false);
    });

    it('takes the public web origin from WEB_BASE_URL', async () => {
      const settings = await settingsWith(
        { ...COMMERCE_ENV, WEB_BASE_URL: 'https://boss.test', BASE_URL: 'https://fallback.test' },
        ['@hydrahost/plugin-commerce'],
      );
      expect(settings.commerce).toMatchObject({ webBaseUrl: 'https://boss.test' });
    });

    it('falls back to BASE_URL when WEB_BASE_URL is unset', async () => {
      const settings = await settingsWith({ ...COMMERCE_ENV, WEB_BASE_URL: '', BASE_URL: 'https://fallback.test' }, [
        '@hydrahost/plugin-commerce',
      ]);
      expect(settings.commerce).toMatchObject({ webBaseUrl: 'https://fallback.test' });
    });

    it('omits the public web origin when neither variable is set', async () => {
      const settings = await settingsWith({ ...COMMERCE_ENV, WEB_BASE_URL: '', BASE_URL: '' }, [
        '@hydrahost/plugin-commerce',
      ]);
      expect(settings.commerce).not.toHaveProperty('webBaseUrl');
    });
  });

  describe('bid-ask enablement', () => {
    it('enables bid-ask when the package is present and HubSpot env is unset', async () => {
      const enabled = await enabledWith(
        {
          HUBSPOT_ACCESS_TOKEN: '',
          HUBSPOT_PORTAL_ID: '',
          HUBSPOT_CONTACT_OWNER_ID: '',
          HUBSPOT_FORM_ID_DEMAND_REQUEST: '',
          HUBSPOT_DEMAND_REQUEST_OBJECT_TYPE_ID: '',
        },
        ['@hydrahost/plugin-bid-ask'],
      );
      expect(enabled.get('bid-ask')).toBe(true);
    });

    it('enables bid-ask when HubSpot env is set', async () => {
      const enabled = await enabledWith(LEADS_ENV, ['@hydrahost/plugin-bid-ask']);
      expect(enabled.get('bid-ask')).toBe(true);
    });

    it('does not enable hubspot-leads as a side effect of bid-ask being present', async () => {
      const enabled = await enabledWith(
        {
          HUBSPOT_ACCESS_TOKEN: '',
          HUBSPOT_PORTAL_ID: '',
          HUBSPOT_CONTACT_OWNER_ID: '',
          HUBSPOT_FORM_ID_DEMAND_REQUEST: '',
          HUBSPOT_DEMAND_REQUEST_OBJECT_TYPE_ID: '',
        },
        ['@hydrahost/plugin-bid-ask', '@hydrahost/plugin-hubspot-leads'],
      );
      expect(enabled.get('bid-ask')).toBe(true);
      expect(enabled.get('hubspot-leads')).toBe(false);
    });
  });

  describe('slot-sharing warnings', () => {
    it('names google-maps-geocoding as active when both are configured and installed', async () => {
      const lines = await warningsWith(GEOCODING_ENV, [
        '@hydrahost/plugin-google-maps-geocoding',
        '@hydrahost/plugin-radar-geocoding',
      ]);
      expect(lines.some((l) => l.includes('only google-maps-geocoding is active'))).toBe(true);
    });

    it('names radar-geocoding as active when google-maps-geocoding is configured but not installed', async () => {
      const lines = await warningsWith(GEOCODING_ENV, ['@hydrahost/plugin-radar-geocoding']);
      expect(lines.some((l) => l.includes('only radar-geocoding is active'))).toBe(true);
      expect(lines.some((l) => l.includes('only google-maps-geocoding is active'))).toBe(false);
    });

    it('names salesforce-leads as active when hubspot-leads is configured but not installed', async () => {
      const lines = await warningsWith(LEADS_ENV, ['@hydrahost/plugin-salesforce-leads']);
      expect(lines.some((l) => l.includes('only salesforce-leads is active'))).toBe(true);
    });

    it('stays silent when only one of a slot-sharing pair is configured', async () => {
      const lines = await warningsWith({ GOOGLE_MAPS_API_KEY: 'gmaps-key', RADAR_SECRET_KEY: '' }, [
        '@hydrahost/plugin-google-maps-geocoding',
      ]);
      expect(lines.some((l) => l.includes('address-autocomplete slot'))).toBe(false);
    });
  });
});
