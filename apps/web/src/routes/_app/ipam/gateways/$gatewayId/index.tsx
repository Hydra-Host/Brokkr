import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Link, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/gateways/$gatewayId/')({
  component: GatewayOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function GatewayOverview() {
  const { gatewayId } = Route.useParams();

  const { data, isPending } = tsr.getGateway.useQuery({
    queryKey: ['gateway', gatewayId],
    queryData: { params: { id: gatewayId } },
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

  const gateway = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow
            label="Gateway IP"
            value={
              <Link
                to="/ipam/ip-addresses/$ipAddressId"
                params={{ ipAddressId: gateway.gatewayIpId }}
                className="font-mono text-sm hover:underline"
              >
                {gateway.gatewayIp.address}
              </Link>
            }
          />
          <InfoRow
            label="Prefix"
            value={
              <Link
                to="/ipam/prefixes/$prefixId"
                params={{ prefixId: gateway.prefixId }}
                className="font-mono text-sm hover:underline"
              >
                {gateway.prefix.prefix}
              </Link>
            }
          />
          <InfoRow
            label="VRF"
            value={
              gateway.vrf ? (
                <Link to="/ipam/vrfs/$vrfId" params={{ vrfId: gateway.vrf.id }} className="text-sm hover:underline">
                  {gateway.vrf.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">Global</span>
              )
            }
          />
          <InfoRow label="Routing Priority" value={gateway.routingPriority} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Created" value={new Date(gateway.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(gateway.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
