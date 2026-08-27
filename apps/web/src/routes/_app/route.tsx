import { createFileRoute, Link, Navigate, Outlet, useLocation, useMatches, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftRight,
  BadgeCheck,
  Bookmark,
  BookOpen,
  Building,
  Building2,
  Cable,
  Check,
  ChevronsUpDown,
  Cpu,
  Database,
  EthernetPort,
  FlaskConical,
  Globe,
  KeyRound,
  Laptop,
  Layers,
  Layers3,
  List,
  ListChecks,
  Loader2,
  LogOut,
  MapPin,
  Network,
  PanelBottom,
  PanelTop,
  Plug,
  PlugZap,
  Plus,
  Puzzle,
  Rocket,
  Route as RouteIcon,
  Router,
  Rows3,
  Ruler,
  ScrollText,
  Server,
  Settings2,
  Shapes,
  SlidersHorizontal,
  Snowflake,
  SquareTerminal,
  Tag,
  Terminal,
  Unplug,
  UserCog,
  Users,
  Warehouse,
  Waypoints,
  Webhook,
  Zap,
} from 'lucide-react';
import * as React from 'react';
import { useLayoutEffect, useState } from 'react';

import { getDocsUrl } from '~/lib/runtime-config';

import type { SidebarNavContribution } from '@hydrahost/plugin-sdk';
import { signOut, useSession } from '@repo/auth/client';
import { ApiMonitorContext, BottomBar, useApiMonitorProvider } from '@repo/ui/bottom-bar';
import { Avatar, AvatarFallback } from '@repo/ui/components/avatar';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { SidebarInset, SidebarMenuButton, SidebarProvider, SidebarTrigger } from '@repo/ui/components/sidebar';
import { ThemeSelector } from '@repo/ui/theme-selector';
import { isRecord } from '@repo/utils';
import { getSectionForPathname, getVisibleLeaves, mergeNavSections, type NavSection } from '~/lib/nav';
import { AppSidebar } from './-components/app-sidebar';

import { useNavigationShortcuts } from '@repo/ui/hooks/use-navigation-shortcuts';
import { AppSearch, AppSearchProvider, AppSearchTrigger } from '~/components/app-search';
import { NotFound } from '~/components/not-found';
import { RouteError } from '~/components/route-error';
import { tsr } from '~/lib/api';
import { isLocalSimulationEnabled } from '~/lib/env';
import { getLandingRoute } from '~/lib/landing-route';
import { sanitizeRedirect } from '~/lib/safe-redirect';
import { publicRedirectFromPluginAppMount, usePluginRegistry, wrapPluginIcon } from '~/plugin-host';

export const Route = createFileRoute('/_app')({
  component: AppLayout,
  errorComponent: RouteError,
  notFoundComponent: NotFound,
});

function AppLayout() {
  const { data: session, isPending: sessionPending } = useSession();
  const location = useLocation();
  const pluginRegistry = usePluginRegistry();

  const { data: organizations, isPending: organizationsPending } = tsr.listOrganizations.useQuery({
    queryKey: ['organizations'],
    queryData: { query: { pageSize: 100 } },
  });

  const apiMonitor = useApiMonitorProvider();

  const publicPluginHref = publicRedirectFromPluginAppMount(
    location.pathname,
    location.searchStr,
    pluginRegistry.publicRoutes,
  );
  useLayoutEffect(() => {
    if (!publicPluginHref) return;
    window.location.replace(publicPluginHref);
  }, [publicPluginHref]);
  if (publicPluginHref) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (sessionPending) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!session || !session.user) {
    return <Navigate to="/auth/login" />;
  }

  if (!session.user.twoFactorEnabled && !import.meta.env.DEV && !isLocalSimulationEnabled()) {
    const redirect = sanitizeRedirect(location.pathname);
    return <Navigate to="/auth/setup-two-factor" search={redirect ? { redirect } : {}} />;
  }

  if (organizationsPending) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  const activeOrgId = (session.session as { activeOrganizationId?: string }).activeOrganizationId;
  if (organizations && (organizations.body.data.length === 0 || !activeOrgId)) {
    const redirect = sanitizeRedirect(location.pathname);
    return <Navigate to="/onboarding/organization" search={redirect ? { redirect } : {}} />;
  }

  return (
    <ApiMonitorContext.Provider value={apiMonitor}>
      <SidebarProvider className="flex h-screen overflow-hidden">
        <AppSearchProvider>
          <AppShellContent session={session} location={location} />
        </AppSearchProvider>
      </SidebarProvider>
    </ApiMonitorContext.Provider>
  );
}

