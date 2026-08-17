import type { DcimInterface } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/interfaces/$interfaceId')({
  staticData: { breadcrumb: (data) => (data as DcimInterface)?.name ?? 'Interface' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['dcim-interface', params.interfaceId],
      queryFn: () => tsr.getDcimInterface.query({ params: { id: params.interfaceId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load interface');
    return response.body;
  },
  component: InterfaceLayout,
});

function InterfaceLayout() {
  const { interfaceId } = Route.useParams();

  const { data, isPending } = tsr.getDcimInterface.useQuery({
    queryKey: ['dcim-interface', interfaceId],
    queryData: { params: { id: interfaceId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Interface Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Interface not found.</p>;
  }

  const iface = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{iface.name}</span>
          <Badge variant={iface.enabled ? 'default' : 'secondary'}>{iface.enabled ? 'Enabled' : 'Disabled'}</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/dcim/interfaces/$interfaceId/edit" params={{ interfaceId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/dcim/interfaces/$interfaceId/delete" params={{ interfaceId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
