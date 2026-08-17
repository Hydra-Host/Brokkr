import type { ProviderNetwork } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/circuits/provider-networks/$networkId')({
  staticData: { breadcrumb: (data) => (data as ProviderNetwork)?.name ?? 'Provider Network' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['provider-network', params.networkId],
      queryFn: () => tsr.getProviderNetwork.query({ params: { id: params.networkId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load provider network');
    return response.body;
  },
  component: ProviderNetworkLayout,
});

function ProviderNetworkLayout() {
  const { networkId } = Route.useParams();

  const { data, isPending } = tsr.getProviderNetwork.useQuery({
    queryKey: ['provider-network', networkId],
    queryData: { params: { id: networkId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Provider Network Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Provider network not found.</p>;
  }

  const network = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{network.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/circuits/provider-networks/$networkId/edit" params={{ networkId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/circuits/provider-networks/$networkId/delete" params={{ networkId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
