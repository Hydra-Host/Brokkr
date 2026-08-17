import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, Outlet, useLocation, useMatches } from '@tanstack/react-router';
import { Network } from 'lucide-react';
import { ResponsiveNavTabs } from '~/components/responsive-nav-tabs';

export const Route = createFileRoute('/_app/dcim/switches')({
  staticData: {
    breadcrumb: 'Switches',
    description: 'View and manage the switches in your data centers',
  },
  component: SwitchesLayout,
});

function SwitchesLayout() {
  useDocumentTitle('Switches');

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
            <Network className="h-5 w-5" />
            {activeTab === 'decommissioned' ? 'Decommissioned Switches' : 'Active Switches'}
          </CardTitle>
          <CardDescription>
            {activeTab === 'decommissioned'
              ? 'Switches that have been decommissioned.'
              : 'View and manage the switches in your data centers.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveNavTabs
            tabs={[
              { name: 'Active Switches', href: '/dcim/switches', value: 'active' },
              { name: 'Decommissioned Switches', href: '/dcim/switches/decommissioned', value: 'decommissioned' },
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
