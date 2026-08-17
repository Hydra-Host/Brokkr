import type { CircuitType } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/circuits/circuit-types/$typeId')({
  staticData: { breadcrumb: (data) => (data as CircuitType)?.name ?? 'Circuit Type' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['circuit-type', params.typeId],
      queryFn: () => tsr.getCircuitType.query({ params: { id: params.typeId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load circuit type');
    return response.body;
  },
  component: CircuitTypeLayout,
});

function CircuitTypeLayout() {
  const { typeId } = Route.useParams();

  const { data, isPending } = tsr.getCircuitType.useQuery({
    queryKey: ['circuit-type', typeId],
    queryData: { params: { id: typeId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Circuit Type Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Circuit type not found.</p>;
  }

  const circuitType = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {circuitType.color && (
            <span className="inline-block h-4 w-4 rounded-full border" style={{ backgroundColor: circuitType.color }} />
          )}
          <span className="text-lg font-medium">{circuitType.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/circuits/circuit-types/$typeId/edit" params={{ typeId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/circuits/circuit-types/$typeId/delete" params={{ typeId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
