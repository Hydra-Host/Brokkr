import type { Circuit } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/circuits/circuits/$circuitId')({
  staticData: { breadcrumb: (data) => (data as Circuit)?.cid ?? 'Circuit' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['circuit', params.circuitId],
      queryFn: () => tsr.getCircuit.query({ params: { id: params.circuitId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load circuit');
    return response.body;
  },
  component: CircuitLayout,
});

function CircuitLayout() {
  const { circuitId } = Route.useParams();

  const { data, isPending } = tsr.getCircuit.useQuery({
    queryKey: ['circuit', circuitId],
    queryData: { params: { id: circuitId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.cid : 'Circuit Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Circuit not found.</p>;
  }

  const circuit = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{circuit.cid}</span>
          <Badge variant="outline">{circuit.status}</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/circuits/circuits/$circuitId/edit" params={{ circuitId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/circuits/circuits/$circuitId/delete" params={{ circuitId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
