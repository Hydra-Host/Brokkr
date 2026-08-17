import type { Provider } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/circuits/providers/$providerId')({
  staticData: { breadcrumb: (data) => (data as Provider)?.name ?? 'Provider' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['provider', params.providerId],
      queryFn: () => tsr.getProvider.query({ params: { id: params.providerId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load provider');
    return response.body;
  },
  component: ProviderLayout,
});

function ProviderLayout() {
  const { providerId } = Route.useParams();

  const { data, isPending } = tsr.getProvider.useQuery({
    queryKey: ['provider', providerId],
    queryData: { params: { id: providerId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Provider Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Provider not found.</p>;
  }

  const provider = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{provider.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/circuits/providers/$providerId/edit" params={{ providerId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/circuits/providers/$providerId/delete" params={{ providerId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
