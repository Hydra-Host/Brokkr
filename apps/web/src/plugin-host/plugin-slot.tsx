import type {
  AddressAutocompleteContribution,
  AppBannerSlotContribution,
  DashboardWidgetContribution,
  InventoryItemCtaContribution,
  InventoryItemCtaDevice,
  InventoryPageExtrasContribution,
  PublicNavbarContribution,
  ResolvedAddress,
  SidebarNavContribution,
  SlotContributionMap,
} from '@hydrahost/plugin-sdk';
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@repo/ui/components/sidebar';
import { Link, type LinkProps, useLocation, useRouter } from '@tanstack/react-router';
import { useMemo } from 'react';

import {
  followInternalNavClick,
  notifyNavPopupResult,
  openNavPopup,
  safeExternalHref,
  safeInternalPath,
} from '~/lib/nav';

import { PluginErrorBoundary } from './plugin-error-boundary';
import { usePluginRegistry } from './plugin-registry-provider';
import type { SlotRegistryEntry } from './registry';

type Props =
  | { name: 'sidebar-nav' }
  | { name: 'dashboard-widget' }
  | { name: 'public-navbar'; variant: 'desktop' | 'mobile'; onNavigate?: () => void }
  | { name: 'address-autocomplete'; onResolved: (address: ResolvedAddress) => void }
  | {
      name: 'inventory-page-extras';
      category?: string;
      userEmail?: string;
      hasListings: boolean;
      isAuthenticated: boolean;
      sessionPending?: boolean;
    }
  | { name: 'inventory-item-cta'; category?: string; userEmail?: string; device: InventoryItemCtaDevice }
  | { name: 'app-banner'; pathname: string; organizationId: string };

export function PluginSlot(props: Props) {
  const registry = usePluginRegistry();
  const entries = registry.slots.get(props.name) ?? [];

  if (props.name === 'sidebar-nav') {
    return <SidebarNavSlotRenderer entries={entries} />;
  }

  if (props.name === 'public-navbar') {
    return <PublicNavbarSlotRenderer entries={entries} variant={props.variant} onNavigate={props.onNavigate} />;
  }

  if (props.name === 'address-autocomplete') {
    const { onResolved } = props;
    return (
      <>
        {entries.map(({ pluginId, contribution }, index) => {
          const c = contribution as AddressAutocompleteContribution;
          const Component = c.component;
          return (
            <PluginErrorBoundary key={`${pluginId}:${index}`} pluginId={pluginId}>
              <Component pluginId={pluginId} onResolved={onResolved} />
            </PluginErrorBoundary>
          );
        })}
      </>
    );
  }

  if (props.name === 'inventory-page-extras') {
    const { category, userEmail, hasListings, isAuthenticated, sessionPending } = props;
    return (
      <>
        {entries.map(({ pluginId, contribution }, index) => {
          const c = contribution as InventoryPageExtrasContribution;
          const Component = c.component;
          return (
            <PluginErrorBoundary key={`${pluginId}:${index}`} pluginId={pluginId}>
              <Component
                pluginId={pluginId}
                category={category}
                userEmail={userEmail}
                hasListings={hasListings}
                isAuthenticated={isAuthenticated}
                sessionPending={sessionPending}
              />
            </PluginErrorBoundary>
          );
        })}
      </>
    );
  }

  if (props.name === 'inventory-item-cta') {
    const { category, userEmail, device } = props;
    return (
      <>
        {entries.map(({ pluginId, contribution }, index) => {
          const c = contribution as InventoryItemCtaContribution;
          const Component = c.component;
          return (
            <PluginErrorBoundary key={`${pluginId}:${index}`} pluginId={pluginId}>
              <Component pluginId={pluginId} category={category} userEmail={userEmail} device={device} />
            </PluginErrorBoundary>
          );
        })}
      </>
    );
  }

  if (props.name === 'app-banner') {
    const { pathname, organizationId } = props;
    return (
      <>
        {entries.map(({ pluginId, contribution }, index) => {
          const c = contribution as AppBannerSlotContribution;
          const Component = c.component;
          return (
            <PluginErrorBoundary key={`${pluginId}:${index}`} pluginId={pluginId}>
              <Component pathname={pathname} organizationId={organizationId} />
            </PluginErrorBoundary>
          );
        })}
      </>
    );
  }

  return (
    <>
      {entries.map(({ pluginId, contribution }, index) => {
        const c = contribution as DashboardWidgetContribution;
        const Component = c.component;
        return (
          <PluginErrorBoundary key={`${pluginId}:${index}`} pluginId={pluginId}>
            <Component pluginId={pluginId} />
          </PluginErrorBoundary>
        );
      })}
    </>
  );
}

