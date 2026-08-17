import type { DcimRack } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/racks/$rackId')({
  staticData: { breadcrumb: (data) => (data as DcimRack)?.name ?? 'Rack' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['dcim-rack', params.rackId],
      queryFn: () => tsr.getDcimRack.query({ params: { id: params.rackId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load rack');
    return response.body;
  },
  component: RackLayout,
});

function RackLayout() {
  const { rackId } = Route.useParams();

  const { data, isPending } = tsr.getDcimRack.useQuery({
    queryKey: ['dcim-rack', rackId],
    queryData: { params: { id: rackId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Rack Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Rack not found.</p>;
  }

  const rack = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{rack.name}</span>
          <Badge variant="outline">{rack.status}</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/dcim/racks/$rackId/edit" params={{ rackId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/dcim/racks/$rackId/delete" params={{ rackId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
