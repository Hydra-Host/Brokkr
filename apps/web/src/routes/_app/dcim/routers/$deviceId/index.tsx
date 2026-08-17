import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/routers/$deviceId/')({
  component: RouterOverview,
});

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function RouterOverview() {
  const { deviceId } = Route.useParams();

  const { data, isPending } = tsr.getRouterById.useQuery({
    queryKey: ['router', deviceId],
    queryData: { params: { deviceId } },
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

  const rtr = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={rtr.name} />
          <InfoRow label="Nickname" value={rtr.nickname} />
          <InfoRow label="Status" value={rtr.status} />
          <InfoRow label="Device ID" value={<span className="font-mono text-xs">{rtr.deviceId}</span>} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Routing &amp; Specs</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow
            label="Power"
            value={
              rtr.powerStatus ? (
                <Badge variant={rtr.powerStatus === 'On' ? 'default' : 'outline'}>{rtr.powerStatus}</Badge>
              ) : null
            }
          />
          <InfoRow label="Type" value={rtr.routerType} />
          <InfoRow label="BGP ASN" value={rtr.bgpAsn} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Location &amp; Owner</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Data center" value={rtr.zoneName} />
          <InfoRow label="Supplier" value={rtr.supplierName} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Created" value={new Date(rtr.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(rtr.updatedAt).toLocaleDateString()} />
          <InfoRow label="Decommissioned" value={rtr.deletedAt ? new Date(rtr.deletedAt).toLocaleDateString() : null} />
        </CardContent>
      </Card>
    </div>
  );
}
