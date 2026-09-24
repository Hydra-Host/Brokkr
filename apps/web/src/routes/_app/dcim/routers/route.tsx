import { ResponsiveNavTabs } from '@repo/domain-ui/components/responsive-nav-tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, Outlet, useLocation, useMatches } from '@tanstack/react-router';
import { Route as RouteIcon } from 'lucide-react';

export const Route = createFileRoute('/_app/dcim/routers')({
  staticData: {
    breadcrumb: 'Routers',
    description: 'View and manage the routers in your data centers',
  },
  component: RoutersLayout,
});

function RoutersLayout() {
  useDocumentTitle('Routers');

  const matches = useMatches();
  const location = useLocation();
  const isDetailPage = matches.some((m) => m.routeId.includes('$deviceId'));

  if (isDetailPage) {
    return <Outlet />;
  }

  const activeTab = location.pathname.endsWith('/decommissioned') ? 'decommissioned' : 'active';

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RouteIcon className="h-5 w-5" />
            {activeTab === 'decommissioned' ? 'Decommissioned Routers' : 'Active Routers'}
          </CardTitle>
          <CardDescription>
            {activeTab === 'decommissioned'
              ? 'Routers that have been decommissioned.'
              : 'View and manage the routers in your data centers.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveNavTabs
            tabs={[
              { name: 'Active Routers', href: '/dcim/routers', value: 'active' },
              { name: 'Decommissioned Routers', href: '/dcim/routers/decommissioned', value: 'decommissioned' },
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
