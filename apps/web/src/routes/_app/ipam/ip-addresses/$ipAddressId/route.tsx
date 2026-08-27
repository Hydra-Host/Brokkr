import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { getIpamStatusBadgeVariant } from '@repo/utils';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/ip-addresses/$ipAddressId')({
  staticData: { breadcrumb: 'IP Address Detail' },
  component: IpAddressLayout,
});

function IpAddressLayout() {
  const { ipAddressId } = Route.useParams();

  const { data, isPending } = tsr.getIpAddress.useQuery({
    queryKey: ['ip-address', ipAddressId],
    queryData: { params: { id: ipAddressId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.address : 'IP Address Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">IP address not found.</p>;
  }

  const ipAddress = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-lg font-medium">{ipAddress.address}</span>
          <Badge variant={getIpamStatusBadgeVariant(ipAddress.status)}>{ipAddress.status}</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/ipam/ip-addresses/$ipAddressId/edit" params={{ ipAddressId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/ipam/ip-addresses/$ipAddressId/delete" params={{ ipAddressId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
