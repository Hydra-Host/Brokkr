import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/vlan-groups/$vlanGroupId')({
  staticData: { breadcrumb: 'VLAN Group Detail' },
  component: VlanGroupLayout,
});

function VlanGroupLayout() {
  const { vlanGroupId } = Route.useParams();

  const { data, isPending } = tsr.getVlanGroup.useQuery({
    queryKey: ['vlan-group', vlanGroupId],
    queryData: { params: { id: vlanGroupId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'VLAN Group Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">VLAN group not found.</p>;
  }

  const vlanGroup = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{vlanGroup.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/ipam/vlan-groups/$vlanGroupId/edit" params={{ vlanGroupId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/ipam/vlan-groups/$vlanGroupId/delete" params={{ vlanGroupId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
