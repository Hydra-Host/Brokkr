import { definePluginsConfig, type PluginConfigEntry, type PluginManifest } from '@hydrahost/plugin-sdk';
import { webvmTerminalManifest as webvmTerminal } from '@hydrahost/plugin-webvm-terminal';
import { Logger, type Provider } from '@nestjs/common';
import { createRequire } from 'node:module';
import type { z } from 'zod';

// Must precede the loadOptionalPluginEntries() module-eval call below — a later `const` would hit the TDZ and throw on import.
const MODULE_ABSENT_CODES = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);

type RequireFn = (specifier: string) => unknown;

const mailgunApiKey = process.env.MAILGUN_API_KEY ?? '';
const mailgunDomain = process.env.MAILGUN_DOMAIN ?? '';
const mailgunFromAddress = process.env.MAILGUN_FROM_ADDRESS || process.env.EMAIL_FROM || '';
const mailgunConfigured = mailgunApiKey !== '' && mailgunDomain !== '' && mailgunFromAddress !== '';

const radarSecretKey = process.env.RADAR_SECRET_KEY ?? '';
const radarConfigured = radarSecretKey !== '';
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
const googleMapsConfigured = googleMapsApiKey !== '';

const hubspotAccessToken = process.env.HUBSPOT_ACCESS_TOKEN ?? '';
const hubspotPortalId = process.env.HUBSPOT_PORTAL_ID ?? '';
const hubspotContactOwnerId = process.env.HUBSPOT_CONTACT_OWNER_ID ?? '';
const hubspotDemandRequestFormId = process.env.HUBSPOT_FORM_ID_DEMAND_REQUEST ?? '';
const hubspotDemandRequestObjectTypeId = process.env.HUBSPOT_DEMAND_REQUEST_OBJECT_TYPE_ID ?? '';
const hubspotLeadsConfigured =
  hubspotAccessToken !== '' &&
  hubspotPortalId !== '' &&
  hubspotContactOwnerId !== '' &&
  hubspotDemandRequestFormId !== '' &&
  hubspotDemandRequestObjectTypeId !== '';
const hubspotTrackerRaw = process.env.HUBSPOT_TRACKER_PORTAL_ID || hubspotPortalId;
const hubspotTrackerPortalId = hubspotTrackerRaw.toLowerCase() === 'off' ? '' : hubspotTrackerRaw;

const salesforceMyDomainUrl = process.env.SALESFORCE_MY_DOMAIN_URL ?? '';
const salesforceClientId = process.env.SALESFORCE_CLIENT_ID ?? '';
const salesforceClientSecret = process.env.SALESFORCE_CLIENT_SECRET ?? '';
const salesforceLeadOwnerId = process.env.SALESFORCE_LEAD_OWNER_ID ?? '';
const salesforceApiVersion = process.env.SALESFORCE_API_VERSION ?? '';
const salesforceLeadsConfigured =
  salesforceMyDomainUrl !== '' && salesforceClientId !== '' && salesforceClientSecret !== '';

// `enabled: false` short-circuits configSchema validation, so empty settings don't throw where env is unset.
const pylonApiToken = process.env.PYLON_API_TOKEN ?? '';
const pylonAccountId = process.env.PYLON_ACCOUNT_ID ?? '';
const pylonHydrahostOrgId = process.env.BROKKR_ADMIN_ORG_ID ?? '';
const pylonConfigured = pylonApiToken !== '' && pylonAccountId !== '' && pylonHydrahostOrgId !== '';
const pylonEnvironment = process.env.HH_ENV ?? 'dev';
const pylonOpsContactEmail =
  process.env.PYLON_OPS_CONTACT_EMAIL || process.env.HYDRAHOST_OPS_CONTACT_EMAIL || 'ops@example.com';
const pylonBrokkrHostTemplate = process.env.PYLON_BROKKR_HOST_TEMPLATE ?? 'brokkr.{env}.example.com';

const clickhouseHost = process.env.CLICKHOUSE_HOST ?? '';
const clickhouseUser = process.env.CLICKHOUSE_USER ?? '';
const clickhousePassword = process.env.CLICKHOUSE_PASSWORD ?? '';
const clickhouseConfigured = clickhouseHost !== '' && clickhouseUser !== '' && clickhousePassword !== '';

type OptionalEntry = PluginConfigEntry<PluginManifest<z.ZodTypeAny>>;

