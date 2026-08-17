import type { DcimRackRole } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { useIsInstanceOperator } from '~/hooks/use-is-instance-operator';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/rack-roles/$roleId')({
  staticData: { breadcrumb: (data) => (data as DcimRackRole)?.name ?? 'Rack Role' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['dcim-rack-role', params.roleId],
      queryFn: () => tsr.getDcimRackRole.query({ params: { id: params.roleId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load rack role');
    return response.body;
  },
  component: RackRoleLayout,
});

function RackRoleLayout() {
  const { roleId } = Route.useParams();
  const { isInstanceOperator } = useIsInstanceOperator();

  const { data, isPending } = tsr.getDcimRackRole.useQuery({
    queryKey: ['dcim-rack-role', roleId],
    queryData: { params: { id: roleId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Rack Role Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Rack role not found.</p>;
  }

  const role = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {role.color && (
            <span className="inline-block h-4 w-4 rounded-full border" style={{ backgroundColor: role.color }} />
          )}
          <span className="text-lg font-medium">{role.name}</span>
        </div>
        {isInstanceOperator && (
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/dcim/rack-roles/$roleId/edit" params={{ roleId }}>
                Edit
              </Link>
            </Button>
            <Button variant="destructive" asChild>
              <Link to="/dcim/rack-roles/$roleId/delete" params={{ roleId }}>
                Delete
              </Link>
            </Button>
          </div>
        )}
      </div>
      <Outlet />
    </div>
  );
}
