import type { PrefixList } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/bgp/prefix-lists/$prefixListId')({
  staticData: { breadcrumb: (data) => (data as PrefixList)?.name ?? 'Prefix List' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['prefix-list', params.prefixListId],
      queryFn: () => tsr.getPrefixList.query({ params: { id: params.prefixListId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load prefix list');
    return response.body;
  },
  component: PrefixListLayout,
});

function PrefixListLayout() {
  const { prefixListId } = Route.useParams();

  const { data, isPending } = tsr.getPrefixList.useQuery({
    queryKey: ['prefix-list', prefixListId],
    queryData: { params: { id: prefixListId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Prefix List Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Prefix list not found.</p>;
  }

  const prefixList = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{prefixList.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/bgp/prefix-lists/$prefixListId/edit" params={{ prefixListId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/bgp/prefix-lists/$prefixListId/delete" params={{ prefixListId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
