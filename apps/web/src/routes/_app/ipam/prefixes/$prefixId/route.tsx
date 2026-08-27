import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { getIpamStatusBadgeVariant } from '@repo/utils';
import { Link, Outlet, createFileRoute, useMatch } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/prefixes/$prefixId')({
  staticData: { breadcrumb: 'Prefix Detail' },
  component: PrefixLayout,
});

function PrefixLayout() {
  const { prefixId } = Route.useParams();
  const isEditing = !!useMatch({ from: '/_app/ipam/prefixes/$prefixId/edit', shouldThrow: false });

  const { data, isPending } = tsr.getPrefix.useQuery({
    queryKey: ['prefix', prefixId],
    queryData: { params: { id: prefixId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.prefix : 'Prefix Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Prefix not found.</p>;
  }

  const prefix = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-lg font-medium">{prefix.prefix}</span>
          <Badge variant={getIpamStatusBadgeVariant(prefix.status)}>{prefix.status}</Badge>
          {prefix.isPool && <Badge variant="outline">Pool</Badge>}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to={isEditing ? '/ipam/prefixes/$prefixId' : '/ipam/prefixes/$prefixId/edit'} params={{ prefixId }}>
              {isEditing ? 'Cancel' : 'Edit'}
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/ipam/prefixes/$prefixId/delete" params={{ prefixId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
