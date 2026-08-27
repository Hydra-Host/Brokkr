import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { getIpamStatusBadgeVariant } from '@repo/utils';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/ip-addresses/$ipAddressId/')({
  component: IpAddressOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function IpAddressOverview() {
  const { ipAddressId } = Route.useParams();

  const { data, isPending } = tsr.getIpAddress.useQuery({
    queryKey: ['ip-address', ipAddressId],
    queryData: { params: { id: ipAddressId } },
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

  const ipAddress = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Address" value={<span className="font-mono">{ipAddress.address}</span>} />
          <InfoRow
            label="Status"
            value={<Badge variant={getIpamStatusBadgeVariant(ipAddress.status)}>{ipAddress.status}</Badge>}
          />
          <InfoRow label="DNS Name" value={ipAddress.dnsName} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="VRF ID" value={ipAddress.vrfId} />
          <InfoRow label="Created" value={new Date(ipAddress.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(ipAddress.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
