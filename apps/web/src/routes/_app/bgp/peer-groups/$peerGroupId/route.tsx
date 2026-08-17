import type { BgpPeerGroup } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/bgp/peer-groups/$peerGroupId')({
  staticData: { breadcrumb: (data) => (data as BgpPeerGroup)?.name ?? 'Peer Group' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['bgp-peer-group', params.peerGroupId],
      queryFn: () => tsr.getBgpPeerGroup.query({ params: { id: params.peerGroupId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load BGP peer group');
    return response.body;
  },
  component: BgpPeerGroupLayout,
});

function BgpPeerGroupLayout() {
  const { peerGroupId } = Route.useParams();

  const { data, isPending } = tsr.getBgpPeerGroup.useQuery({
    queryKey: ['bgp-peer-group', peerGroupId],
    queryData: { params: { id: peerGroupId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Peer Group Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">BGP peer group not found.</p>;
  }

  const peerGroup = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{peerGroup.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/bgp/peer-groups/$peerGroupId/edit" params={{ peerGroupId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/bgp/peer-groups/$peerGroupId/delete" params={{ peerGroupId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
