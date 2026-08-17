import type { CircuitTermination } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/circuits/circuit-terminations/$terminationId')({
  staticData: {
    breadcrumb: (data) => {
      const termSide = (data as CircuitTermination)?.termSide;
      return termSide ? `Termination ${termSide}` : 'Termination';
    },
  },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['circuit-termination', params.terminationId],
      queryFn: () => tsr.getCircuitTermination.query({ params: { id: params.terminationId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load circuit termination');
    return response.body;
  },
  component: CircuitTerminationLayout,
});

function CircuitTerminationLayout() {
  const { terminationId } = Route.useParams();

  const { data, isPending } = tsr.getCircuitTermination.useQuery({
    queryKey: ['circuit-termination', terminationId],
    queryData: { params: { id: terminationId } },
  });

  useDocumentTitle(data?.status === 200 ? `Termination ${data.body.termSide}` : 'Termination Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Circuit termination not found.</p>;
  }

  const termination = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">Termination {termination.termSide}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/circuits/circuit-terminations/$terminationId/edit" params={{ terminationId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/circuits/circuit-terminations/$terminationId/delete" params={{ terminationId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
