export interface OrganizationTab {
  name: string;
  href: string;
  permission?: { resource: string; action: string };
}

export const ORGANIZATION_TABS: OrganizationTab[] = [
  { name: 'Members', href: '/organizations/members' },
  { name: 'Roles', href: '/organizations/roles' },
  { name: 'API Keys', href: '/organizations/api-keys' },
  { name: 'Webhooks', href: '/organizations/webhooks' },
  { name: 'Event Log', href: '/organizations/event-log', permission: { resource: 'event-log', action: 'access' } },
  { name: 'Settings', href: '/organizations/settings' },
];

export function visibleOrganizationTabs(can: (resource: string, action: string) => boolean): OrganizationTab[] {
  return ORGANIZATION_TABS.filter((tab) => !tab.permission || can(tab.permission.resource, tab.permission.action));
}

export function activeOrganizationTab(pathname: string, tabs: OrganizationTab[]): OrganizationTab | undefined {
  return tabs.find((tab) => pathname === tab.href || pathname.startsWith(tab.href + '/'));
}