interface AppShellContentProps {
  session: NonNullable<ReturnType<typeof useSession>['data']>;
  location: ReturnType<typeof useLocation>;
}

function AppShellContent({ session, location }: AppShellContentProps) {
  const navigate = useNavigate();
  const queryClient = tsr.useQueryClient();
  const { refetch: refetchSession } = useSession();

  useNavigationShortcuts();

  const savedMenuStates = React.useRef<Record<MenuStateKey, boolean> | null>(null);

  const { data: organizations } = tsr.listOrganizations.useQuery({
    queryKey: ['organizations'],
    queryData: { query: { pageSize: 100 } },
  });

  const { data: invitations } = tsr.listMyInvitations.useQuery({
    queryKey: ['my-invitations'],
    queryData: { query: { pageSize: 100 } },
  });

  const { mutateAsync: acceptInvitationMutation } = tsr.acceptMyInvitation.useMutation();
  const { mutateAsync: setActiveOrgMutation } = tsr.setActiveOrganization.useMutation();
  const { mutateAsync: rejectInvitationMutation } = tsr.rejectMyInvitation.useMutation({
    meta: { successMessage: 'Invitation declined' },
  });

  const [isSwitchingOrg, setIsSwitchingOrg] = useState(false);
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null);
  const [rejectingInvitationId, setRejectingInvitationId] = useState<string | null>(null);
  const [typewriterKey, setTypewriterKey] = useState(0);
  React.useEffect(() => {
    setTypewriterKey((k) => k + 1);
  }, [location.pathname]);

  const user = session.user as { id: string; name: string; email: string; firstName?: string; lastName?: string };
  const firstName = user.firstName || user.name?.split(' ')[0] || '';
  const lastName = user.lastName || user.name?.split(' ')[1] || '';

  const activeOrgId = (session.session as { activeOrganizationId?: string }).activeOrganizationId;

  const orgs = organizations?.body?.data;
  React.useEffect(() => {
    if (!activeOrgId && orgs && orgs.length > 0) {
      setActiveOrgMutation({ params: { id: orgs[0].id }, body: {} })
        .then(() => refetchSession())
        .catch((err) => console.error('Failed to auto-select organization:', err));
    }
  }, [activeOrgId, orgs]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeOrg = orgs?.find((o) => o.id === activeOrgId);
  const tenantType = activeOrg?.tenantType || 'DemandCustomer';
  const isSupplier = tenantType === 'SupplyCustomer';

  const handleOrgChange = async (orgId: string) => {
    if (orgId === activeOrgId) return;
    try {
      setIsSwitchingOrg(true);
      await setActiveOrgMutation({ params: { id: orgId }, body: {} });
      void refetchSession();
      queryClient.clear();
      const switchedOrg = organizations?.body?.data?.find((o) => o.id === orgId);
      navigate({ to: getLandingRoute(switchedOrg?.tenantType) });
    } catch (err) {
      console.error('Failed to switch organization:', err);
    } finally {
      setIsSwitchingOrg(false);
    }
  };

  const pendingInvitations = invitations?.status === 200 ? invitations.body.data : [];

  const handleAcceptInvitation = async (invitation: (typeof pendingInvitations)[0]) => {
    try {
      setAcceptingInvitationId(invitation.id);
      await acceptInvitationMutation({
        params: { invitationId: invitation.id },
        body: {},
      });
      await setActiveOrgMutation({ params: { id: invitation.organizationId }, body: {} });
      void refetchSession();
      queryClient.clear();
      navigate({ to: getLandingRoute() });
    } catch (err) {
      console.error('Failed to accept invitation:', err);
    } finally {
      setAcceptingInvitationId(null);
    }
  };

  const handleRejectInvitation = async (invitation: (typeof pendingInvitations)[0]) => {
    setRejectingInvitationId(invitation.id);
    try {
      await rejectInvitationMutation({
        params: { invitationId: invitation.id },
        body: {},
      });
      void queryClient.invalidateQueries({ queryKey: ['my-invitations'] });
    } finally {
      setRejectingInvitationId(null);
    }
  };

  const handleLogout = () => {
    signOut({
      fetchOptions: {
        onSuccess: () => {
          queryClient.clear();
          navigate({ to: '/auth/login' });
        },
      },
    });
  };

  type MenuStateKey =
    | 'dcim'
    | 'reservations'
    | 'rentals'
    | 'admin'
    | 'billing'
    | 'ipam'
    | 'dcimInfra'
    | 'catalog'
    | 'circuits'
    | 'bgp'
    | 'documentation'
    | 'orgSettings';

  interface NavItem {
    title: string;
    url?: string;
    icon: React.ComponentType<{ className?: string }>;
    isCollapsible?: boolean;
    stateKey?: string;
    items?: NavItem[];
    isExternal?: boolean;
    activePrefix?: string;
  }

  const [menuStates, setMenuStates] = useState<Record<MenuStateKey, boolean>>(() => ({
    dcim:
      location.pathname.startsWith('/dcim/zones') ||
      location.pathname.startsWith('/dcim/bridges') ||
      location.pathname.startsWith('/dcim/servers') ||
      location.pathname.startsWith('/dcim/switches') ||
      location.pathname.startsWith('/dcim/routers') ||
      location.pathname.startsWith('/dcim/pdus') ||
      location.pathname.startsWith('/dcim/cdus') ||
      location.pathname.startsWith('/dcim/test-runs'),
    reservations: location.pathname.startsWith('/admin/reservations/'),
    rentals:
      location.pathname.startsWith('/deployments/') ||
      location.pathname.startsWith('/rentals/') ||
      location.pathname.startsWith('/inventory/'),
    admin: location.pathname.startsWith('/admin/'),
    billing: location.pathname.startsWith('/admin/billing/'),
    ipam: location.pathname.startsWith('/ipam/'),
    dcimInfra:
      location.pathname.startsWith('/dcim/racks') ||
      location.pathname.startsWith('/dcim/interfaces') ||
      location.pathname.startsWith('/dcim/cables') ||
      location.pathname.startsWith('/dcim/console-') ||
      location.pathname.startsWith('/dcim/power-') ||
      location.pathname.startsWith('/dcim/front-') ||
      location.pathname.startsWith('/dcim/rear-'),
    catalog: location.pathname.startsWith('/device-models') || location.pathname.startsWith('/tags'),
    circuits: location.pathname.startsWith('/circuits/'),
    bgp: location.pathname.startsWith('/bgp/'),
    documentation: location.pathname.startsWith('/docs/') || location.pathname === '/docs',
    orgSettings: location.pathname.startsWith('/organizations/') || location.pathname === '/organizations',
  }));

  const platformNav: NavItem[] = [];

  if (isSupplier) {
    platformNav.push(
      {
        title: 'Zone Management',
        icon: Database,
        isCollapsible: true,
        stateKey: 'dcim',
        items: [
          { title: 'Zones', url: '/dcim/zones', icon: Warehouse },
          { title: 'Bridges', url: '/dcim/bridges', icon: Router },
          { title: 'Servers', url: '/dcim/servers', icon: Laptop },
          { title: 'Switches', url: '/dcim/switches', icon: Network },
          { title: 'Routers', url: '/dcim/routers', icon: RouteIcon },
          { title: 'PDUs', url: '/dcim/pdus', icon: Zap },
          { title: 'CDUs', url: '/dcim/cdus', icon: Snowflake },
          { title: 'Test Runs', url: '/dcim/test-runs', icon: FlaskConical },
        ],
      },
      {
        title: 'IPAM',
        icon: Globe,
        isCollapsible: true,
        stateKey: 'ipam',
        items: [
          { title: 'VRFs', url: '/ipam/vrfs', icon: RouteIcon },
          { title: 'Prefixes', url: '/ipam/prefixes', icon: Network },
          { title: 'VLANs', url: '/ipam/vlans', icon: Layers },
          { title: 'IP Addresses', url: '/ipam/ip-addresses', icon: MapPin },
          { title: 'IP Ranges', url: '/ipam/ip-ranges', icon: Ruler },
          { title: 'ASNs', url: '/ipam/asns', icon: Globe },
          { title: 'VLAN Groups', url: '/ipam/vlan-groups', icon: Layers3 },
          { title: 'Gateways', url: '/ipam/gateways', icon: Waypoints },
          { title: 'Roles', url: '/ipam/roles', icon: Bookmark },
        ],
      },
      {
        title: 'Physical Infrastructure',
        icon: Building2,
        isCollapsible: true,
        stateKey: 'dcimInfra',
        items: [
          { title: 'Racks', url: '/dcim/racks', icon: Rows3 },
          { title: 'Interfaces', url: '/dcim/interfaces', icon: EthernetPort },
          { title: 'Cables', url: '/dcim/cables', icon: Cable },
          { title: 'Console Ports', url: '/dcim/console-ports', icon: Terminal },
          { title: 'Console Server Ports', url: '/dcim/console-server-ports', icon: SquareTerminal },
          { title: 'Power Ports', url: '/dcim/power-ports', icon: Plug },
          { title: 'Power Outlets', url: '/dcim/power-outlets', icon: PlugZap },
          { title: 'Front Ports', url: '/dcim/front-ports', icon: PanelTop },
          { title: 'Rear Ports', url: '/dcim/rear-ports', icon: PanelBottom },
        ],
      },
      {
        title: 'Catalog',
        icon: Shapes,
        isCollapsible: true,
        stateKey: 'catalog',
        items: [
          { title: 'Device Models', url: '/device-models', icon: Cpu },
          { title: 'Tags', url: '/tags', icon: Tag },
        ],
      },
      {
        title: 'Circuits',
        icon: Cable,
        isCollapsible: true,
        stateKey: 'circuits',
        items: [
          { title: 'Circuits', url: '/circuits/circuits', icon: Cable },
          { title: 'Providers', url: '/circuits/providers', icon: Building },
          { title: 'Provider Networks', url: '/circuits/provider-networks', icon: Waypoints },
          { title: 'Circuit Types', url: '/circuits/circuit-types', icon: Shapes },
          { title: 'Terminations', url: '/circuits/circuit-terminations', icon: Unplug },
        ],
      },
      {
        title: 'BGP',
        icon: Network,
        isCollapsible: true,
        stateKey: 'bgp',
        items: [
          { title: 'Sessions', url: '/bgp/sessions', icon: ArrowLeftRight },
          { title: 'Peer Groups', url: '/bgp/peer-groups', icon: Users },
          { title: 'Prefix Lists', url: '/bgp/prefix-lists', icon: List },
          { title: 'Prefix List Rules', url: '/bgp/prefix-list-rules', icon: ListChecks },
        ],
      },
    );
  }

  platformNav.push({
    title: 'Rentals',
    icon: Server,
    isCollapsible: true,
    stateKey: 'rentals',
    items: [
      { title: 'Deployments', url: '/deployments', icon: Rocket },
      { title: 'Servers Available', url: '/inventory/categories', icon: Server },
    ],
  });

  platformNav.push({
    title: 'Documentation',
    icon: BookOpen,
    isCollapsible: true,
    stateKey: 'documentation',
    items: [{ title: 'Overview', url: getDocsUrl(), icon: BookOpen, isExternal: true }],
  });

  if (activeOrg) {
    platformNav.push({
      title: 'Org Settings',
      icon: Settings2,
      isCollapsible: true,
      stateKey: 'orgSettings',
      items: [
        { title: 'Members', url: '/organizations/members', icon: Users },
        { title: 'Roles', url: '/organizations/roles', icon: UserCog },
        { title: 'API Keys', url: '/organizations/api-keys', icon: KeyRound },
        { title: 'Webhooks', url: '/organizations/webhooks', icon: Webhook },
        ...(activeOrg.permissions?.includes('event-log:access')
          ? [{ title: 'Event Log', url: '/organizations/event-log', icon: ScrollText }]
          : []),
        { title: 'Settings', url: '/organizations/settings', icon: SlidersHorizontal },
      ],
    });
  }

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Meta' && !savedMenuStates.current) {
        savedMenuStates.current = { ...menuStates };
        setMenuStates({
          dcim: true,
          reservations: true,
          rentals: true,
          admin: true,
          billing: true,
          ipam: true,
          dcimInfra: true,
          catalog: true,
          circuits: true,
          bgp: true,
          documentation: true,
          orgSettings: true,
        });
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' && savedMenuStates.current) {
        setMenuStates(savedMenuStates.current);
        savedMenuStates.current = null;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [menuStates]);

  const pluginRegistry = usePluginRegistry();
  const sections: NavSection[] = mergeNavSections(
    platformNav
      .filter((item) => item.items && item.items.length > 0)
      .map((item) => ({
        title: item.title,
        icon: item.icon,
        items: item.items!.flatMap((sub) =>
          sub.items && sub.items.length > 0
            ? sub.items
                .filter((n) => n.url)
                .map((n) => ({ title: n.title, url: n.url!, icon: n.icon, external: n.isExternal }))
            : sub.url
              ? [{ title: sub.title, url: sub.url, icon: sub.icon, external: sub.isExternal }]
              : [],
        ),
      })),
    buildPluginSections(pluginRegistry.slots.get('sidebar-nav') ?? []),
  );

  return (
    <>
      <AppSidebar
        sections={sections}
        search={<AppSearchTrigger />}
        orgSwitcher={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <div className="bg-sidebar-primary text-sidebar-primary-foreground relative flex aspect-square size-8 items-center justify-center">
                  <Building2 className="size-4" />
                  {pendingInvitations.length > 0 && (
                    <span className="ring-sidebar absolute -top-1 -right-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[9px] font-bold text-white ring-2">
                      {pendingInvitations.length}
                    </span>
                  )}
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{activeOrg?.name || 'No Organization'}</span>
                  <span className="truncate text-xs">{activeOrg?.role ?? ''}</span>
                </div>
                <ChevronsUpDown className="ml-auto" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
              align="start"
              side="right"
              sideOffset={4}
            >
              <DropdownMenuLabel className="text-muted-foreground text-xs">Organizations</DropdownMenuLabel>
              {organizations?.body?.data
                ?.slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((org, index) => {
                  const isCurrentOrg = org.id === activeOrgId;
                  return (
                    <DropdownMenuItem
                      key={org.id}
                      className="gap-2 p-2"
                      disabled={isSwitchingOrg}
                      onClick={() => handleOrgChange(org.id)}
                    >
                      <div className="flex size-6 items-center justify-center rounded-md border">
                        {isCurrentOrg ? (
                          <Check className="size-3.5 shrink-0" />
                        ) : (
                          <Building2 className="size-3.5 shrink-0" />
                        )}
                      </div>
                      <span className={isCurrentOrg ? 'font-medium' : ''}>{org.name}</span>
                      <DropdownMenuShortcut>⌘{index + 1}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  );
                })}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild className="gap-2 p-2">
                <Link to="/onboarding/organization" search={{ create: true }}>
                  <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                    <Plus className="size-4" />
                  </div>
                  <div className="text-muted-foreground font-medium">Create Organization</div>
                </Link>
              </DropdownMenuItem>
              {pendingInvitations.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-muted-foreground flex items-center gap-2 text-xs">
                    Pending Invitations
                    <Badge variant="secondary" className="px-1 py-0 text-xs">
                      {pendingInvitations.length}
                    </Badge>
                  </DropdownMenuLabel>
                  {pendingInvitations.map((invitation) => {
                    const isBusy = acceptingInvitationId !== null || rejectingInvitationId !== null;
                    return (
                      <div key={invitation.id} className="px-2 py-1">
                        <div className="bg-muted/20 rounded-lg border p-2">
                          <div className="text-muted-foreground mb-2 text-xs">
                            You&apos;ve been invited to join{' '}
                            <span className="font-medium">{invitation.organizationName}</span>
                            {' as '}
                            <span className="capitalize">{invitation.role}</span>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 flex-1 text-xs"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleRejectInvitation(invitation);
                              }}
                              disabled={isBusy}
                            >
                              {rejectingInvitationId === invitation.id ? (
                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              ) : null}
                              Decline
                            </Button>
                            <Button
                              size="sm"
                              className="h-6 flex-1 text-xs"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleAcceptInvitation(invitation);
                              }}
                              disabled={isBusy}
                            >
                              {acceptingInvitationId === invitation.id ? (
                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              ) : (
                                <Check className="mr-1 h-3 w-3" />
                              )}
                              Accept
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        }
        userMenu={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Account menu"
                className="hover:bg-accent/10 flex size-8 items-center justify-center rounded-sm transition-colors"
              >
                <Avatar className="size-7">
                  <AvatarFallback className="text-xs">
                    {firstName?.[0]?.toUpperCase() || 'U'}
                    {lastName?.[0]?.toUpperCase() || 'U'}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
              side="right"
              align="end"
              sideOffset={4}
            >
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback>
                      {firstName?.[0]?.toUpperCase() || 'U'}
                      {lastName?.[0]?.toUpperCase() || 'U'}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">
                      {firstName} {lastName}
                    </span>
                    <span className="truncate text-xs">{user.email || ''}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem className="gap-2 p-2" asChild>
                  <Link to="/account/profile">
                    <BadgeCheck className="size-4" />
                    Account Settings
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 p-2" onClick={handleLogout}>
                <LogOut className="size-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <SidebarInset className="content-plus-pattern bg-bg-primary relative flex min-w-0 flex-col">
        {isSwitchingOrg && (
          <div className="bg-background/80 absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
              <span className="text-muted-foreground text-sm">Switching organization...</span>
            </div>
          </div>
        )}
        <header className="flex w-full shrink-0 items-start gap-2 bg-transparent px-4 pt-4">
          <div className="pt-[7px]">
            <SidebarTrigger />
          </div>
          <div className="min-w-0 flex-1">
            <AppBreadcrumbs sections={sections} typewriterKey={typewriterKey} />
          </div>
          <div>
            <ThemeSelector />
          </div>
        </header>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto px-4 pb-14">
            <Outlet />
          </div>
        </div>
      </SidebarInset>

      <AppSearch leaves={getVisibleLeaves(sections)} />

      <BottomBar />
    </>
  );
}

function isSidebarNavContribution(contribution: unknown): contribution is SidebarNavContribution {
  return isRecord(contribution) && typeof contribution.to === 'string' && typeof contribution.label === 'string';
}

function buildPluginSections(entries: ReadonlyArray<{ pluginId: string; contribution: unknown }>): NavSection[] {
  const bySection = new Map<string, NavSection>();
  for (const entry of entries) {
    if (!isSidebarNavContribution(entry.contribution)) continue;
    const c = entry.contribution;
    const title = c.section ?? 'Plugins';
    const key = title.toLowerCase();
    const sectionIcon = c.sectionIcon ? wrapPluginIcon(entry.pluginId, c.sectionIcon, Puzzle) : Puzzle;
    const leafIcon = c.icon ? wrapPluginIcon(entry.pluginId, c.icon, Puzzle) : Puzzle;
    let section = bySection.get(key);
    if (!section) {
      section = { title, icon: sectionIcon, items: [] };
      bySection.set(key, section);
    } else if (c.sectionIcon && section.icon === Puzzle) {
      section.icon = sectionIcon;
    }
    section.items.push({ title: c.label, url: c.to, icon: leafIcon, external: c.external, popup: c.popup });
  }
  return [...bySection.values()];
}

function nonNavSectionLabel(pathname: string): string | null {
  if (pathname.startsWith('/account')) return 'Account';
  if (pathname.startsWith('/admin/')) return 'Admin';
  if (pathname.startsWith('/rentals/')) return 'Rentals';
  return null;
}

function AppBreadcrumbs({ sections, typewriterKey }: { sections: NavSection[]; typewriterKey: number }) {
  const matches = useMatches();
  const location = useLocation();

  const crumbs = matches
    .filter((match) => match.staticData?.breadcrumb)
    .map((match) => {
      const breadcrumb = match.staticData.breadcrumb!;
      const label = typeof breadcrumb === 'function' ? breadcrumb(match.loaderData) : breadcrumb;
      return { id: match.id, label: label as string, path: match.pathname };
    });

  const lastMatchWithDesc = [...matches].reverse().find((match) => match.staticData?.description);
  let description: string | null = null;
  if (lastMatchWithDesc?.staticData?.description) {
    const desc = lastMatchWithDesc.staticData.description;
    description = typeof desc === 'function' ? (desc(lastMatchWithDesc.loaderData) as string) : desc;
  }

  const section = getSectionForPathname(sections, location.pathname)?.title ?? nonNavSectionLabel(location.pathname);

  if (crumbs.length === 0 && !section) return null;

  return (
    <BreadcrumbTypewriter
      breadcrumbs={crumbs}
      section={section}
      description={description}
      typewriterKey={typewriterKey}
    />
  );
}

function BreadcrumbTypewriter({
  breadcrumbs,
  section,
  description,
  typewriterKey,
}: {
  breadcrumbs: Array<{ id: string; label: string; path: string }>;
  section: string | null;
  description: string | null;
  typewriterKey: number;
}) {
  const allCrumbs = React.useMemo(() => {
    const result: Array<{ id: string; label: string; path: string; isSection?: boolean }> = [];
    if (section) {
      result.push({ id: '__section', label: section, path: '', isSection: true });
    }
    result.push(...breadcrumbs);
    return result;
  }, [section, breadcrumbs]);

  const fullText = allCrumbs.map((item) => `/ ${item.label}`).join(' ');

  const [count, setCount] = React.useState(0);

  React.useEffect(() => {
    setCount(0);
  }, [fullText, typewriterKey]);

  React.useEffect(() => {
    if (count < fullText.length) {
      const timer = setTimeout(() => setCount((c) => c + 1), 30);
      return () => clearTimeout(timer);
    }
  }, [count, fullText.length]);

  const segments: Array<{
    start: number;
    slashEnd: number;
    labelStart: number;
    labelEnd: number;
    item: (typeof allCrumbs)[0];
    isLast: boolean;
  }> = [];
  let pos = 0;
  allCrumbs.forEach((item, index) => {
    const isLast = index === allCrumbs.length - 1;
    const segText = `/ ${item.label}`;
    const start = pos;
    const slashEnd = start + 1;
    const labelStart = start + 2;
    const labelEnd = start + segText.length;
    segments.push({ start, slashEnd, labelStart, labelEnd, item, isLast });
    pos = labelEnd + (isLast ? 0 : 1);
  });

  const cursor = (
    <span className="bg-accent relative top-[1px] left-[2px] inline-block h-[14px] w-[7px] shadow-[0_0_4px_var(--color-accent-glow)] md:top-[2px] md:left-[3px] md:h-[20px] md:w-[9px]" />
  );

  if (allCrumbs.length === 0) return null;

  return (
    <div className="mb-2 pt-0 md:mb-4">
      <div className="flex items-center overflow-hidden font-mono text-[16px] leading-tight font-medium md:text-[24px]">
        {segments.map((seg) => {
          const slashVisible = Math.max(0, Math.min(count - seg.start, 1));
          const labelVisible = Math.max(0, Math.min(count - seg.labelStart, seg.item.label.length));
          const labelHidden = seg.item.label.length - labelVisible;

          const segRangeEnd = seg.isLast ? seg.labelEnd : seg.labelEnd + 1;
          const cursorAfterSlash = count >= seg.start + 1 && count < seg.labelStart;
          const cursorInLabel = count >= seg.labelStart && count <= segRangeEnd;

          const isSection = seg.item.isSection;

          return (
            <React.Fragment key={seg.item.id}>
              <span className="text-accent-glow mx-0.5">
                {slashVisible > 0 ? '/' : <span className="invisible">/</span>}
              </span>
              {cursorAfterSlash && cursor}
              {isSection ? (
                <span className="text-muted-foreground">
                  {seg.item.label.slice(0, labelVisible)}
                  {cursorInLabel && cursor}
                  {labelHidden > 0 && (
                    <span className="invisible" aria-hidden="true">
                      {seg.item.label.slice(labelVisible)}
                    </span>
                  )}
                </span>
              ) : !seg.isLast ? (
                <Link to={seg.item.path as string} className="text-muted-foreground hover:text-foreground">
                  {seg.item.label.slice(0, labelVisible)}
                  {cursorInLabel && cursor}
                  {labelHidden > 0 && (
                    <span className="invisible" aria-hidden="true">
                      {seg.item.label.slice(labelVisible)}
                    </span>
                  )}
                </Link>
              ) : (
                <span className="text-accent-glow">
                  {seg.item.label.slice(0, labelVisible)}
                  {cursorInLabel && cursor}
                  {labelHidden > 0 && (
                    <span className="invisible" aria-hidden="true">
                      {seg.item.label.slice(labelVisible)}
                    </span>
                  )}
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>
      {description && <p className="text-muted-foreground mt-1 truncate text-sm md:text-base">{description}</p>}
    </div>
  );
}
