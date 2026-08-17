import type { Router } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/routers/$deviceId')({
  staticData: { breadcrumb: (data) => (data as Router)?.name ?? 'Router' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['router', params.deviceId],
      queryFn: () => tsr.getRouterById.query({ params: { deviceId: params.deviceId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load router');
    return response.body;
  },
  component: RouterLayout,
});

function RouterLayout() {
  const { deviceId } = Route.useParams();

  const { data, isPending } = tsr.getRouterById.useQuery({
    queryKey: ['router', deviceId],
    queryData: { params: { deviceId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Router Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Router not found.</p>;
  }

  const rtr = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{rtr.nickname || rtr.name}</span>
          {rtr.deletedAt && <Badge variant="outline">Decommissioned</Badge>}
        </div>
        {!rtr.deletedAt && (
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/dcim/routers/$deviceId/edit" params={{ deviceId }}>
                Edit
              </Link>
            </Button>
            <Button variant="destructive" asChild>
              <Link to="/dcim/routers/$deviceId/decommission" params={{ deviceId }}>
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
