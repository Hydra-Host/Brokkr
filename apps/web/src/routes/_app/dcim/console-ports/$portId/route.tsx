import type { DcimConsolePort } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/console-ports/$portId')({
  staticData: { breadcrumb: (data) => (data as DcimConsolePort)?.name ?? 'Console Port' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['dcim-console-port', params.portId],
      queryFn: () => tsr.getDcimConsolePort.query({ params: { id: params.portId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load console port');
    return response.body;
  },
  component: ConsolePortLayout,
});

function ConsolePortLayout() {
  const { portId } = Route.useParams();

  const { data, isPending } = tsr.getDcimConsolePort.useQuery({
    queryKey: ['dcim-console-port', portId],
    queryData: { params: { id: portId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Console Port Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Console port not found.</p>;
  }

  const port = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{port.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/dcim/console-ports/$portId/edit" params={{ portId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/dcim/console-ports/$portId/delete" params={{ portId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
