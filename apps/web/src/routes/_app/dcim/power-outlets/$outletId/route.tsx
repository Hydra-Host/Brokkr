import type { DcimPowerOutlet } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/power-outlets/$outletId')({
  staticData: { breadcrumb: (data) => (data as DcimPowerOutlet)?.name ?? 'Power Outlet' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['dcim-power-outlet', params.outletId],
      queryFn: () => tsr.getDcimPowerOutlet.query({ params: { id: params.outletId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load power outlet');
    return response.body;
  },
  component: PowerOutletLayout,
});

function PowerOutletLayout() {
  const { outletId } = Route.useParams();

  const { data, isPending } = tsr.getDcimPowerOutlet.useQuery({
    queryKey: ['dcim-power-outlet', outletId],
    queryData: { params: { id: outletId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Power Outlet Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Power outlet not found.</p>;
  }

  const outlet = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{outlet.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/dcim/power-outlets/$outletId/edit" params={{ outletId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/dcim/power-outlets/$outletId/delete" params={{ outletId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
