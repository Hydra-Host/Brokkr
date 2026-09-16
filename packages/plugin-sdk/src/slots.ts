import type { ComponentType } from 'react';

/** Named extension points in the host UI. Stable surface: slots are never removed or renamed in a minor SDK release. */
export const EXTENSION_SLOTS = [
  'dashboard-widget',
  'sidebar-nav',
  'public-navbar',
  'address-autocomplete',
  'inventory-page-extras',
  'inventory-item-cta',
  'app-banner',
] as const;

export type ExtensionSlot = (typeof EXTENSION_SLOTS)[number];

export interface PluginRouteProps {
  pluginId: string;
  splat: string;
  /** Loading screen provided by the host. Render this while async data loads; omit or render nothing if absent. */
  LoadingScreen?: ComponentType;
  /** Signed-in user's email when a session exists; omit or empty for anonymous visitors. */
  userEmail?: string;
  /** Active organization id when a session exists. Key per-organization queries on it: the host's query cache
   * survives organization switches. */
  organizationId?: string;
}

export interface PluginRoute {
  component: ComponentType<PluginRouteProps>;
  label: string;
  description?: string;
}

/** Host layout for a public plugin SPA path. `navbar` is `_navbar-layout` (same chrome as `/inventory`). Authenticated plugin pages use `rootRoute`, not this. */
export type PluginPublicRouteLayout = 'navbar';

export interface PluginPublicRoute {
  component: ComponentType<PluginRouteProps>;
  /** Absolute product URL with no query/hash. The host disables plugins that collide with core or plugin routes. */
  path: string;
  layout: PluginPublicRouteLayout;
}

export interface PublicNavbarContribution {
  label: string;
  to: string;
  external?: boolean;
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

/** Rendered above the page content on every authenticated app route. Contributions render `null` when they have nothing to say. */
export interface AppBannerSlotProps {
  /** Current route pathname, so a plugin can suppress its banner on its own pages without importing the router. */
  pathname: string;
  /** Active organization id. Key per-organization queries on it: the host's query cache survives organization switches. */
  organizationId: string;
}

export interface AppBannerSlotContribution {
  component: ComponentType<AppBannerSlotProps>;
}

export interface SlotContributionMap {
  'dashboard-widget': DashboardWidgetContribution;
  'sidebar-nav': SidebarNavContribution;
  'public-navbar': PublicNavbarContribution;
  'address-autocomplete': AddressAutocompleteContribution;
  'inventory-page-extras': InventoryPageExtrasContribution;
  'inventory-item-cta': InventoryItemCtaContribution;
  'app-banner': AppBannerSlotContribution;
}

type PluginFrontendSlots = {
  slots?: {
    [K in ExtensionSlot]?: SlotContributionMap[K][];
  };
};

/** `rootRoute` is ignored at runtime when `publicRoutes` is non-empty — the type forbids both. */
export type PluginFrontendModule = PluginFrontendSlots &
  (
    | {
        /** Authenticated page at `/plugins/:id` (host `_app` shell). Omit when the UI is public-only. */
        rootRoute?: PluginRoute;
        publicRoutes?: never;
      }
    | {
        rootRoute?: never;
        /** Public pages. `layout: 'navbar'` mounts on `_navbar-layout` via the host public-plugin splat. */
        publicRoutes: PluginPublicRoute[];
      }
  );

export function defineFrontendModule(module: PluginFrontendModule): PluginFrontendModule {
  return module;
}
