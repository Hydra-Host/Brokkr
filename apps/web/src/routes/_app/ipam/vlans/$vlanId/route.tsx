import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

function statusVariant(status: string) {
  switch (status) {
    case 'ACTIVE':
      return 'default';
    case 'RESERVED':
      return 'secondary';
    case 'DEPRECATED':
      return 'destructive';
    default:
      return 'outline';
  }
}

export const Route = createFileRoute('/_app/ipam/vlans/$vlanId')({
  staticData: { breadcrumb: 'VLAN Detail' },
  component: VlanLayout,
});

function VlanLayout() {
  const { vlanId } = Route.useParams();

  const { data, isPending } = tsr.getVlan.useQuery({
    queryKey: ['vlan', vlanId],
    queryData: { params: { id: vlanId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'VLAN Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">VLAN not found.</p>;
  }

  const vlan = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{vlan.name}</span>
          <Badge variant={statusVariant(vlan.status)}>{vlan.status}</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/ipam/vlans/$vlanId/edit" params={{ vlanId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/ipam/vlans/$vlanId/delete" params={{ vlanId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
