import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

function statusVariant(status: string) {
  switch (status) {
    case 'ACTIVE':
      return 'default';
    case 'RESERVED':
      return 'secondary';
    case 'DEPRECATED':
      return 'destructive';
    default:
      return 'outline';
  }
}

export const Route = createFileRoute('/_app/ipam/ip-ranges/$ipRangeId/')({
  component: IpRangeOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function IpRangeOverview() {
  const { ipRangeId } = Route.useParams();

  const { data, isPending } = tsr.getIpRange.useQuery({
    queryKey: ['ip-range', ipRangeId],
    queryData: { params: { id: ipRangeId } },
  });

  if (isPending) {
    return (
      <div className="grid gap-6 md:grid-cols-2">
        {[1, 2].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-3 pt-6">
              {[1, 2, 3].map((j) => (
                <Skeleton key={j} className="h-4 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return null;
  }

  const ipRange = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Start" value={<span className="font-mono">{ipRange.start}</span>} />
          <InfoRow label="End" value={<span className="font-mono">{ipRange.end}</span>} />
          <InfoRow label="Status" value={<Badge variant={statusVariant(ipRange.status)}>{ipRange.status}</Badge>} />
          <InfoRow label="Purpose" value={ipRange.purpose} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Prefix ID" value={ipRange.prefixId} />
          <InfoRow label="VRF ID" value={ipRange.vrfId} />
          <InfoRow label="Created" value={new Date(ipRange.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(ipRange.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
