import { defineFrontendPluginsConfig, type PluginFrontendManifest } from '@hydrahost/plugin-sdk';
import { webvmTerminalFrontendManifest as webvmTerminal } from '@hydrahost/plugin-webvm-terminal/frontend-manifest';
import { optionalFrontendManifests } from './optional-frontend.generated';

// This array's order is what the sidebar rail renders, so it is declared once here instead of being
// split across the generator; the plugin set matches `./index.ts` but the order deliberately does not.
const SIDEBAR_ORDER = [
  'helpdesk-pylon',
  'analytics',
  'webvm-terminal',
  'operator-hub',
  'google-maps-geocoding',
  'radar-geocoding',
  'hubspot-leads',
  'salesforce-leads',
  'lender-device-associations',
  'commerce',
  'bid-ask',
  'device-monitoring',
];

export const sidebarOrder: readonly string[] = SIDEBAR_ORDER;

// An id absent from SIDEBAR_ORDER renders last rather than vanishing, since a dropped tab is a worse
// failure than a mis-placed one; the ordering spec fails on the omission itself.
export function orderFrontendManifests(manifests: readonly PluginFrontendManifest[]): PluginFrontendManifest[] {
  const ranked = SIDEBAR_ORDER.flatMap((id) => manifests.filter((plugin) => plugin.id === id));
  return [...ranked, ...manifests.filter((plugin) => !SIDEBAR_ORDER.includes(plugin.id))];
}

// webvm-terminal is guaranteed present in every tree, so it stays a static typed import; enablement
// is fetched from the backend at runtime, which is why no entry declares it here.
const frontendPluginsConfig = defineFrontendPluginsConfig(
  orderFrontendManifests([webvmTerminal, ...optionalFrontendManifests]).map((plugin) => ({ plugin })),
);

export default frontendPluginsConfig;
