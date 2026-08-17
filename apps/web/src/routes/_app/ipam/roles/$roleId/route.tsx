import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/roles/$roleId')({
  staticData: { breadcrumb: 'Role Detail' },
  component: IpamRoleLayout,
});

function IpamRoleLayout() {
  const { roleId } = Route.useParams();

  const { data, isPending } = tsr.getIpamRole.useQuery({
    queryKey: ['ipam-role', roleId],
    queryData: { params: { id: roleId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'IPAM Role Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">IPAM role not found.</p>;
  }

  const role = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{role.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/ipam/roles/$roleId/edit" params={{ roleId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/ipam/roles/$roleId/delete" params={{ roleId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
