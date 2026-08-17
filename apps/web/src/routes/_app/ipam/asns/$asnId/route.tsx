import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/asns/$asnId')({
  staticData: { breadcrumb: 'ASN Detail' },
  component: AsnLayout,
});

function AsnLayout() {
  const { asnId } = Route.useParams();

  const { data, isPending } = tsr.getAsn.useQuery({
    queryKey: ['asn', asnId],
    queryData: { params: { id: asnId } },
  });

  useDocumentTitle(data?.status === 200 ? `ASN ${data.body.asn}` : 'ASN Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">ASN not found.</p>;
  }

  const asn = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-lg font-medium">AS{asn.asn}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/ipam/asns/$asnId/edit" params={{ asnId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/ipam/asns/$asnId/delete" params={{ asnId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
