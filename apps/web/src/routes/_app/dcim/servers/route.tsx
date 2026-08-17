import { createFileRoute, Outlet, useLocation, useMatches } from '@tanstack/react-router';
import { Server } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { CommissionServersButton } from '~/components/commission-servers-button';
import { ResponsiveNavTabs } from '~/components/responsive-nav-tabs';
export const Route = createFileRoute('/_app/dcim/servers')({
  staticData: { breadcrumb: 'Servers', description: 'View and manage the physical servers in your zones' },
  component: ServersLayout,
});

function ServersLayout() {
  useDocumentTitle('Servers');

  const matches = useMatches();
  const location = useLocation();
  const isServerSubPage = matches.some((m) => m.routeId.includes('$deviceId'));

  if (isServerSubPage) {
    return <Outlet />;
  }

  const activeTab = location.pathname.endsWith('/decommissioned') ? 'decommissioned' : 'active';

  return (
    <div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              {activeTab === 'decommissioned' ? 'Decommissioned Servers' : 'Active Servers'}
            </CardTitle>
            <CardDescription>
              {activeTab === 'decommissioned'
                ? 'Servers that have been decommissioned and are no longer active.'
                : 'View and manage the physical servers in your zones.'}
            </CardDescription>
          </div>
          <CommissionServersButton className="shrink-0" />
        </CardHeader>
        <CardContent>
          <ResponsiveNavTabs
            tabs={[
              { name: 'Active Servers', href: '/dcim/servers', value: 'active' },
              { name: 'Decommissioned Servers', href: '/dcim/servers/decommissioned', value: 'decommissioned' },
            ]}
            activeValue={activeTab}
            tabsListClassName="mb-6"
          />
          <Outlet />
        </CardContent>
      </Card>
    </div>
  );
}