export function loadOptionalPluginEntries(requireFn: RequireFn = createRequire(import.meta.url)): OptionalEntry[] {
  const entries: OptionalEntry[] = [];
  // Slot-sharing precedence keys on the winner being present, not merely configured; each pair's
  // winner is loaded before its runner-up below, so these flags are set by the time they are read.
  let googleMapsPresent = false;
  let hubspotLeadsPresent = false;
  // sync-sentinel: dynamic require — absence must be a caught runtime miss. Do not statically import.
  loadOptionalManifest(requireFn, '@hydrahost/plugin-helpdesk-pylon', 'helpdeskPylonManifest', (plugin) => {
    entries.push({
      plugin,
      enabled: pylonConfigured,
      settings: {
        apiToken: pylonApiToken,
        accountId: pylonAccountId,
        environment: pylonEnvironment,
        brokkrHostTemplate: pylonBrokkrHostTemplate,
        hydraHostOrganizationId: pylonHydrahostOrgId,
        opsContactEmail: pylonOpsContactEmail,
        enableSystemTickets: pylonEnvironment === 'prod',
      },
    });
  });
  loadOptionalManifest(requireFn, '@hydrahost/plugin-analytics', 'analyticsManifest', (plugin) => {
    entries.push({
      plugin,
      enabled: clickhouseConfigured,
      settings: {
        clickhouseHost,
        clickhouseUser,
        clickhousePassword,
        environment: process.env.HH_ENV ?? 'dev',
      },
    });
  });
  // Operator lifecycle API: always enabled when present — access is gated by the plugin's own guard
  // (instance-operator designation OR the admin org below), not by this flag.
  loadOptionalManifest(requireFn, '@hydrahost/plugin-operator-lifecycle', 'operatorLifecycleManifest', (plugin) => {
    entries.push({
      plugin,
      enabled: true,
      settings: { adminOrganizationId: process.env.BROKKR_ADMIN_ORG_ID ?? '' },
    });
  });
  // Operator bridge-requests API: always enabled when present — access is gated by the plugin's
  // own guard (instance-operator designation OR the admin org below), not by this flag.
  loadOptionalManifest(
    requireFn,
    '@hydrahost/plugin-operator-bridge-requests',
    'operatorBridgeRequestsManifest',
    (plugin) => {
      entries.push({
        plugin,
        enabled: true,
        settings: { adminOrganizationId: process.env.BROKKR_ADMIN_ORG_ID ?? '' },
      });
    },
  );
  // Lender device associations: always enabled when present — operator routes are gated by the
  // plugin's own guard; tenant list is scoped to the caller organization.
  loadOptionalManifest(
    requireFn,
    '@hydrahost/plugin-lender-device-associations',
    'lenderDeviceAssociationsManifest',
    (plugin) => {
      entries.push({
        plugin,
        enabled: true,
        settings: { adminOrganizationId: process.env.BROKKR_ADMIN_ORG_ID ?? '' },
      });
    },
  );
  // Device-monitoring Prometheus proxy: always enabled when present. Empty Thanos
  // settings fail closed per request (503); the adapter constructor must not throw at boot.
  loadOptionalManifest(requireFn, '@hydrahost/plugin-device-monitoring', 'deviceMonitoringManifest', (plugin) => {
    entries.push({
      plugin,
      enabled: true,
      settings: {
        thanosBaseUrl: process.env.AIVEN_THANOS_BASE_URL ?? '',
        thanosUsername: process.env.AIVEN_THANOS_USERNAME ?? '',
        thanosPassword: process.env.AIVEN_THANOS_PASSWORD ?? '',
      },
    });
  });
  loadOptionalManifest(requireFn, '@hydrahost/plugin-email-mailgun', 'emailMailgunManifest', (plugin) => {
    entries.push({
      plugin,
      enabled: mailgunConfigured,
      settings: {
        apiKey: mailgunApiKey,
        apiUrl: process.env.MAILGUN_API_URL || 'https://api.mailgun.net',
        domain: mailgunDomain,
        fromAddress: mailgunFromAddress,
      },
    });
  });
  loadOptionalManifest(requireFn, '@hydrahost/plugin-operator-hub', 'operatorHubManifest', (plugin) => {
    entries.push({ plugin, enabled: true, settings: {} });
  });
  loadOptionalManifest(
    requireFn,
    '@hydrahost/plugin-google-maps-geocoding',
    'googleMapsGeocodingManifest',
    (plugin) => {
      googleMapsPresent = true;
      entries.push({
        plugin,
        enabled: googleMapsConfigured,
        settings: {
          apiKey: googleMapsApiKey,
          apiUrl: process.env.GOOGLE_MAPS_API_URL || 'https://places.googleapis.com',
        },
      });
    },
  );
  loadOptionalManifest(requireFn, '@hydrahost/plugin-radar-geocoding', 'radarGeocodingManifest', (plugin) => {
    entries.push({
      plugin,
      enabled: radarConfigured && !(googleMapsPresent && googleMapsConfigured),
      settings: {
        secretKey: radarSecretKey,
        apiUrl: process.env.RADAR_API_URL || 'https://api.radar.io',
      },
    });
  });
  loadOptionalManifest(requireFn, '@hydrahost/plugin-hubspot-leads', 'hubspotLeadsManifest', (plugin) => {
    hubspotLeadsPresent = true;
    entries.push({
      plugin,
      enabled: hubspotLeadsConfigured,
      settings: {
        accessToken: hubspotAccessToken,
        portalId: hubspotPortalId,
        contactOwnerId: hubspotContactOwnerId,
        demandRequestFormId: hubspotDemandRequestFormId,
        demandRequestObjectTypeId: hubspotDemandRequestObjectTypeId,
        trackerPortalId: hubspotTrackerPortalId,
      },
    });
  });
  loadOptionalManifest(requireFn, '@hydrahost/plugin-salesforce-leads', 'salesforceLeadsManifest', (plugin) => {
    entries.push({
      plugin,
      enabled: salesforceLeadsConfigured && !(hubspotLeadsPresent && hubspotLeadsConfigured),
      settings: {
        myDomainUrl: salesforceMyDomainUrl,
        clientId: salesforceClientId,
        clientSecret: salesforceClientSecret,
        leadOwnerId: salesforceLeadOwnerId,
        ...(salesforceApiVersion && { apiVersion: salesforceApiVersion }),
      },
    });
  });
  // Warned here rather than at module scope so the message can name the plugin that actually won;
  // which sibling is installed is only known once the probes above have run.
  if (googleMapsConfigured && radarConfigured) {
    const active = googleMapsPresent ? 'google-maps-geocoding' : 'radar-geocoding';
    new Logger('plugins-config').warn(
      `Both google-maps-geocoding and radar-geocoding are configured; they share the address-autocomplete slot, so only ${active} is active.`,
    );
  }
  if (hubspotLeadsConfigured && salesforceLeadsConfigured) {
    const active = hubspotLeadsPresent ? 'hubspot-leads' : 'salesforce-leads';
    new Logger('plugins-config').warn(
      `Both hubspot-leads and salesforce-leads are configured; they share the same inventory UI slots, so only ${active} is active.`,
    );
  }
  return entries;
}

