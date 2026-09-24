import { ResponsiveNavTabs } from '@repo/domain-ui/components/responsive-nav-tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, Outlet, useLocation, useMatches } from '@tanstack/react-router';
import { Snowflake } from 'lucide-react';

export const Route = createFileRoute('/_app/dcim/cdus')({
  staticData: {
    breadcrumb: 'CDUs',
    description: 'View and manage the coolant distribution units in your data centers',
  },
  component: CdusLayout,
});

function CdusLayout() {
  useDocumentTitle('CDUs');

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
            <Snowflake className="h-5 w-5" />
            {activeTab === 'decommissioned' ? 'Decommissioned CDUs' : 'Active CDUs'}
          </CardTitle>
          <CardDescription>
            {activeTab === 'decommissioned'
              ? 'Coolant distribution units that have been decommissioned.'
              : 'View and manage the coolant distribution units in your data centers.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveNavTabs
            tabs={[
              { name: 'Active CDUs', href: '/dcim/cdus', value: 'active' },
              { name: 'Decommissioned CDUs', href: '/dcim/cdus/decommissioned', value: 'decommissioned' },
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
