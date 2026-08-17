import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { ResponsiveNavTabs } from '~/components/responsive-nav-tabs';

export const Route = createFileRoute('/_app/organizations/webhooks')({
  staticData: { breadcrumb: 'Webhooks', description: 'Configure webhook endpoints for real-time event notifications' },
  component: WebhooksLayout,
});

function WebhooksLayout() {
  useDocumentTitle('Webhooks');
  const location = useLocation();

  const activeTab = location.pathname.endsWith('/deliveries')
    ? 'deliveries'
    : location.pathname.endsWith('/stats')
      ? 'stats'
      : 'webhooks';

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Webhooks</CardTitle>
              <CardDescription>Configure webhook endpoints to receive event notifications.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/organizations/webhooks/create">
                <Plus className="mr-2 h-4 w-4" />
                Create Webhook
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ResponsiveNavTabs
            tabs={[
              { name: 'Webhooks', href: '/organizations/webhooks', value: 'webhooks' },
              { name: 'Deliveries', href: '/organizations/webhooks/deliveries', value: 'deliveries' },
              { name: 'Stats', href: '/organizations/webhooks/stats', value: 'stats' },
            ]}
            activeValue={activeTab}
          />
          <div className="mt-4">
            <Outlet />
          </div>
        </CardContent>
      </Card>
    </>
  );
}
