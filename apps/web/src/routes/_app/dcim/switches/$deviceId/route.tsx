import type { Switch } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/switches/$deviceId')({
  staticData: { breadcrumb: (data) => (data as Switch)?.name ?? 'Switch' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['switch', params.deviceId],
      queryFn: () => tsr.getSwitchById.query({ params: { deviceId: params.deviceId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load switch');
    return response.body;
  },
  component: SwitchLayout,
});

function SwitchLayout() {
  const { deviceId } = Route.useParams();

  const { data, isPending } = tsr.getSwitchById.useQuery({
    queryKey: ['switch', deviceId],
    queryData: { params: { deviceId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Switch Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Switch not found.</p>;
  }

  const sw = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{sw.nickname || sw.name}</span>
          {sw.deletedAt && <Badge variant="outline">Decommissioned</Badge>}
        </div>
        {!sw.deletedAt && (
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/dcim/switches/$deviceId/edit" params={{ deviceId }}>
                Edit
              </Link>
            </Button>
            <Button variant="destructive" asChild>
              <Link to="/dcim/switches/$deviceId/decommission" params={{ deviceId }}>
                Decommission
              </Link>
            </Button>
          </div>
        )}
      </div>
      <Outlet />
    </div>
  );
}
