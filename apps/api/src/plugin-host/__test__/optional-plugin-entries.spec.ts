import { loadOptionalPluginEntries } from '@hydrahost/plugins-config';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

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
  '@hydrahost/plugin-email-mailgun': 'emailMailgunManifest',
  '@hydrahost/plugin-operator-hub': 'operatorHubManifest',
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

const enabledWith = async (env: Record<string, string>, specifiers: string[]): Promise<Map<string, boolean>> => {
  const saved = process.env;
  process.env = { ...saved, ...env };
  vi.resetModules();
  try {
    const mod = await import('@hydrahost/plugins-config');
    return new Map(mod.loadOptionalPluginEntries(resolving(specifiers)).map((e) => [e.plugin.id, e.enabled]));
  } finally {
    process.env = saved;
  }
};

const warningsWith = async (env: Record<string, string>, specifiers: string[]): Promise<string[]> => {
  const saved = process.env;
  process.env = { ...saved, ...env };
  vi.resetModules();
  const lines: string[] = [];
  const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    lines.push(String(message));
  });
  try {
    const mod = await import('@hydrahost/plugins-config');
    lines.length = 0;
    mod.loadOptionalPluginEntries(resolving(specifiers));
    return lines;
  } finally {
    spy.mockRestore();
    process.env = saved;
  }
};

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
