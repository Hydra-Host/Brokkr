import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/pdus/$deviceId/')({
  component: PduOverview,
});

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function PduOverview() {
  const { deviceId } = Route.useParams();

  const { data, isPending } = tsr.getPduById.useQuery({
    queryKey: ['pdu', deviceId],
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

  const pdu = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={pdu.name} />
          <InfoRow label="Nickname" value={pdu.nickname} />
          <InfoRow label="Status" value={pdu.status} />
          <InfoRow label="Device ID" value={<span className="font-mono text-xs">{pdu.deviceId}</span>} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Power &amp; Specs</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow
            label="Power"
            value={
              pdu.powerStatus ? (
                <Badge variant={pdu.powerStatus === 'On' ? 'default' : 'outline'}>{pdu.powerStatus}</Badge>
              ) : null
            }
          />
          <InfoRow label="Outlets" value={pdu.outletCount} />
          <InfoRow label="Rated amperage" value={pdu.ratedAmperage} />
          <InfoRow label="Voltage" value={pdu.voltageType} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Location &amp; Owner</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Data center" value={pdu.zoneName} />
          <InfoRow label="Supplier" value={pdu.supplierName} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Created" value={new Date(pdu.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(pdu.updatedAt).toLocaleDateString()} />
          <InfoRow label="Decommissioned" value={pdu.deletedAt ? new Date(pdu.deletedAt).toLocaleDateString() : null} />
        </CardContent>
      </Card>
    </div>
  );
}