// WebVM terminal is frontend-only (no backend module, no secrets), so it's enabled by default. It is
// the one plugin the public mirror always ships, so it stays a static import with typed settings.
const publicPluginsConfig = definePluginsConfig([
  {
    plugin: webvmTerminal,
    enabled: process.env.WEBVM_TERMINAL_ENABLED !== 'false',
    settings: {},
  },
]);

const pluginsConfig = [...loadOptionalPluginEntries(), ...publicPluginsConfig];

export default pluginsConfig;

export function loadManagedEditionOverrides(requireFn: RequireFn = createRequire(import.meta.url)): Provider[] {
  // Local-only escape hatch; never set in dev/stg/prod.
  if (process.env.HH_FORCE_BOSS === 'true') {
    new Logger('plugins-config').log('HH_FORCE_BOSS=true — running the BOSS edition (managed overrides skipped)');
    return [];
  }
  try {
    // sync-sentinel: dynamic require — absence must be a caught runtime miss. Do not statically import.
    const managed = requireFn('@hydrahost/managed-edition') as { editionOverrides?: Provider[] };
    const overrides = managed.editionOverrides ?? [];
    new Logger('plugins-config').log(`edition: managed (${overrides.length} override(s) active)`);
    return overrides;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== undefined && MODULE_ABSENT_CODES.has(code)) {
      new Logger('plugins-config').log('edition: BOSS (managed-edition not installed)');
      return [];
    }
    new Logger('plugins-config').warn(
      `managed-edition present but failed to load (${code ?? (err as Error)?.message}); ` +
        'degrading to core BOSS editionOverrides ([])',
    );
    return [];
  }
}

function loadOptionalManifest(
  requireFn: RequireFn,
  specifier: string,
  manifestExport: string,
  onPresent: (plugin: PluginManifest<z.ZodTypeAny>) => void,
): void {
  let mod: Record<string, unknown>;
  try {
    mod = requireFn(specifier) as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== undefined && MODULE_ABSENT_CODES.has(code)) {
      new Logger('plugins-config').log(`plugin ${specifier} not installed (BOSS tree) — skipped`);
      return;
    }
    new Logger('plugins-config').warn(
      `plugin ${specifier} present but failed to load (${code ?? (err as Error)?.message}); skipping`,
    );
    return;
  }
  const plugin = mod[manifestExport] as PluginManifest<z.ZodTypeAny> | undefined;
  if (!plugin) {
    new Logger('plugins-config').warn(`plugin ${specifier} loaded but has no '${manifestExport}' export; skipping`);
    return;
  }
  onPresent(plugin);
}

export const editionOverrides: Provider[] = loadManagedEditionOverrides();