function SidebarNavSlotRenderer({ entries }: { entries: SlotRegistryEntry[] }) {
  const location = useLocation();

  const activeTos = useMemo(() => {
    const matches = (to: string) => location.pathname === to || location.pathname.startsWith(`${to}/`);
    let maxLen = 0;
    const winners = new Set<string>();
    for (const entry of entries) {
      const c = entry.contribution as SidebarNavContribution;
      if (c.external) continue;
      const { to } = c;
      if (!matches(to)) continue;
      if (to.length > maxLen) {
        maxLen = to.length;
        winners.clear();
        winners.add(to);
      } else if (to.length === maxLen) {
        winners.add(to);
      }
    }
    return winners;
  }, [entries, location.pathname]);

  const ungrouped: { pluginId: string; contribution: SidebarNavContribution }[] = [];
  const sectionMap = new Map<
    string,
    {
      displayName: string;
      icon: SidebarNavContribution['sectionIcon'];
      entries: { pluginId: string; contribution: SidebarNavContribution }[];
    }
  >();

  for (const entry of entries) {
    const c = entry.contribution as SidebarNavContribution;
    if (c.section) {
      const key = c.section.toLowerCase();
      const existing = sectionMap.get(key);
      if (existing) {
        existing.entries.push({ pluginId: entry.pluginId, contribution: c });
        if (!existing.icon && c.sectionIcon) {
          existing.icon = c.sectionIcon;
        }
      } else {
        sectionMap.set(key, {
          displayName: c.section,
          icon: c.sectionIcon,
          entries: [{ pluginId: entry.pluginId, contribution: c }],
        });
      }
    } else {
      ungrouped.push({ pluginId: entry.pluginId, contribution: c });
    }
  }

  return (
    <>
      {ungrouped.map(({ pluginId, contribution }) => (
        <PluginErrorBoundary key={`${pluginId}:${contribution.to}`} pluginId={pluginId}>
          <SidebarNavTopLevelItem
            pluginId={pluginId}
            contribution={contribution}
            isActive={activeTos.has(contribution.to)}
          />
        </PluginErrorBoundary>
      ))}
      {[...sectionMap.values()].map(({ displayName, icon: SectionIcon, entries: sectionEntries }) => (
        <SidebarMenuItem key={displayName.toLowerCase()} className="mt-4">
          <SidebarMenuButton className="bg-sidebar-section-bg pointer-events-none font-bold">
            {SectionIcon ? <SectionIcon className="size-4 shrink-0" /> : null}
            <span>/{displayName.toUpperCase()}/</span>
          </SidebarMenuButton>
          <SidebarMenuSub>
            {sectionEntries.map(({ pluginId, contribution }) => (
              <PluginErrorBoundary key={`${pluginId}:${contribution.to}`} pluginId={pluginId}>
                <SidebarNavSubItem
                  pluginId={pluginId}
                  contribution={contribution}
                  isActive={activeTos.has(contribution.to)}
                />
              </PluginErrorBoundary>
            ))}
          </SidebarMenuSub>
        </SidebarMenuItem>
      ))}
    </>
  );
}

