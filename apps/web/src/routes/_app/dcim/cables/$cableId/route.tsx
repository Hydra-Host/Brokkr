import type { DcimCable } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/cables/$cableId')({
  staticData: { breadcrumb: (data) => (data as DcimCable)?.label ?? 'Cable' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['dcim-cable', params.cableId],
      queryFn: () => tsr.getDcimCable.query({ params: { id: params.cableId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load cable');
    return response.body;
  },
  component: CableLayout,
});

function CableLayout() {
  const { cableId } = Route.useParams();

  const { data, isPending } = tsr.getDcimCable.useQuery({
    queryKey: ['dcim-cable', cableId],
    queryData: { params: { id: cableId } },
  });

  useDocumentTitle(data?.status === 200 ? (data.body.label ?? 'Cable Detail') : 'Cable Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Cable not found.</p>;
  }

  const cable = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {cable.color && (
            <span className="inline-block h-4 w-4 rounded-full border" style={{ backgroundColor: cable.color }} />
          )}
          <span className="text-lg font-medium">{cable.label || 'Unnamed Cable'}</span>
          <Badge variant="outline">{cable.status}</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/dcim/cables/$cableId/edit" params={{ cableId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/dcim/cables/$cableId/delete" params={{ cableId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
