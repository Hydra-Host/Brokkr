import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, Outlet, useLocation, useMatches } from '@tanstack/react-router';
import { Zap } from 'lucide-react';
import { ResponsiveNavTabs } from '~/components/responsive-nav-tabs';

export const Route = createFileRoute('/_app/dcim/pdus')({
  staticData: { breadcrumb: 'PDUs', description: 'View and manage the power distribution units in your data centers' },
  component: PdusLayout,
});

function PdusLayout() {
  useDocumentTitle('PDUs');

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
            <Zap className="h-5 w-5" />
            {activeTab === 'decommissioned' ? 'Decommissioned PDUs' : 'Active PDUs'}
          </CardTitle>
          <CardDescription>
            {activeTab === 'decommissioned'
              ? 'Power distribution units that have been decommissioned.'
              : 'View and manage the power distribution units in your data centers.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveNavTabs
            tabs={[
              { name: 'Active PDUs', href: '/dcim/pdus', value: 'active' },
              { name: 'Decommissioned PDUs', href: '/dcim/pdus/decommissioned', value: 'decommissioned' },
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
