import type { BgpSession } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/bgp/sessions/$sessionId')({
  staticData: { breadcrumb: (data) => (data as BgpSession)?.name ?? 'Session' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['bgp-session', params.sessionId],
      queryFn: () => tsr.getBgpSession.query({ params: { id: params.sessionId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load BGP session');
    return response.body;
  },
  component: BgpSessionLayout,
});

function BgpSessionLayout() {
  const { sessionId } = Route.useParams();

  const { data, isPending } = tsr.getBgpSession.useQuery({
    queryKey: ['bgp-session', sessionId],
    queryData: { params: { id: sessionId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Session Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">BGP session not found.</p>;
  }

  const session = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">{session.name}</span>
          <Badge variant="outline">{session.status}</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/bgp/sessions/$sessionId/edit" params={{ sessionId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/bgp/sessions/$sessionId/delete" params={{ sessionId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
