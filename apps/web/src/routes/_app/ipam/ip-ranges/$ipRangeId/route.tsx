import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { getIpamStatusBadgeVariant } from '@repo/utils';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/ip-ranges/$ipRangeId')({
  staticData: { breadcrumb: 'IP Range Detail' },
  component: IpRangeLayout,
});

function IpRangeLayout() {
  const { ipRangeId } = Route.useParams();

  const { data, isPending } = tsr.getIpRange.useQuery({
    queryKey: ['ip-range', ipRangeId],
    queryData: { params: { id: ipRangeId } },
  });

  useDocumentTitle(data?.status === 200 ? `${data.body.start} - ${data.body.end}` : 'IP Range Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">IP range not found.</p>;
  }

  const ipRange = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-lg font-medium">
            {ipRange.start} - {ipRange.end}
          </span>
          <Badge variant={getIpamStatusBadgeVariant(ipRange.status)}>{ipRange.status}</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/ipam/ip-ranges/$ipRangeId/edit" params={{ ipRangeId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/ipam/ip-ranges/$ipRangeId/delete" params={{ ipRangeId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
