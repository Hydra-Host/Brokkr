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

export const Route = createFileRoute('/_app/ipam/vlans/$vlanId/')({
  component: VlanOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function VlanOverview() {
  const { vlanId } = Route.useParams();

  const { data, isPending } = tsr.getVlan.useQuery({
    queryKey: ['vlan', vlanId],
    queryData: { params: { id: vlanId } },
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

  const vlan = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="VID" value={<span className="font-mono">{vlan.vid}</span>} />
          <InfoRow label="Name" value={vlan.name} />
          <InfoRow label="Status" value={<Badge variant={statusVariant(vlan.status)}>{vlan.status}</Badge>} />
          <InfoRow label="Description" value={vlan.description} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="VRF ID" value={vlan.vrfId} />
          <InfoRow label="Created" value={new Date(vlan.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(vlan.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
