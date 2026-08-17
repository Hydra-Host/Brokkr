import type { ComponentType } from 'react';

/** Named extension points in the host UI. Stable surface: slots are never removed or renamed in a minor SDK release. */
export const EXTENSION_SLOTS = [
  'dashboard-widget',
  'sidebar-nav',
  'address-autocomplete',
  'inventory-page-extras',
  'inventory-item-cta',
] as const;

export type ExtensionSlot = (typeof EXTENSION_SLOTS)[number];

export interface PluginRouteProps {
  pluginId: string;
  splat: string;
}

export interface PluginRoute {
  component: ComponentType<PluginRouteProps>;
  label: string;
  description?: string;
}

export interface DashboardWidgetContribution {
  component: ComponentType<{ pluginId: string }>;
  label?: string;
}

export interface SidebarNavContribution {
  label: string;
  to: string;
  icon?: ComponentType<{ className?: string }>;
  section?: string;
  sectionIcon?: ComponentType<{ className?: string }>;
  external?: boolean;
  /** Open `to` in a popup window; an already-open window is never re-navigated, so its state survives
   * repeat clicks. Takes precedence over `external`. Defaults to `false`. */
  popup?: boolean;
}

/** Geocoder result. All optional: the host writes only present keys, so a partial match never blanks a user-filled field. Field names mirror the zone address form. */
export interface ResolvedAddress {
  addressLineOne?: string;
  addressLineTwo?: string;
  city?: string;
  stateOrProvince?: string;
  postalCode?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}

export interface AddressAutocompleteSlotProps {
  pluginId: string;
  /** Host applies the resolved parts to its own form (plugin never imports a form library); may fire more than once per pick (e.g. timezone resolves later). */
  onResolved: (address: ResolvedAddress) => void;
}

export interface AddressAutocompleteContribution {
  component: ComponentType<AddressAutocompleteSlotProps>;
}

export interface InventoryPageExtrasSlotProps {
  pluginId: string;
  category?: string;
  userEmail?: string;
  hasListings: boolean;
  isAuthenticated: boolean;
  /** True while session resolution is pending (`userEmail` may be missing for a signed-in visitor) — don't gate blocking surfaces on anonymity until settled. Absent = settled. */
  sessionPending?: boolean;
}

export interface InventoryPageExtrasContribution {
  component: ComponentType<InventoryPageExtrasSlotProps>;
}

export interface InventoryItemCtaDevice {
  name: string;
  gpuModel?: string | null;
  gpuCount?: number | null;
  cpuModel?: string | null;
  cpuCount?: number | null;
  cpuCoreCount?: number | null;
  memory?: number | null;
  ssdSize?: number | null;
  hddSize?: number | null;
  nvmeSize?: number | null;
}

export interface InventoryItemCtaSlotProps {
  pluginId: string;
  category?: string;
  userEmail?: string;
  device: InventoryItemCtaDevice;
}

export interface InventoryItemCtaContribution {
  component: ComponentType<InventoryItemCtaSlotProps>;
}

export interface SlotContributionMap {
  'dashboard-widget': DashboardWidgetContribution;
  'sidebar-nav': SidebarNavContribution;
  'address-autocomplete': AddressAutocompleteContribution;
  'inventory-page-extras': InventoryPageExtrasContribution;
  'inventory-item-cta': InventoryItemCtaContribution;
}

export interface PluginFrontendModule {
  slots?: {
    [K in ExtensionSlot]?: SlotContributionMap[K][];
  };
  rootRoute?: PluginRoute;
}

export function defineFrontendModule(module: PluginFrontendModule): PluginFrontendModule {
  return module;
}
