import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/vrfs/$vrfId')({
  staticData: { breadcrumb: 'VRF Detail' },
  component: VrfLayout,
});

function VrfLayout() {
  const { vrfId } = Route.useParams();

  const { data, isPending } = tsr.getVrf.useQuery({
    queryKey: ['vrf', vrfId],
    queryData: { params: { id: vrfId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'VRF Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">VRF not found.</p>;
  }

  const vrf = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{vrf.name}</span>
          {vrf.rd && <span className="text-muted-foreground font-mono text-sm">RD: {vrf.rd}</span>}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/ipam/vrfs/$vrfId/edit" params={{ vrfId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/ipam/vrfs/$vrfId/delete" params={{ vrfId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