function SidebarNavTopLevelItem({
  pluginId,
  contribution,
  isActive,
}: {
  pluginId: string;
  contribution: SidebarNavContribution;
  isActive: boolean;
}) {
  const Icon = contribution.icon;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={contribution.label}>
        {contribution.popup && safeInternalPath(contribution.to) ? (
          <a
            href={contribution.to}
            onClick={(e) => {
              e.preventDefault();
              notifyNavPopupResult(openNavPopup(contribution.to), contribution.label);
            }}
            data-plugin-id={pluginId}
          >
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{contribution.label}</span>
          </a>
        ) : contribution.external ? (
          <a
            href={safeExternalHref(contribution.to)}
            target="_blank"
            rel="noopener noreferrer"
            data-plugin-id={pluginId}
          >
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{contribution.label}</span>
          </a>
        ) : safeInternalPath(contribution.to) ? (
          <Link to={contribution.to as LinkProps['to']} data-plugin-id={pluginId}>
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{contribution.label}</span>
          </Link>
        ) : (
          <a data-plugin-id={pluginId}>
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{contribution.label}</span>
          </a>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SidebarNavSubItem({
  pluginId,
  contribution,
  isActive,
}: {
  pluginId: string;
  contribution: SidebarNavContribution;
  isActive: boolean;
}) {
  const Icon = contribution.icon;

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={isActive}>
        {contribution.popup && safeInternalPath(contribution.to) ? (
          <a
            href={contribution.to}
            onClick={(e) => {
              e.preventDefault();
              notifyNavPopupResult(openNavPopup(contribution.to), contribution.label);
            }}
            data-plugin-id={pluginId}
          >
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{contribution.label}</span>
          </a>
        ) : contribution.external ? (
          <a
            href={safeExternalHref(contribution.to)}
            target="_blank"
            rel="noopener noreferrer"
            data-plugin-id={pluginId}
          >
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{contribution.label}</span>
          </a>
        ) : safeInternalPath(contribution.to) ? (
          <Link to={contribution.to as LinkProps['to']} data-plugin-id={pluginId}>
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{contribution.label}</span>
          </Link>
        ) : (
          <a data-plugin-id={pluginId}>
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate">{contribution.label}</span>
          </a>
        )}
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function isPublicNavbarContribution(
  contribution: SlotContributionMap[keyof SlotContributionMap],
): contribution is PublicNavbarContribution {
  return (
    'to' in contribution && 'label' in contribution && !('component' in contribution) && !('section' in contribution)
  );
}

function PublicNavbarSlotRenderer({
  entries,
  variant,
  onNavigate,
}: {
  entries: SlotRegistryEntry[];
  variant: 'desktop' | 'mobile';
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const router = useRouter();

  return (
    <>
      {entries.map((entry) => {
        if (!isPublicNavbarContribution(entry.contribution)) return null;
        const { label, to, external } = entry.contribution;
        const isCurrent = location.pathname === to || location.pathname.startsWith(`${to}/`);
        const className =
          variant === 'desktop'
            ? [
                isCurrent ? 'bg-primary/10 text-primary' : 'bg-transparent',
                'rounded-md px-3 py-2 text-sm font-semibold',
              ].join(' ')
            : [
                'block rounded-md px-3 py-2 text-base font-semibold transition-colors',
                isCurrent ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-white',
              ].join(' ');

        if (external) {
          const href = safeExternalHref(to);
          if (!href) return null;
          return (
            <a
              key={`${entry.pluginId}:${to}`}
              href={href}
              className={className}
              target="_blank"
              rel="noopener noreferrer"
              data-plugin-id={entry.pluginId}
              onClick={onNavigate}
            >
              {label}
            </a>
          );
        }

        const href = safeInternalPath(to);
        if (!href) return null;
        return (
          <a
            key={`${entry.pluginId}:${to}`}
            href={href}
            className={className}
            data-plugin-id={entry.pluginId}
            onClick={(event) => {
              followInternalNavClick(event, href, (next) => {
                onNavigate?.();
                router.history.push(next);
              });
            }}
          >
            {label}
          </a>
        );
      })}
    </>
  );
}
