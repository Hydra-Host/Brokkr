import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/gateways/$gatewayId')({
  staticData: { breadcrumb: 'Gateway Detail' },
  component: GatewayLayout,
});

function GatewayLayout() {
  const { gatewayId } = Route.useParams();

  const { data, isPending } = tsr.getGateway.useQuery({
    queryKey: ['gateway', gatewayId],
    queryData: { params: { id: gatewayId } },
  });

  useDocumentTitle(data?.status === 200 ? `Gateway ${data.body.gatewayIp.address}` : 'Gateway Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Gateway not found.</p>;
  }

  const gateway = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">Gateway</span>
          <span className="text-muted-foreground font-mono text-sm">
            {gateway.gatewayIp.address} on {gateway.prefix.prefix}
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/ipam/gateways/$gatewayId/edit" params={{ gatewayId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/ipam/gateways/$gatewayId/delete" params={{ gatewayId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
